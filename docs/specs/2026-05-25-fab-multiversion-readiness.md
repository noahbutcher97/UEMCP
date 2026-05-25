# Fab multi-version readiness — validation + hardening roadmap

**Date:** 2026-05-25
**Status:** Validation findings + scoping (not an implementation plan). Follows D166 (offline parser 5.3/5.6/5.7), D167–D168 (plugin compiles + runtime-loads on 5.7 + 5.3).
**Goal:** Set UEMCP up to sell on Fab as a code plugin with broad engine-version compatibility.

## The dominant Fab constraint — the plugin-dependency rule

Fab's published rule for code plugins:

> *"Fab plugins must not rely on any plugin dependencies in order to compile, including those distributed by the same seller."*

Scope is ambiguous in the public forums (does it count engine-bundled plugins like RemoteControl/EnhancedInput, or only third-party/same-seller?) and Epic has not publicly clarified. **We do not need their clarification** — the safe, self-contained path is to assume the strict reading (any plugin compile-dep counts) and architect a dependency-free core. The compliance question is then answerable locally by building with plugin deps removed.

Source: Epic forums "Feedback on Plugin Dependency Rule in Fab Marketplace"; Fab technical-requirements + plugin-packaging docs.

## Validation findings (2026-05-25) — Fab-rule exposure is small and concentrated

UEMCP declares **5 plugin dependencies** (`UEMCP.uplugin Plugins[]`), all engine-bundled. Everything else in `UEMCP.Build.cs` (Core, CoreUObject, Engine, UnrealEd, Slate, BlueprintGraph, Kismet, GameplayTags, Json, UMG/UMGEditor, AssetRegistry, LevelEditor, ContentBrowser, Blutility) is an **engine module, not a plugin** — not rule-relevant.

Source-usage map (grep over `plugin/UEMCP/Source`):

| Plugin dep | Source files referencing it | Refactor cost |
|---|---|---|
| **RemoteControl** | **0** (only `Build.cs`) | **Free drop** — vestigial compile dep; RC is server-side HTTP:30010 (Node layer). Applied D169. |
| **GeometryScripting** | `GeometryHandlers.{cpp,h}` | Isolated to one handler pair — clean compile-time gate. |
| **EnhancedInput** | `InputAndPieHandlers.{cpp,h}` (+1 ref in `WidgetHandlers`) | Near-isolated; EnhancedInput is near-core since 5.3. |
| **PythonScriptPlugin** | `EditorUtilityHandlers.{cpp,h}` | Already `.uplugin`-`Optional` + runtime-gated; one handler. |
| **EditorScriptingUtilities** | `BlueprintHandlers`, `WidgetHandlers`, `EditorUtilityHandlers`, `LoadAssetPIESafe.h` | **Sticky** — woven into core handlers. Likely a same-behavior swap to engine-core subsystems (`UEditorAssetSubsystem`/`UEditorActorSubsystem`), which exist without the plugin. |

**Conclusion: a dependency-free core is feasible.** The core surface (actors, blueprints, widgets, editor-state, the offline layer) needs zero plugin deps. Four of five deps are well-isolated (one removable outright). The only meaningful work is migrating off `EditorScriptingUtilities`, and that is plausibly a subsystem swap rather than a rewrite.

> Lesson: the `Build.cs` comment claimed RemoteControl was "consumed directly for RC-adjacent type references (URemoteControlPreset etc)," but grep found zero usage. Header/comment claims can be aspirational — validate against the code.

## RC drop (D169) — first applied win

Dropped `RemoteControl` from `Build.cs PrivateDependencyModuleNames` (kept the `.uplugin Plugins[]` entry — the host still needs RemoteControl *enabled* for the :30010 server; it just isn't *compiled against*). The reverse of the UBT D60 rule is fine: a `.uplugin` plugin-enablement entry without a `Build.cs` module dep produces no warning. Validated by a clean (intermediates-nuked) rebuild against UE 5.7.

## Hardening roadmap (cheapest-first)

**Tier 0 — low cost, do regardless of Fab timing**
- ✅ **DONE (D170)** — Central compat header `Public/UEMCPCompat.h`: all `UE_VERSION_OLDER_THAN`/`#if ENGINE_*` behind version-neutral aliases; rule: no raw version `#if` elsewhere. Seeded from the lone `ReflectionWalker.cpp` guard. Mirrors the `HandlerCommon.h` shared-helper discipline.
- Warning audit per version — deprecation warnings are the early-warning radar for the next version's breakage (5.7 was "mostly deprecation warnings" per D167).
- `.uplugin` hygiene — clear `IsBetaVersion`, reconcile `Version`/`VersionName` (W-L marker wants lockstep).

**Tier 1 — architecture forks**
- Version-conditional `Build.cs` — gate deps by `Target.Version` and by plugin presence (handles both older engines where a module didn't exist, and the Fab dep rule, in one place).
- Dependency-free-core decision — make the 4 remaining plugin deps compile-time-optional feature modules (`WITH_UEMCP_<FEATURE>` switches) that no-op when absent. This is the largest design decision; the validation above shows it is feasible and bounded.

**Tier 2 — productize verification + packaging**
- Build-matrix script — generalize the D168 throwaway-host method into `build-all-versions` producing a pass/fail + warning compatibility matrix. Can start as a local operator script (no CI cost; the deferred self-hosted-runner topic).
- Fab packaging automation — `RunUAT BuildPlugin` per engine version → the per-version binary packages Fab distributes, each with its own `.uplugin EngineVersion`.

**Tier 3 — operational polish**
- Capability registry — generalize the Python/Geometry runtime gates into one table keyed by (engine version, plugin presence) so every tool degrades to a typed "unavailable here" error.
- Published support-window policy — pick a window (rolling last-3 vs broad) and a rebuild-on-new-engine check. **Decision deferred** (see below).

## Decisions of record

- **Fab dep-rule strategy = validate-first** (this doc) → then dependency-free core. Strict-reading assumption; resolved locally, no Epic dependency.
- **Support-window breadth = deferred.** Focus Tier-0 hardening now; commit breadth closer to a Fab submission.

## Next step

A throwaway **build spike** that wraps the four feature handlers (`Geometry`, `Input`, `Python`, and an `EditorScriptingUtilities` shim) behind `WITH_UEMCP_<FEATURE>` compile switches, then builds the core with **all plugin deps removed** — to prove the dependency-free core and produce the exact list of `EditorScriptingUtilities` call-sites needing a subsystem swap. The spike output is the spec for the refactor.

## Out of scope here
Implementation of the dependency-free-core refactor (this is validation + scoping); the offline parser (already multi-version via D166); a hosted-CI plugin build (engine-gated).
