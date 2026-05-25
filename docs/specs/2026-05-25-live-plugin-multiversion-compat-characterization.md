# Live plugin (C++) multi-version compat — characterization

**Date:** 2026-05-25
**Status:** Characterization / scoping (not an implementation plan). Companion to D166 (offline parser now does 5.3/5.6/5.7).
**Question:** What would it take to **compile + run** the UEMCP C++ editor plugin (`plugin/UEMCP/`, currently 5.6-targeted) against **UE 5.7** and **UE 5.3**?

> Note: this characterizes the surface; exact error lists require an actual `Build.bat` against each
> engine (operator/local or a self-hosted UE runner — same constraint as the deferred plugin-build CI).
> The offline parser (D166) needed no engine; the plugin does.

## Build mechanics (the easy part)

A UE plugin compiles against whatever engine builds it. **Targeting a different version needs no code
change by itself** — point `Build.bat` at the 5.7 / 5.3 engine and (optionally) set the `.uplugin`
`EngineVersion`. The real question is **code compatibility**: does the C++ compile, link, and behave
against that engine's API. So this reduces to an **API-delta** analysis.

## The asymmetry — 5.7 is forward (easier), 5.3 is backward (harder)

- **5.7 (newer than 5.6) — LOW–MODERATE risk.** The 5.6 APIs the plugin uses are recent; UE
  deprecates with grace periods, so most survive to 5.7 as warnings or minor signature changes. The
  5.7 *serialization* additions (`OS_SUB_OBJECT_SHADOW_SERIALIZATION`, `IMPORT_TYPE_HIERARCHIES`) are
  engine-internal — they affect the offline byte parser (fixed in D166), **not** the plugin's compile.
  Expected work: compile against 5.7, clear deprecation warnings + any changed signatures.

- **5.3 (older than 5.6) — MODERATE–HIGH risk.** The plugin uses 5.4/5.5/5.6 APIs that **may not exist
  in 5.3** — relocated headers, renamed methods, newer module deps, and actively-evolving subsystems.
  This is missing-symbol territory: a backward-port, not a warning sweep. Some features may be
  unavailable on 5.3 and need `#if ENGINE_*_OR_LATER` gating or graceful disablement.

## Concrete risk surface (from plugin API inventory)

Version-sensitive APIs actually used (counts from `plugin/UEMCP/Source`, 32 `.cpp` / 33 `.h`):

| API / subsystem | Uses | Backward-port (5.3) risk | Why |
|---|---|---|---|
| `GeometryScript*` (GeometryScripting libs) | 38 | **High** | Geometry Scripting is actively developed; 5.3's API surface differs materially from 5.6 |
| `UEditorUtility*` (Blutility) | 9 | Moderate | Editor-utility/Blutility APIs evolved across 5.3→5.6 |
| `OnObjectPreSave` (save-hook) | 7 | Moderate | `OnObjectPreSave` vs deprecated `OnObjectSaved` — availability/signature varies by version |
| `UUserDefinedStruct` | 6 | Moderate | D78: relocated Engine→CoreUObject/StructUtils in 5.6-era; 5.3 location/module differs |
| `IPythonScriptPlugin` | 6 | Low–Moderate | Stable-ish, but `FPythonCommandEx` fields drift |
| `FContentBrowserMenuExtender_SelectedAssets` | 5 | Moderate | Extender handle API (`Extenders.Last().GetHandle()`) changed across versions |
| `FObjectThumbnail` / `RenderThumbnail` / `AccessCompressedImageData` / `CompressImageData` | 13 | Moderate | D78: `AccessCompressedImageData` (not `GetCompressedImageData`); rename boundary is a version line |
| `FUObjectToken` | 3 | Low | D78: moved to `Misc/UObjectToken.h` |
| `RequestEndPlayMap` (PIE) | 2 | Low | Engine-internal async; signature stable |

The D78 episode (3 UE-5.6 API drifts patched: `UUserDefinedStruct` move, `FObjectThumbnail` header,
`AccessCompressedImageData` rename) is the template for the *kind* of churn each version boundary
brings — and confirms these specific APIs sit on version fault lines.

### Engine-header spot-checks (5.3 vs 5.6 vs 5.7) — source-confirmed against installed engines

- **`StructUtils` module: ABSENT in 5.3, PRESENT in 5.6 + 5.7.** Concrete 5.3 **backward-break**:
  code depending on the 5.6-era `StructUtils` relocation (e.g. `UUserDefinedStruct`) won't compile
  on 5.3 — the module doesn't exist there. A 5.3 backport must use the pre-relocation include/module
  or `#if`-guard the usage.
- **`AccessCompressedImageData` (FObjectThumbnail): present in 5.3 AND 5.6 + 5.7.** **Not** a 5.3
  break — the thumbnail-compress API the plugin uses exists in 5.3 (assumption corrected by
  evidence; the D78 churn was a 5.6-side detail 5.3 predates without losing the method).

These two illustrate the method and the payoff of checking rather than assuming: one "risky" API
(`AccessCompressedImageData`) is fine on 5.3; another (`StructUtils`) is a hard blocker. The
remaining version-sensitive APIs in the table above should each be checked the same way, and an
actual compile enumerates whatever the header checks miss.

## Effort estimate + recommendation

- **5.7 first** (lower risk; aligns with the offline parser already supporting 5.7). Likely a
  small–moderate fix-up pass: build against 5.7, resolve deprecation warnings + a handful of
  signature changes. Verifiable only by a real build.
- **5.3 second** (larger, separate). A backward-port: replace/guard 5.4–5.6-only APIs with 5.3
  equivalents, with possible feature-gating (e.g. geometry/thumbnail/Blutility paths) where 5.3
  lacks the surface. Some tools may be `requires_editor`-gated off on 5.3.
- **Both need an actual per-version compile** to enumerate real errors — that's the concrete next
  step (operator runs `Build.bat YourProjectEditor` against each engine; the error list scopes the
  fix). Cannot run in hosted CI (no engine), same wall as the deferred self-hosted plugin-build.

## Out of scope here
Implementation (this is scoping); the offline parser (already 5.3/5.6/5.7 via D166); a hosted-CI
plugin build (engine-gated).
