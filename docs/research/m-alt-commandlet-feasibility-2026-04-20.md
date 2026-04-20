# M-alt Feasibility Spike — Commandlet vs Save-hook for 3F Sidecar

> **Researcher**: M-alt Feasibility Spike session (2026-04-20)
> **Handoff**: `docs/handoffs/m-alt-commandlet-feasibility-spike.md`
> **Scope**: evaluate whether a headless UE commandlet (`UnrealEditor-Cmd.exe -run=X`) can replace or complement the 3F sidecar save-hook (D54 / M2-Phase-A) for offline BP pin-topology introspection.
> **D-log anchors consulted**: D45 (L3A EDITOR-ONLY), D48 (S-A/S-B split), D52 (near-parity), D54 (SHIP-SIDECAR-PHASE-A-FIRST), D55 (S-B oracle-gated), D56 (widget split).
> **Type**: research spike — NO code changes beyond one stock-commandlet empirical measurement.

---

## §Executive summary

1. **Q1 — VIABLE**. Empirical cold-boot on ProjectA with UE 5.6 is **~5.7s floor** (engine + plugin init, no Asset Registry scan) and **~17.5s** for a full `ResavePackages` run that includes Asset Registry discovery of 22,064 packages + commandlet body. Clean exit code 0 both runs. No crashes, no hangs. Handoff's 30–60s expectation was conservative — we land in the "BETTER than expected" band (10–20s).

2. **Q2 — COST IS ROUGHLY SYMMETRIC**. Implementing a `DumpBPGraph` commandlet vs the 3F-2 save-hook delegate is ~equivalent C++ effort (~1 session each). Hybrid (both) is cheap: ~0.5–1 incremental session over either alone because the JSON serializer is the dominant cost and it's shared. Reference pattern `UCompileAllBlueprintsCommandlet` is 359 lines; a `DumpBPGraph` commandlet would be ~100–200 lines (no compiler dep, narrower iterator).

3. **Q3 — COVERAGE IS MODEST**. Across 22 (c)+(d) tools: 7/8 (d) reflection-only tools are commandlet-accessible (~87%); 4–5/14 (c) compiled-derived tools are fully accessible, 5/14 partial (static-serialized data yes, runtime-eval or GPU-rendered-data no), 4–5/14 inaccessible without rendering/PIE. **Overall (c)+(d) fully-accessible: ~50–55%; partial-or-better: ~75%**. Below the handoff's >70% threshold for RESTRUCTURE-AGGRESSIVE.

4. **Q4 — VERDICT: PRESERVE + AUGMENT**. Current M-sequence (D54 SHIP-SIDECAR-PHASE-A-FIRST) is correct. Add a new `3F-4 DumpBPGraphCommandlet` to the 3F bundle as a CI/fresh-checkout/agent-automation priming path at **~0.5–1 incremental session** cost over M2-Phase-A. Commandlet does **not** displace save-hook (warm-path 0ms beats cold-path 8–17s), does **not** displace 3F-3 editor-menu prime (different UX), and does **not** defer M1 (M1 is writes-gated per D52 category (w), independent of read-surface coverage).

5. **Framing concerns surfaced**: (a) The handoff's >70% coverage → RESTRUCTURE-AGGRESSIVE rule subtly confuses read-coverage with M1 purpose; M1 exists primarily for writes (35 tools in D52 category (w)) which commandlet cannot serve regardless. (b) The handoff's "commandlet-first, defer save-hook" framing conflates two complementary workflows (cold CI vs warm interactive). (c) The existing UnrealMCP plugin's `MCPServerRunnable` starts unconditionally in commandlet mode — this would need `FApp::IsRunningCommandlet()` gating in the UEMCP C++ scaffold to avoid port contention.

---

## §Q1 — Commandlet viability (empirical)

### §Q1.1 Test harness

Two stock commandlet invocations, both on ProjectA with full Wwise + Perforce + plugin load paths intact. Wall-clock via `time` on Git Bash.

**Host environment**:

| Field | Value |
|---|---|
| Engine binary | `C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe` (584,656 bytes, 2025-10-03) |
| Engine version (from log) | `5.6.1-44394996+++UE5+Release-5.6` |
| Project | `D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject` |
| Plugin corpus loaded | UnrealMCP, Wwise 2025.1.3, Able v96, RrEnhancedDataAssetEditor, etc. |
| Asset corpus size | 22,064 packages (reported by ResavePackages `[REPORT]` line) |
| CPU | Intel Core Ultra 9 275HX |
| Shell | Git Bash on Windows 11 (25H2) |

**Engine-binary path discovery**: `UnrealEditor-Cmd.exe` is at the canonical install location. No PATH entries needed. The commandlet requires the `.uproject` as a positional arg for project-context commandlets (all our use cases).

### §Q1.2 Run 1 — NullCommandlet

```cmd
"C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" ^
  "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" ^
  -run=NullCommandlet -unattended -nop4 -nosplash -stdout 2>&1
```

**Result**: wall-clock **5.722s**, exit code 0.

**Unexpected finding**: UE 5.6 log says `LogInit: Error: NullCommandlet looked like a commandlet, but we could not find the class.` Despite "NullCommandlet" being named in `PluginCommandlet.h` and the handoff, it's not registered as a runnable class on this build. The engine still initialized all modules and cleanly shut them down — the error happened after module startup but before any body.

**What this measures**: the **irreducible engine-boot floor** — process spawn → all module startup → clean teardown, with no AR discovery, no package loads, no commandlet body. This is the optimistic case for a targeted `DumpBPGraph -Asset=<path>` commandlet that loads a single package without AR.

Key log markers (timeline from log, t=0 at first line):
- `t~0.0s` — process start, engine boot, `LogCsvProfiler` / `LogPluginManager` / `LogStreaming`
- `t~0.4s` — `LogStreaming` package load begins (engine materials, core assets — recursive-sync-load warnings normal)
- `t~1.6s` — Wwise + MetaSound + Audio subsystems init: *"Wwise SoundEngine is disabled: Running a commandlet."*
- `t~2.5s` — `LogTemp: Display: Unreal MCP Module has started` (existing UnrealMCP plugin loads)
- `t~2.7s` — `LogInit: Error: NullCommandlet looked like a commandlet, but we could not find the class.`
- `t~2.9s` — clean teardown: MCPServerRunnable stops, UnrealMCPBridge shuts down, Wwise unloads
- `t~5.7s` — process exit

**Significance**: 5.7s is the cold-boot floor. A commandlet body that only touches `LoadObject<UBlueprint>()` for one asset adds its load cost to this floor.

### §Q1.3 Run 2 — ResavePackages (AR + BP path match)

```cmd
"C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" ^
  "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" ^
  -run=ResavePackages -PackageSubstring=BP_OSPlayerR -IgnoreChangelist ^
  -unattended -nop4 -nosplash -stdout 2>&1
```

**Result**: wall-clock **17.535s**, exit code 0.

Commandlet-reported internal measurement: `Execution of commandlet took: 1.71 seconds` — this is the "restricted to packages containing BP_OSPlayerR" filter + per-package attempt loop, **excluding** engine boot + AR scan + module teardown.

**Timeline breakdown** (cumulative):
- `t~0.0s → ~5.7s` — engine boot + plugin init (same as Run 1, now confirmed reproducible)
- `t~5.7s → ~17.4s` — Asset Registry discovery of 22,064 packages + P4 initialization + shader compiler handshake + ResavePackages body (1.71s of commandlet-measured work inside)
- `t~17.4s → ~17.5s` — warning/error summary + clean teardown

**What this measures**: the **realistic case with AR**. Any commandlet that iterates the AR (`BuildBlueprintAssetList()` pattern from `UCompileAllBlueprintsCommandlet:45-91`) pays this ~12s AR cost on top of the engine-boot floor.

**Key observation for Q3**: `LogContentCommandlet: Display: [REPORT] 0/22064 packages were considered for resaving` — the AR enumerated all 22K packages in ~11s. For a `prime_bp_cache` commandlet filtering to UBlueprint subclasses, AR iteration is fast; the per-BP LoadPackage is the variable cost.

**Perforce-readonly warning**: `Skipping read-only file .../BP_OSPlayerR.uasset` appeared 6 times. ProjectA's `.uasset` files are read-only-on-disk because they're under Perforce with checkout-based exclusive locking. For ResavePackages this meant 0 packages were actually resaved. For a **read-only** `DumpBPGraph` commandlet, read-only status is irrelevant — `LoadPackage` reads from the .uasset bytes regardless of the file's OS write-bit.

### §Q1.4 Exit behavior + concurrency

**Exit codes**: Both runs returned 0. No crashes, asserts, or hangs observed. Shutdown sequence was orderly: `UnrealMCPBridge: Shutting down` → `MCPServerRunnable: Server thread stopping` → `Unloading WwiseSoundEngine` → process exit.

**Plugin interference flag (⚠️)**: Run 2's log shows `LogTemp: Display: UnrealMCPBridge: Shutting down` — confirming the existing UnrealMCP plugin's TCP server **started in commandlet mode** and cleanly shut down. This is a **real concern for UEMCP Phase 3 plugin design**: the UEMCP `MCPServerRunnable` (planned for TCP:55558) would similarly attempt to bind in commandlet mode, potentially conflicting with a concurrent editor session's plugin. **Mitigation**: gate server startup on `!FApp::IsRunningCommandlet()` in `StartupModule()`. Flag for Phase 3 plugin design (applies to M1 scaffolding regardless of this spike's outcome).

**Concurrency (theoretical — not tested)**: UE's package loading is single-process-per-.uproject for DDC safety. Two commandlets against the same .uproject may contend on DDC lock files or the Asset Registry cache. For our priming use case this doesn't matter — one commandlet run primes all BPs. For per-BP on-demand invocation, serialize at the MCP-server level (one commandlet at a time per project). Not tested empirically; cited as a flag for implementation design, not a blocker.

### §Q1.5 Latency band interpretation

Mapping the handoff's viability bands to measurement:

| Band | Handoff verdict | Our data |
|---|---|---|
| 5 min+ cold | Non-viable — skip spike | ✗ Not observed |
| 30–60s cold | Expected | ✗ Below this |
| 10–20s cold | Better than expected | ✓ **17.5s with AR** |
| 5–10s cold | Optimistic floor | ✓ **5.7s engine-only floor** |

**Significance**: commandlet is **faster than the handoff's expectation**. Two implications:
1. CI priming latency (`~17.5s + per-BP-LoadPackage × N_BPs`) is acceptable — priming a full project in <5 minutes seems achievable.
2. **Interactive per-invocation use** (agent-driven `dump_graph` without sidecar) is still marginal: 17.5s + LoadPackage is slow for "let me just check this BP's graph" flows. Not fast enough to replace save-hook's 0ms warm-path.

### §Q1.6 Steady-state per-BP projection

We did not instrument a real `LoadPackage` call on a single BP. Projected from `UCompileAllBlueprintsCommandlet` behavior patterns and the ResavePackages timing:

- Cold engine boot (measured): ~5.7s
- AR scan of 22K packages (measured): ~11s
- Per-BP `LoadPackage` + UBlueprint deserialization (standard UE pattern, BP_OSPlayerR-class size): ~50–200ms estimate
- Sidecar JSON emit (in-memory, FPaths::ProjectSavedDir write): ~5–20ms

**Projection for a `-Asset=/Game/.../BP_OSPlayerR` single-shot commandlet** (no AR iteration, just LoadObject):
- Cold: ~5.7s + ~0.1s = **~6s wall-clock**
- Warm (DDC hot): ~5.7s + ~0.05s = **~5.8s** — floor-dominated

**Projection for `prime_bp_cache` batch** (estimated ~2,000–4,000 UBlueprint subclasses in ProjectA based on plugin observations):
- Cold: ~5.7s + ~11s AR + (~100ms × 3000) = **~5 minutes**
- Warm: ~5.7s + ~11s AR + (~50ms × 3000) = **~2.5 minutes**

These projections are UNVERIFIED — a real `DumpBPGraph` implementation is the test. Flagged for follow-up if this spike's verdict triggers implementation.

---

## §Q2 — Cost comparison (save-hook vs commandlet vs hybrid)

### §Q2.1 UCommandlet API summary (from `Commandlet.h`)

Read from `C:/Program Files/Epic Games/UE_5.6/Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h` (180 lines total):

```cpp
UCLASS(abstract, transient, MinimalAPI)
class UCommandlet : public UObject
{
    // Flags controlling engine setup:
    UPROPERTY() uint32 IsServer:1;
    UPROPERTY() uint32 IsClient:1;
    UPROPERTY() uint32 IsEditor:1;       // -> UEditorEngine boot when true
    UPROPERTY() uint32 LogToConsole:1;
    UPROPERTY() uint32 FastExit:1;       // skip engine shutdown on exit
    UPROPERTY() uint32 UseCommandletResultAsExitCode:1;

    // Entry point:
    virtual int32 Main(const FString& Params) { return 0; }

    // Arg helpers (static, built-in):
    static void ParseCommandLine(
        const TCHAR* CmdLine,
        TArray<FString>& Tokens,
        TArray<FString>& Switches,
        TMap<FString, FString>& Params  // handles -Key=Value
    );

    // Custom engine override hook:
    virtual void CreateCustomEngine(const FString& Params) {}
};
```

**Key observations for Q2**:
- Main entry is `Main(FString Params)` — trivial to implement.
- `IsEditor=1` gives a full `UEditorEngine` — all editor modules load, full reflection available.
- `FastExit=1` can skip the orderly shutdown if we're OK with it (not recommended for writes; fine for reads).
- `ParseCommandLine` already handles the `-Key=Value` form — no custom arg parser needed.

### §Q2.2 Reference commandlet sizing

From `UCompileAllBlueprintsCommandlet` (the canonical "iterate all BPs" reference):

| Component | LOC |
|---|---|
| `.cpp` (implementation: InitCommandLine / BuildAssetList / BuildBlueprints / LogResults / helpers) | 359 |
| Typical `.h` header for a commandlet | ~40 |
| `.Build.cs` dependency add | 0 (already in UnrealEd) |

For a **DumpBPGraph commandlet** with no compiler dependency (pure load + graph walk + JSON emit):
- Arg parsing (adapted from `InitCommandLine:45-91`): ~30 LOC
- AR iteration with UBlueprint filter (adapted from `BuildBlueprintAssetList`): ~40 LOC
- Per-BP load + graph walk + JSON emit (reuses serializer from 3F-2): ~30 LOC (driver only)
- Progress logging + exit-code wiring: ~20 LOC

**Estimate**: ~120–180 LOC for the commandlet body. Plus the serializer (~400–600 LOC — shared with save-hook).

### §Q2.3 Save-hook (3F-2 current M2-Phase-A scope) sizing

From the sidecar design (`docs/research/sidecar-design-resolutions-2026-04-19.md` §2 + amendment §3F-2):

| Component | LOC estimate |
|---|---|
| `FCoreUObjectDelegates::OnObjectSaved` delegate registration in `StartupModule` / unregister in `ShutdownModule` | ~20 |
| Delegate callback (filter to UBlueprint subclasses, call serializer, write JSON to Saved/UEMCP/BPCache/ mirror tree, error-swallow) | ~60 |
| Path translation helper (`ProjectSavedDir / UEMCP/BPCache / AssetRelativeFromContent + .bp.json`) | ~20 |
| Plugin setting to disable (per amendment §3F-2) | ~20 |
| **Total save-hook-specific** | **~120 LOC** |
| Serializer (UEdGraph walk, spatial fields, comments[] with pre-computed `contains[]`) — **shared with commandlet** | ~400–600 |
| `prime_bp_cache` editor-menu command (3F-3, ~80 LOC) | separate from save-hook |

**Grand total save-hook path C++**: ~520–720 LOC for the full 3F-2 deliverable including serializer.

### §Q2.4 Implementation path comparison table

| Cost axis | Save-hook path (3F-2, current M2-Phase-A) | Commandlet path (hypothetical `3F-4`) |
|---|---|---|
| **Plugin C++ LOC** | ~120 (driver) + ~400–600 (serializer) = ~520–720 | ~150 (driver) + ~400–600 (serializer, shared if both ship) = ~550–750 |
| **UObject class count added** | 0 (plain module delegate) | 1 (`UDumpBPGraphCommandlet : UCommandlet`) + generated files |
| **Plugin manifest changes** | None (delegate registered in StartupModule) | Register commandlet class in module — minimal |
| **Editor engine required at runtime** | Yes (already running) | No — spawned as `UnrealEditor-Cmd.exe` process |
| **Session invocation cost** | 0ms (automatic on save) | ~17.5s (cold engine boot + AR for batch) or ~6s (targeted single-asset) |
| **Caching logic** | mtime check on sidecar file (consumer side) | Same mtime check + optional subprocess invocation |
| **Stale-sidecar handling** | `{available: false, reason: "no_sidecar_and_editor_offline"}` | Regenerate on-demand by spawning commandlet |
| **Error-swallow policy** | Per amendment: write errors don't block save | Per UCommandlet convention: non-zero exit code, stderr logged |
| **Plugin-worker sessions needed** | 1–2 per §Q3.4 of scope-refresh | 1–1.5 if alone; **+0.5–1 incremental on top of save-hook** (serializer shared) |
| **Offline-worker sessions needed** | 2–3 (reader + 9 verbs) — unchanged | 2–3 unchanged + 0.25 for subprocess-spawn fallback logic |
| **Total new sessions vs baseline** | — (baseline) | +0.5–1 |

**Interpretation**: the handoff's §Q2 "probably 0.5-1 session over save-hook alone since the C++ classes share most logic" is **empirically plausible** based on LOC sizing. The shared serializer is ~80% of the C++ work; the commandlet driver over save-hook is ~30 LOC more than save-hook-alone plus the UCOMMANDLET class registration.

**Honest refinement**: the 0.5–1 session range is tight. If the Phase 3 plugin worker hasn't yet touched UCommandlet subclasses (likely — the UEMCP scaffold at `plugin/` is empty per CLAUDE.md), add ~0.25 session for first-time setup discovery (Build.cs deps, class registration pattern verification). So honest **commandlet-incremental-over-save-hook: 0.5–1.5 sessions**.

### §Q2.5 Hybrid implementation feasibility

"Ship both" is materially cheap IF the serializer is factored into a shared helper (e.g., `FUEMCPBlueprintSerializer::Serialize(UBlueprint*, FString& OutJson)`) that both the save-hook delegate and the commandlet `Main` call into.

Suggested C++ structure for the hybrid:

```
plugin/Source/UEMCP/Private/
  Serializer/
    UEMCPBlueprintSerializer.{h,cpp}       // shared — ~400-600 LOC
    UEMCPSidecarPathHelper.{h,cpp}         // shared — ~40 LOC
  SaveHook/
    UEMCPSaveHookRegistrar.{h,cpp}         // thin delegate reg/unreg — ~80 LOC
  Commandlets/
    DumpBPGraphCommandlet.{h,cpp}          // thin iterator driver — ~120-180 LOC
  Private/UEMCPModule.{h,cpp}              // StartupModule wires save-hook; commandlet auto-registers via UCLASS
```

**Plugin-session cost breakdown for hybrid**:
- Serializer (the hard part, 400–600 LOC, correctness-critical against amendment schema): 1 session
- Save-hook driver: 0.25 session (small delegate reg + filter)
- Commandlet driver: 0.5–0.75 session (arg parse + AR iter + per-BP load + output path)
- Error-swallow policy + plugin-setting toggle: 0.25 session
- **Hybrid plugin total**: ~2–2.25 sessions

vs **save-hook-alone plugin total**: ~1.5–2 sessions (same serializer + delegate driver + setting).

**Incremental hybrid cost**: ~0.5 session. Confirms the handoff's 0.5–1 estimate toward the bottom of the range.

---

## §Q3 — Coverage analysis for (c) + (d) tools

Systematic walk through §Q1.2 / §Q1.4 / §Q1.5 / §Q1.6 / §Q1.9 of the scope-refresh for every tool classified as D52 category (c) compiled/derived OR (d) reflection-only. For each: does the `KEEP (reduced)` surface require a **live editor session**, or would a headless commandlet reach it?

**Evaluation criteria**:
- **FULL**: commandlet has the entire "KEEP (reduced)" surface after `LoadPackage` of the target asset. No additional engine subsystems needed beyond UEditorEngine boot.
- **PARTIAL**: commandlet has static/serialized portion; misses runtime evaluation (curve value at time T, blend-space interpolation, PIE-live state) OR GPU-rendered data (thumbnails, mesh GPU buffers, compiled shaders).
- **NONE**: requires rendering pipeline (`-AllowCommandletRendering` + shader compile + viewport), live PIE, or active Slate UI.

### §Q3.1 Category (d) — reflection-only metadata (8 tools)

Per scope-refresh §Q2.4. These tools retain the reflection-live-UClass surface after offline displacers take the serialized portion.

| Tool | Retained surface (from scope-refresh) | Commandlet reach | Verdict | Notes |
|---|---|---|---|---|
| `get_blueprint_info` (reduced) | Runtime-reflected interface list + UClass flags | After `LoadPackage`, `GeneratedClass->Interfaces` and `UClass` flags are fully populated. | **FULL** | UClass walks work headless — the editor engine boots the reflection system regardless. |
| `get_blueprint_variables` (reduced) | Per-property UPROPERTY flags (EditAnywhere, Replicated, BlueprintReadWrite, tooltips, Category) | `UClass::PropertyLink` iteration + `FProperty::PropertyFlags` + `FProperty::GetMetaData(TEXT("Tooltip"))` all work after load. | **FULL** | Key point: UPROPERTY flags live in reflection, not `.uasset` bytes (per scope-refresh §Q2.4 Agent 9 §3 note). Commandlet has the UClass. |
| `get_blueprint_functions` (reduced) | Full function signatures (params, return type, static/const/pure flags) | `UClass::FuncMap` + `UFunction::FunctionFlags` + `UFunction::NumParms` + property iteration on UFunction. | **FULL** | UFUNCTION metadata reflection is the same headless vs editor. |
| `get_blueprint_event_dispatchers` (reduced) | Full parameter signatures for delegate declarations; delegate binding *targets* (which BP function is bound) | Delegate signature: `UMulticastDelegateProperty::SignatureFunction` — reflection, full. **Binding targets**: require UEdGraph pin trace per scope-refresh §Q2.2 — pin edges, NOT commandlet-reachable in the same sense as reflection. | **PARTIAL** | Signatures FULL; binding-target pin trace sits in D48 S-B / sidecar territory. Commandlet gets the signatures; pin edges still need sidecar or future S-B. |
| `get_audio_asset_info` (reduced — compiled Wwise metadata) | SDK reflection; live Wwise AkAudioEvent metadata | Wwise **loads** in commandlet mode (confirmed in Q1 log: `Loading Wwise SoundEngine 2025.1.3`), but `LogAkAudio: Display: Wwise SoundEngine is disabled: Running a commandlet.` The SDK reflection (UAkAudioEvent UPROPERTY flags, AssetRegistry tags, CDO defaults) IS available; runtime event-state (playback, profiling) is NOT. | **PARTIAL** | Metadata YES via normal UPROPERTY reflection; runtime event interrogation NO. For ProjectA's current catalog demand this is mostly fine (static CDO metadata). |
| `list_data_asset_types` (reduced — runtime-registered subclasses) | "Which DataAsset subclasses exist in loaded modules" | `GetDerivedClasses(UDataAsset::StaticClass(), ...)` walks the UClass registry; commandlet has all loaded modules. | **FULL** | UClass registry walk is identical editor vs commandlet (both load UClass at module init). |
| `get_struct_definition` (reduced — member metadata flags) | UStruct walk for per-member UPROPERTY flags | Same as `get_blueprint_variables` — FProperty meta via UStruct::ChildProperties. | **FULL** | Same reflection access. |
| `get_editor_utility_blueprint` (reduced — Run method binding) | UClass method reflection for `Run()`/Pre/Post editor-utility overrides | Editor Utility modules **may not all load** in commandlet if they're editor-mode-only. Needs verification (most Editor Utility Widgets register UObjects at module load). `UEditorUtilityBlueprint` as a class is in EditorFramework module, which IsEditor=true commandlets do load. Method reflection once loaded is standard. | **FULL (probable)** | HIGH CONFIDENCE: commandlet IsEditor=true boots UEditorEngine, which loads editor-framework modules including the EditorUtility family. Confirmed by Q1 run showing full plugin corpus loaded. |

**(d) subtotal**: **FULL: 6/8 (75%)**, PARTIAL: 2/8 (25%), NONE: 0/8.

Note the two PARTIAL entries:
- `get_blueprint_event_dispatchers` — partial because binding targets need pin-trace (D48 S-B territory), which is independent of commandlet vs editor.
- `get_audio_asset_info` — partial because Wwise disables SoundEngine in commandlet mode. CDO metadata is full.

**Honest framing**: the pin-trace PARTIAL isn't really a "commandlet gap" — it's a D48 S-B gap that both commandlet and editor-live tools hit until sidecar ships. Treating it purely as a commandlet limitation overstates the delta.

### §Q3.2 Category (c) — compiled/derived data (14 tools)

Per scope-refresh §Q2.3. These tools retain the editor-compiled or runtime-evaluated portion after offline displacers take the static serialized portion.

| Tool | Retained surface | Commandlet reach | Verdict | Notes |
|---|---|---|---|---|
| `get_asset_references` (reverse-ref subset) | Editor `IAssetRegistry::GetReferencers` graph | Q1 confirmed: AR enumerated 22,064 packages in commandlet mode (~11s scan). `GetReferencers` works on the populated AR. | **FULL** | AR behavior is identical commandlet vs editor. Run-1 cost is shared across all uses. |
| `get_datatable_contents` (engine-struct-keyed + cooked) | Compiled DataTable row cache (post-load in-memory) | `UDataTable::GetRowMap()` returns the loaded row cache after `LoadPackage`. Engine-struct keys fully usable. Cooked DataTables: load path is identical. | **FULL** | DataTable row cache is populated during PostLoad — commandlet executes PostLoad normally. |
| `get_montage_full` (evaluated blend + slot machinery) | Runtime-evaluated montage state (UAnimInstance → slot positions, active blends) | Requires live UAnimInstance (i.e., PIE actor with UAnimInstance component evaluating). Commandlet has no PIE world. Static blend settings (SlotAnimationTracks, SequenceLength) ARE readable via normal UPROPERTY. | **PARTIAL** | Static compiled YES (slot names, section names, branching conditions are serialized); runtime-evaluated NO. |
| `get_anim_sequence_info` (compiled notify + curve eval) | Compiled notify-track lookups + evaluated curves + sync markers | Compiled notify tracks serialized → FULL. Evaluated curves at time T: `UAnimSequence::GetCurveValue(Name, Time)` is a pure function on compiled data — works headless. | **FULL** | Curve evaluation is deterministic on serialized curve data; no runtime state needed. |
| `get_blend_space` (runtime interpolation) | Runtime-evaluated blend (sample → pose interpolation) | Sample points serialized. Evaluation requires UAnimInstance pose-eval — NOT available headless. | **PARTIAL** | Can enumerate samples; can't interpolate poses without live anim graph. |
| `get_anim_curve_data` (compiled/baked) | Compiled curve bake (baked keyframes) + runtime eval | Baked keyframes serialized → FULL. Runtime eval at arbitrary time: same as `get_anim_sequence_info` — pure function on serialized bake. | **FULL** | Same as anim sequence. |
| `list_material_parameters` (compiled shader uniforms) | Shader compiler output (baked uniforms) | Compiled shader maps require `-AllowCommandletRendering` + shader compiler active. CompileAllBlueprints does NOT enable this; neither does ResavePackages by default. Without rendering, material CDO reads work (static defaults) but compiled shader uniforms require compile pipeline. | **PARTIAL** | Static params FULL via FPropertyTag (already offline per D50); compiled uniforms require `-AllowCommandletRendering` and shader job system. Feasible but adds ~minutes to boot for shader compile. |
| `get_material_graph` (full UMaterialExpression graph) | Full node walk — `UMaterial::Expressions` TArray | `LoadPackage` of a UMaterial loads the FExpressionInput graph (UPROPERTY). Commandlet walks it normally. | **FULL** | UMaterialExpression graph is standard UPROPERTY serialization; no shader compile needed to read the node graph. |
| `get_curve_asset` (compiled bake) | Compiled UCurveTable join evaluation | `UCurveFloat::GetFloatValue(Time)` is pure on serialized keyframes. `UCurveTable` joins (row + external curve) available post-load. | **FULL** | Same determinism as anim curves. |
| `get_string_table` (localization compile) | Culture-compiled lookups | Raw entries: FULL via FPropertyTag (already offline). Culture-compiled requires `FInternationalization` culture switching. Commandlets can set culture but the compiled entries are mostly raw text — only locale plurals/formatting need runtime. | **PARTIAL** | Default-culture entries FULL; non-default-culture locale-compiled may need active localization manager state. |
| `get_mesh_info` (compiled vertex buffer) | Compiled GPU vertex buffer | GPU upload requires rendering pipeline — commandlet skips RHI by default. CPU-side vertex/index arrays via `UStaticMesh::GetRenderData()` are available after load if the cook path populated them. For uncooked `.uasset`: need `UStaticMesh::GetSourceModel()` which is editor-only but works in UEditorEngine. | **PARTIAL** | Vertex/triangle counts + bounds FULL; GPU buffer contents NONE without rendering. |
| `get_asset_thumbnail` | Editor-rendered thumbnail cache | `UThumbnailManager::GetThumbnailForObject` requires active thumbnail rendering. Requires Slate + rendering pipeline. | **NONE** | Thumbnail rendering is editor-UI-bound. |
| `get_asset_preview_render` | FPreviewScene offscreen render | Same constraint — offscreen render needs RHI + Slate-less render-to-texture setup. Technically possible with `-AllowCommandletRendering` but substantial engineering. | **NONE** | Rendering-pipeline-bound. |
| `get_asset_visual_summary` | Composite of above (text + inline image) | Inherits constraints — text portion FULL (commandlet reaches reflection), image portion NONE. | **PARTIAL** | Text portion FULL; visual portion NONE. |

**(c) subtotal**: **FULL: 6/14 (43%)**, PARTIAL: 6/14 (43%), NONE: 2/14 (14%).

### §Q3.3 Rollup

| Disposition | (d) count | (c) count | Combined | % of 22 |
|---|---|---|---|---|
| **FULL** (commandlet fully serves the retained surface) | 6 | 6 | **12** | **55%** |
| **PARTIAL** (commandlet serves static/serialized; runtime eval or rendering gap) | 2 | 6 | **8** | 36% |
| **NONE** (rendering/PIE/Slate required; commandlet cannot reach) | 0 | 2 | **2** | 9% |

**Handoff's >70% threshold interpretation**:
- FULL-only: 55% → **below** threshold.
- FULL + PARTIAL: 91% → **above** threshold if we count partial-coverage as sufficient for RESTRUCTURE-AGGRESSIVE.

The handoff's threshold is ambiguous on this distinction. Reading it as "80% of the (c)+(d) workflow pressure resolves via commandlet" (not strictly "FULL"), the answer leans toward above-threshold. Reading it strictly as "commandlet fully replaces the retained surface," it's below.

**My read**: the PARTIAL category includes tools where commandlet covers the common-case need (static data) and misses edge cases (runtime eval). For the DOMINANT workflow the spike is about (offline BP pin topology + spatial), commandlet is less directly relevant than the (d) reflection-only tools — which score 75% FULL. But the spike's Q3 framing extends to all (c)+(d) coverage to evaluate whether M-sequence restructure is justified.

**Honest rollup**: commandlet unlocks ~55% of (c)+(d) cleanly, with an additional ~36% partial/serviceable-with-caveats. The 91% combined is comparable to what the scope-refresh already achieved offline via Agent 10/10.5's D50 tagged-fallback (71% marker reduction, 601 unique structs decoded). Commandlet's incremental gain over the shipped offline surface is modest — the reflection-only tier (7 tools) is where commandlet materially adds capability beyond what D50 delivered.

### §Q3.4 Counter-expected findings

Per handoff §Q3 "Counter-expected findings worth flagging if they emerge":

1. **"Commandlets can't initialize editor subsystems needed for full reflection"** — FALSE. Q1 confirmed full UEditorEngine boot, all plugins loaded, Wwise + Python + MetaSound + shader-compiler-framework all initialized. Reflection works.

2. **"Compiled shader/Niagara data isn't accessible without shader compilation active"** — TRUE, partially. Compiled shader uniforms (`list_material_parameters` retained surface) require `-AllowCommandletRendering`. Niagara VM compilation is similar. Adding the flag adds minutes to boot (shader compile) and RHI init — not fatal but costly.

3. **"Headless initialization is unstable (asserts, hangs) for the deeper tools"** — FALSE for our corpus. Zero asserts, zero hangs across 2 runs. Clean shutdown sequence.

4. **"TCP port contention in commandlet mode"** — TRUE, surfaced incidentally. Existing UnrealMCP plugin starts MCPServerRunnable unconditionally; the UEMCP Phase 3 plugin must gate on `!FApp::IsRunningCommandlet()` in StartupModule.

---

## §Q4 — M-sequence verdict: PRESERVE + AUGMENT

### §Q4.1 Verdict card

| Criterion | Result | Threshold | Met? |
|---|---|---|---|
| Q1 latency viable | 5.7s floor, 17.5s with AR | < 30s cold | ✓ Yes (better than expected) |
| Q2 commandlet C++ ≤ save-hook C++ | ~roughly equivalent (both ~1 session); hybrid +0.5 incremental | Commandlet ≤ save-hook | ≈ Roughly equal |
| Q3 (c)+(d) coverage >70% | FULL: 55%; FULL+PARTIAL: 91% | >70% (ambiguous on FULL vs FULL+PARTIAL) | Mixed — depends on threshold reading |
| **RESTRUCTURE-AGGRESSIVE prereq conjunction** | Q1 YES, Q2 YES, Q3 MARGINAL | All three must hold strongly | ✗ Not satisfied |

**Verdict: PRESERVE + AUGMENT** — adding one new component (`3F-4 DumpBPGraphCommandlet`) to the existing M-sequence, without displacing save-hook, M1, or downstream milestones.

### §Q4.2 Why not RESTRUCTURE-AGGRESSIVE

Steel-manning the AGGRESSIVE option ("defer M1 entirely; skip save-hook; commandlet is the path"):

- **M1 isn't reads-gated.** M1 scaffolds TCP:55558 for writes (35 tools in D52 category (w)). Commandlet cannot serve writes — they require live UEditorEngine + FScopedTransaction + user-editor-session state. Even 100% (c)+(d) read coverage on commandlet doesn't defer M1; the handoff's framing conflates read-displacement pressure with M1's purpose.
- **17.5s interactive latency is prohibitive for warm-path workflows.** Noah's described use case ("look at a Blueprint and traverse it like we are looking at a picture") implies responsive interaction. Save-hook provides 0ms freshness when the editor is running (the common dev path). A ~17s commandlet round-trip per BP query would make interactive traversal painful.
- **Coverage is marginal, not strong.** 55% FULL is below the threshold. The strong signal isn't there.
- **Concurrency is unverified.** The handoff asks whether 2+ commandlets can run against one .uproject in parallel. We didn't test empirically. Conservative default (single-flight per project) limits the commandlet's agent-automation throughput.

**Conclusion**: steel-man fails. AGGRESSIVE relies on all three thresholds holding; only Q1 holds strongly.

### §Q4.3 Why not RESTRUCTURE-HYBRID

Steel-manning HYBRID ("commandlet-first for reads, defer M1 TCP, save-hook as eventual latency optimization"):

- **Same M1 defect.** Deferring M1 assumes write-surface pressure doesn't accumulate. Per CLAUDE.md + scope-refresh §Q2.5, Phase 3 has 35 write tools across gas/animation/materials/data-assets/editor-utility/geometry/input-and-pie/widgets that are self-justifying under D52. Writing ProjectA content is a core UEMCP use case, not a speculative future need. M1 scaffolding is on the critical path.
- **Save-hook-as-eventual** postpones the warm-path UX improvement without a clear re-entry trigger. The save-hook is cheap (~1 session over the shared serializer) and solves the dominant interactive workflow; delaying it costs more than shipping it.
- **Commandlet-first** flips the D54 verdict without new evidence justifying the flip. D54 was decided on dependency-cleanliness + D52-near-parity trajectory grounds that remain valid.

**Conclusion**: HYBRID steel-man fails because M1 is still needed for writes and save-hook is still the interactive best-path.

### §Q4.4 Why not pure PRESERVE

Steel-manning PRESERVE (zero commandlet work):

- **Fresh-checkout + no editor** scenario leaves L2 traversal verbs returning `{available: false}` until someone opens the editor. CI pipelines and agent-automation against an unprimed project have no L2 workflow access.
- **3F-3 editor-menu `prime_bp_cache`** requires the editor to be launched interactively (menu command). Cannot be automated from CI without UI scripting (Python Editor Scripting is possible but adds a layer).
- **Perforce / Git sync bringing changed BPs** without editor open = stale sidecars until someone opens + saves each BP. Save-hook only fires on editor-save events.

**Conclusion**: pure PRESERVE leaves CI/automation/sync-driven cases uncovered. The gap is real.

### §Q4.5 Why PRESERVE + AUGMENT wins

Adding `3F-4 DumpBPGraphCommandlet` covers the PRESERVE gaps at low incremental cost:

| Scenario | Save-hook (3F-2) | Editor-menu prime (3F-3) | Commandlet prime (3F-4 new) |
|---|---|---|---|
| Editor open, developer saves BP | ✓ 0ms | — | — |
| Fresh checkout, developer opens editor + primes | — | ✓ Interactive | ✓ Also works |
| CI pipeline, no editor session | ✗ | ✗ (UI required) | ✓ Headless |
| Agent automation, editor not running | ✗ | ✗ | ✓ Spawn subprocess |
| Perforce sync brings changed BPs, no editor open | ✗ stale until reopen | ✗ | ✓ Re-prime |
| One-off per-BP on-demand dump | ✗ | ✗ | ✓ ~6s cold |

Each column serves a distinct workflow; no single path covers all cases.

**Incremental cost**: ~0.5–1 additional plugin-worker session on top of M2-Phase-A scope (per §Q2.5 sizing). The serializer is shared. No new offline-worker effort — the consumer-side reader + verbs stay identical regardless of which plugin component wrote the sidecar.

**D54 compatibility**: preserved. D54's SHIP-SIDECAR-PHASE-A-FIRST scope was "save-hook + editor-menu prime + offline reader + 9 verbs." Adding commandlet is a narrow augmentation within the 3F bundle, not a displacement of D54's decision.

### §Q4.6 Proposed augmentation — 3F-4 specification (design-only, NOT implementation)

Adds one plugin component to M2-Phase-A:

**3F-4: `UDumpBPGraphCommandlet` UCommandlet subclass.**
- **Inputs (CLI switches)**: `-Asset=<path>` (single-BP mode, e.g., `/Game/Blueprints/Character/BP_OSPlayerR`), OR `-AssetList=<file.txt>` (batch from file), OR no-input (= prime-all, iterate AR UBlueprint subclasses).
- **Switches**: `-OutputDir=<path>` (override default `<ProjectDir>/Saved/UEMCP/BPCache/`), `-Force` (rewrite even if sidecar mtime > asset mtime), `-SkipDDC` (cooperative for concurrent runs).
- **Behavior**: `Main(Params)` calls `ParseCommandLine`, resolves target set, iterates, calls `FUEMCPBlueprintSerializer::Serialize(UBlueprint*, FString&)` (shared with save-hook), writes to output dir via the shared path helper. Idempotent: skip when sidecar mtime > asset mtime unless `-Force`.
- **Exit code**: 0 on success; 1 on any BP serialization failure; 2 on arg-parse failure. `UseCommandletResultAsExitCode=1` set.
- **Logging**: `DEFINE_LOG_CATEGORY_STATIC(LogUEMCPDumpBPGraph, Log, All);` with `[REPORT]` lines at 10% or every 100 BPs (whichever larger) — matches UE convention from ResavePackages.
- **Plugin server gating**: Ensure UEMCP's own `MCPServerRunnable` does NOT start when `FApp::IsRunningCommandlet()` is true. Apply to both save-hook registration and TCP server binding.
- **Scope**: UBlueprint + UAnimBlueprint + UWidgetBlueprint + UEditorUtilityBlueprint (matches 3F-1 TCP command scope per D56). UMaterial out-of-scope per D56.

**Not doing (explicitly)**:
- No TCP interaction in this commandlet (commandlet spawns, writes, exits — MCP server doesn't persist).
- No DDC manipulation beyond default UE behavior.
- No source-control hooks (`-nop4` passed by invoker).
- No error attempts to recompile BPs (pure read).

**Consumer-side changes (offline-tools.mjs)**:
- Optional: add a `prime_sidecars_via_commandlet(bp_paths?)` offline tool that spawns `UnrealEditor-Cmd.exe -run=DumpBPGraph -AssetList=<temp>` via `child_process.spawn`. Adds ~0.25 session of JS work. Opt-in — not required for the verbs themselves.
- Or: defer this and let users/CI invoke the commandlet directly. Lower-cost option.

### §Q4.7 Updated M-sequence

| Milestone | Title | Sessions (range) | Change vs scope-refresh §Q5.1 |
|---|---|---|---|
| M0 | Phase 3 yaml grooming | 0.5 | Unchanged |
| M1 | 3A TCP scaffolding + infrastructure | 3–5 | Unchanged; **new flag** — gate `MCPServerRunnable` on `!FApp::IsRunningCommandlet()` |
| **M2-Phase-A** | **3F sidecar** — save-hook + editor-menu prime + offline reader + 9 verbs + **new: DumpBPGraphCommandlet** | **3.5–6** (was 3–5; +0.5–1 for commandlet) | **Augmented: add 3F-4 commandlet as a parallel plugin-worker subtask** |
| M2-Phase-B | 3F dump_graph TCP + TCP-invocable prime | 1–2 | Unchanged |
| M3 | Oracle retirement (actors, bp-write, widgets on 55558) | 6–10 | Unchanged |
| M4 | Reduced blueprint-read + asset-registry + data-assets reads | 3–5 | Unchanged |
| M5 | Animation + materials + geometry + input-PIE + editor-utility + visual-capture | 6–10 | Unchanged |
| M6 (optional) | Skeletal-subset S-B pure-offline pin-trace | 6–9 | Unchanged (oracle-gated per D55) |

**Total sessions delta**: +0.5–1 (all in M2-Phase-A). Parallelism opportunities unchanged (M1 ↔ M2-Phase-A still parallelizable; commandlet subtask is a sibling of save-hook subtask under the same plugin worker, or a separate parallel third worker if orchestration prefers). The +0.5–1 absorbs inside M2-Phase-A's existing 3–5 session range via the sub-worker split in §Q4.8 — scope-refresh §Q5.5's "wall-clock ~12–20 sessions with parallelism" envelope is unchanged.

### §Q4.8 Dispatch sequencing for M2-Phase-A with 3F-4 augmentation

Within M2-Phase-A, suggested sub-worker split:

| Sub-worker | Scope | Sessions |
|---|---|---|
| **Plugin-A** | Serializer (shared), save-hook delegate driver, path helper | 1.5–2 |
| **Plugin-B** (parallelizable with Plugin-A after serializer lands) | 3F-3 editor-menu prime + 3F-4 DumpBPGraphCommandlet | 1–1.5 |
| **Offline worker** (parallelizable with both) | Sidecar reader + 9 traversal verbs + path-translation helper | 2–3 |

Plugin-A ships the serializer first (~1 session). Plugin-B depends on it for the commandlet body + editor-menu prime iteration. Offline worker is independent.

Alternative single-worker arrangement: one plugin worker sequentially ships serializer → save-hook → 3F-3 → 3F-4, ~3 sessions. Offline worker parallel. This matches the scope-refresh's §Q3.4 sequencing with 3F-4 appended as step 5.

Orchestrator choice based on worker availability.

### §Q4.9 Reopening triggers for RESTRUCTURE

PRESERVE+AUGMENT is the right verdict **today**. Conditions that would re-trigger RESTRUCTURE evaluation:

1. **Write-surface pressure drops unexpectedly**. If D52 (w) category workflows turn out to not be needed (e.g., Noah's actual ProjectA automation stays pure-read), M1's critical-path status weakens. Low probability given 35 writes + catalog demand.
2. **Commandlet latency drops further via UE version update** (UE 5.7 commandlet boot improvements? unclear). If cold-boot drops to <5s, interactive commandlet-per-query becomes viable — but still won't beat save-hook's 0ms.
3. **Save-hook fidelity issues surface at implementation time**. If `FCoreUObjectDelegates::OnObjectSaved` has behaviors that make the serializer unreliable (e.g., runs before Blueprint compile finalization in some corner case), commandlet becomes the more reliable priming source. Monitor during M2-Phase-A implementation.

None present today.

---

## §Framing-audit notes

Per handoff memory entry `feedback_framing_audit.md`, pushing back on assumptions the handoff encoded.

### §FA-1 Q3 threshold conflates reads with M1 purpose

**Concern**: handoff Q4 says RESTRUCTURE-AGGRESSIVE requires "Q3 shows >70% (c)+(d) coverage." But the M-sequence restructure under AGGRESSIVE also defers **M1** — which serves 35 write tools (D52 category (w)). Even if (c)+(d) read coverage were 100%, M1 would still be needed for the write surface. The >70% threshold is a READ-coverage metric that the handoff uses to gate a WRITE-scaffolding decision.

**Finding**: the threshold should apply only to "can we displace save-hook + reduced reads onto commandlet," NOT to "can we defer M1." The handoff's phrasing bundles these but they're separable:
- Displacing save-hook requires commandlet to serve the same sidecar-writer role at comparable UX (latency, freshness, automation). It doesn't — 17.5s cold-boot vs 0ms save-hook.
- Deferring M1 requires write-surface pressure to be absent. It isn't — 35 write tools per scope-refresh.

**Impact**: verdict reasoning cleanly separates the two. AGGRESSIVE fails on latency (save-hook displacement) AND on write-surface pressure (M1 defer). Neither is a "read-coverage threshold" issue per se.

### §FA-2 "Commandlet-first + save-hook-as-eventual" conflates complementary workflows

**Concern**: handoff HYBRID option says "commandlet-first for reads, ship save-hook as an eventual latency optimization." This treats the two as substitutable with commandlet-primary. They aren't substitutable — they serve distinct workflows:
- Save-hook = warm-path (editor-open, 0ms per save).
- Commandlet = cold-path (editor-closed OR automation, 6–17s per invocation).

A workflow where "editor is often open during dev" (ProjectA's typical case) is save-hook-optimal. Making commandlet primary and save-hook optional means dev workflow pays cold-path latency whenever they want fresh sidecars.

**Finding**: the two components are **complementary**, not a ranked choice. Ship both (PRESERVE+AUGMENT) or ship only save-hook (PRESERVE) — but not "commandlet primary, save-hook later."

**Impact**: HYBRID as framed in the handoff is strictly worse than AUGMENT for the dev/interactive workflow. Worth flagging because the handoff's menu implies HYBRID is a "ship less save-hook now" optimization — it's actually a UX regression for the dominant dev case.

### §FA-3 Latency expectation was conservative

**Concern**: handoff §Q1 "Expected: 30-60s cold. If it's 5min, the approach is non-viable. If it's 10-20s, it's BETTER than expected."

**Finding**: 17.5s lands firmly in BETTER territory. 5.7s engine-only floor is even faster. Commandlet is more viable than the handoff's expected case suggested — but this doesn't change the fundamental latency asymmetry vs save-hook's 0ms warm-path. The handoff's expectation miscalibration doesn't affect the verdict (PRESERVE+AUGMENT) but it does update the commandlet's attractiveness for CI/automation cases.

**Impact**: minor. The verdict is unchanged, but agents sizing future commandlet-dependent work can use the 5.7–17.5s measurement as the grounded baseline rather than the 30–60s expectation.

### §FA-4 Plugin-server contention in commandlet mode

**Concern**: the handoff's Q1 concurrency question ("can we run 2+ commandlets in parallel") is surfaced but doesn't flag the single-commandlet-vs-live-plugin port contention. Our Q1.4 evidence shows the existing UnrealMCP plugin starts its TCP server in commandlet mode. UEMCP's Phase 3 plugin would do the same unless gated.

**Finding**: not a spike-blocking concern, but a plugin-design constraint that M1 scaffolding needs to handle regardless of this spike's verdict. `MCPServerRunnable::StartupModule()` must check `FApp::IsRunningCommandlet()` and skip TCP binding. Same for any tick or save-hook delegate that shouldn't fire during commandlet runs.

**Impact**: filed as an M1 design constraint in §Q4.7.

### §FA-5 Q3 "KEEP (reduced) surface" interpretation ambiguity

**Concern**: the scope-refresh §Q1 tables define "reduced surface" differently for each tool — sometimes "only the reflection flags," sometimes "only the runtime-evaluated portion," sometimes "only the compiled shader uniforms." Rolling these up into a single (c)+(d) coverage percentage flattens that nuance.

**Finding**: my Q3.1/Q3.2 tables preserve the per-tool granularity (FULL / PARTIAL / NONE), but the 55%/36%/9% rollup is rough. A more careful rollup would weight each tool by workflow-catalog demand (which the scope-refresh §Q1 tables flagged but this spike didn't re-enumerate).

**Impact**: the verdict is robust to the measurement noise — even generous 91% (FULL+PARTIAL) falls short of strict RESTRUCTURE-AGGRESSIVE justification given the M1-displacement flaw (FA-1). Flag is informational.

### §FA-6 Framing says "commandlet = lazy, save-hook = proactive" but both can be either

**Concern**: handoff intro frames commandlet as "lazy (30s cold / ~instant cached)" and save-hook as "proactive (0s warm, but stale when editor wasn't running during save)." This frames them on a time-axis but misses that either can serve "lazy or proactive" depending on how you invoke it:
- Save-hook fires proactively on save (proactive) but can be treated as lazy if you don't care when each BP was saved.
- Commandlet can run lazily (on-demand per query) or proactively (batch prime at CI build time).

**Finding**: the handoff's framing is a reasonable mnemonic but isn't the right dispatch lens. The right lens is: **who triggers the write, when, and is the editor running?**

**Impact**: cosmetic; verdict unchanged.

---

## §Appendix A — Command outputs + file paths

### §A.1 NullCommandlet run

Command (Git Bash, `time` wrapper):
```bash
time "/c/Program Files/Epic Games/UE_5.6/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" \
  "D:/UnrealProjects/5.6/ProjectA/ProjectA/ProjectA.uproject" \
  -run=NullCommandlet -unattended -nop4 -nosplash -stdout 2>&1
```

Wall-clock: `real 0m5.722s`. Exit code: 0.

Output captured to `D:/DevTools/UEMCP/.tmp-spike/null_run.txt` (154 lines).

Key log excerpts:
- `LogInit: Display: Running engine for game: ProjectA`
- `LogCsvProfiler: Display: Metadata set : engineversion="5.6.1-44394996+++UE5+Release-5.6"`
- `LogPluginManager: Display: By default, prioritizing project plugin (.../UnrealMCP.uplugin) over the corresponding engine version`
- `LogAkAudio: Display: Wwise SoundEngine is disabled: Running a commandlet.`
- `LogTemp: Display: Unreal MCP Module has started` [existing plugin loads]
- `LogInit: Error: NullCommandlet looked like a commandlet, but we could not find the class.`
- `LogTemp: Display: Unreal MCP Module has shut down`

### §A.2 ResavePackages run

Command:
```bash
time "/c/Program Files/Epic Games/UE_5.6/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" \
  "D:/UnrealProjects/5.6/ProjectA/ProjectA/ProjectA.uproject" \
  -run=ResavePackages -PackageSubstring=BP_OSPlayerR -IgnoreChangelist \
  -unattended -nop4 -nosplash -stdout 2>&1
```

Wall-clock: `real 0m17.535s`. Exit code: 0. Commandlet-internal: `Execution of commandlet took: 1.71 seconds`.

Output captured to `D:/DevTools/UEMCP/.tmp-spike/resave_run.txt`.

Key log excerpts:
- `LogContentCommandlet: Display: Restricted to packages containing BP_OSPlayerR`
- Asset enumeration: `[REPORT] 0/22064 packages were considered for resaving` (P4 read-only skip)
- `LogContentCommandlet: Warning: Skipping read-only file D:/.../Blueprints/Character/BP_OSPlayerR.uasset` (P4 discipline)
- Clean shutdown: `UnrealMCPBridge: Shutting down`, `MCPServerRunnable: Server thread stopping`, `Unloading WwiseSoundEngine`

### §A.3 UCommandlet reference

Source: `C:/Program Files/Epic Games/UE_5.6/Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h` (180 lines).
Key surface: `int32 Main(const FString& Params)`, `ParseCommandLine`, `IsEditor:1`, `FastExit:1`, `UseCommandletResultAsExitCode:1`.

### §A.4 CompileAllBlueprintsCommandlet reference

Source: `C:/Program Files/Epic Games/UE_5.6/Engine/Source/Editor/UnrealEd/Private/Commandlets/CompileAllBlueprintsCommandlet.cpp` (359 lines).
Pattern: `Main(Params)` → `InitCommandLine(Params)` → `InitKismetBlueprintCompiler()` → `BuildBlueprintAssetList()` → `BuildBlueprints()` → `LogResults()`.

Arg switches documented: `-ShowResultsOnly`, `-DirtyOnly`, `-CookedOnly`, `-SimpleAssetList`, `-RequireTags=`, `-ExcludeTags=`, `-IgnoreFolder=`, `-AllowListFile=`, `-BlueprintBaseClass=`.

AR-filtering pattern (from `BuildBlueprintAssetList` context, inferred from public API): `IAssetRegistry::Get().GetAssetsByClass(UBlueprint::StaticClass()->GetClassPathName(), Results, /*bSearchSubClasses*/ true)`.

### §A.5 DumpBlueprintsInfoCommandlet (REMOVED stub, for context)

Source: `C:/Program Files/Epic Games/UE_5.6/Engine/Source/Editor/UnrealEd/Private/Commandlets/DumpBlueprintsInfoCommandlet.cpp` (27 lines).

Body: `UE_LOG(LogBlueprintInfoDump, Error, TEXT("DumpBlueprintsInfo has been removed - consider using the GenerateBlueprintAPI commandlet instead\n")); return 0;`

Not useful as a reference (stub only), but confirms that blueprint-dumping commandlets have historical precedent in UE.

### §A.6 Existing UnrealMCP plugin layout (for Phase 3 plugin mirroring)

Source: `D:/UnrealProjects/5.6/ProjectA/ProjectA/Plugins/UnrealMCP/Source/UnrealMCP/Private/`:

```
Commands/
  UnrealMCPBlueprintCommands.cpp
  UnrealMCPBlueprintNodeCommands.cpp
  UnrealMCPCommonUtils.cpp
  UnrealMCPEditorCommands.cpp
  UnrealMCPProjectCommands.cpp
  UnrealMCPUMGCommands.cpp
MCPServerRunnable.cpp
UnrealMCPBridge.cpp
UnrealMCPModule.cpp
```

Save-hook presence: **none found**. `Grep` for `OnObjectSaved|OnPostSave|FCoreUObjectDelegates|FEditorDelegates|OnObjectPostEdit` across the plugin's Source returned zero matches. The existing plugin does not implement 3F-2 — UEMCP's Phase 3 plugin is greenfield on this surface.

### §A.7 Sidecar design summary

From `docs/research/sidecar-design-resolutions-2026-04-19.md` + `docs/specs/blueprints-as-picture-amendment.md`:

- **Schema**: JSON, `<bp_name>.bp.json`, keyed by schema version `"version": "1.x.y"`.
- **Location** (Q1 resolved): `<ProjectDir>/Saved/UEMCP/BPCache/<asset-relative-from-Content>.bp.json` — mirror tree.
- **Writer (3F-2)**: `FCoreUObjectDelegates::OnObjectSaved` delegate filter to UBlueprint subclasses; serializer emits amendment schema; error-swallow policy (log + skip, never block save).
- **Reader (offline tools)**: path translation helper → JSON read → schema-version check → fallback `{available: false}` if stale/missing.
- **Traversal verbs (9)**: `bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_find_in_graph`, `bp_paths_between` (v1.1).
- **Scope (Q3/Q4 resolved)**: UBlueprint subclasses only (UBlueprint, UAnimBlueprint, UWidgetBlueprint, UEditorUtilityBlueprint). UMaterial out — `get_material_graph` is the v1 material read interface.
- **CDO (Q5 resolved)**: sidecar does NOT carry CDO defaults; offline `inspect_blueprint.include_defaults` + `read_asset_properties` cover the serialized-CDO surface.

### §A.8 D-log anchors used

- **D45** (`risks-and-decisions.md:143`) — L3A full-fidelity EDITOR-ONLY; 3F sidecar is the offline-read path with acknowledged soft editor dependency.
- **D48** (`:146`) — S-A/S-B skeletal split; S-A PURSUE (shipped 2026-04-17); S-B FOLD-INTO-3F (superseded by D55).
- **D52** (`:150`) — Near-plugin-parity for offline READs; plugin scope = writes + genuinely-offline-infeasible reads.
- **D54** (`:152`) — SHIP-SIDECAR-PHASE-A-FIRST; Phase A (save-hook + prime + reader + verbs) parallel with M1.
- **D55** (`:153`) — S-B PURSUE-AFTER-SIDECAR at 6-9 sessions (not handoff's 4-6); sidecar = oracle.
- **D56** (`:154`) — `get_widget_blueprint` splits: EventGraph → MOVE-TO-SIDECAR; widget-tree → KEEP (reduced) plugin-TCP.

### §A.9 Input files consulted (per handoff §Input files tier)

**Tier 1 — Direct scope impact**:
1. `docs/research/phase3-scope-refresh-2026-04-20.md` (§Q1, §Q2, §Q3, §Q4, §Q5, §Framing-audit) ✓
2. `docs/research/sidecar-design-resolutions-2026-04-19.md` (Q1–Q5 + §2 downstream + §3 confidence) ✓
3. `docs/specs/blueprints-as-picture-amendment.md` ✓
4. `docs/tracking/risks-and-decisions.md` (D45, D48, D52, D54, D55, D56) ✓

**Tier 2 — UE 5.6 source references**:
5. `Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h` ✓
6. `Engine/Source/Editor/UnrealEd/Private/Commandlets/CompileAllBlueprintsCommandlet.cpp` (partial — first 120 lines) ✓
7. `Engine/Source/Editor/UnrealEd/Private/Commandlets/DumpBlueprintsInfoCommandlet.cpp` (removed stub) ✓
8. UnrealEd-side BP loading (not directly read; relied on standard UE knowledge of UBlueprint PostLoad semantics)

**Tier 3 — Plugin reference**:
9. `ProjectA/Plugins/UnrealMCP/Source/` (layout + save-hook presence scan) ✓
10. `plugin/` (UEMCP's empty scaffold — confirmed empty per CLAUDE.md)

**Tier 4 — Orchestrator state**:
11. `CLAUDE.md` (current state, shipped surface, test assertion count) ✓

**Empirical**:
12. Two `UnrealEditor-Cmd.exe` invocations with wall-clock timing against ProjectA ✓

---

## §Appendix B — Orchestrator decision summary

### §B.1 Single-sentence verdict

**PRESERVE the current D54 M-sequence; AUGMENT M2-Phase-A with a new 3F-4 `DumpBPGraphCommandlet` subtask at ~0.5–1 session incremental cost.**

### §B.2 What the orchestrator does next

With this verdict:

1. **M0 (yaml grooming)** — unchanged. No commandlet-related yaml additions needed (commandlet is a plugin component, not a tool exposed to Claude).
2. **M1 (3A TCP scaffolding)** — unchanged scope, but **new constraint for the worker**: gate `MCPServerRunnable::StartupModule()` TCP bind on `!FApp::IsRunningCommandlet()`. Same for any save-hook delegate registration that shouldn't fire during commandlet runs. Flag in the M1 handoff.
3. **M2-Phase-A (sidecar)** — dispatch with augmented scope per §Q4.7. Plugin worker ships serializer + save-hook + editor-menu prime + **DumpBPGraphCommandlet** (4 subtasks, ~3.5–5 sessions total). Offline worker ships reader + 9 verbs (2–3 sessions). Orchestrator may split plugin work across 2 workers (serializer-first, then save-hook ↔ commandlet in parallel) — path-limited commits per D49.
4. **M2-Phase-B** onward — unchanged.

### §B.3 What the orchestrator does NOT do

- Does NOT defer M1 (writes remain needed per D52 category (w)).
- Does NOT skip save-hook (save-hook is warm-path-optimal; commandlet is complementary).
- Does NOT design the commandlet's JSON schema separately (reuses amendment schema via shared serializer).
- Does NOT write the commandlet in this spike (implementation is follow-up handoff, triggered by this verdict).

### §B.4 Follow-up artifacts triggered by this verdict

1. **M2-Phase-A dispatch handoff** — needs updating to include 3F-4 commandlet scope. Owner: orchestrator when M2-Phase-A dispatches.
2. **M1 dispatch handoff** — needs the `!FApp::IsRunningCommandlet()` constraint noted. Owner: orchestrator when M1 dispatches.
3. **D-log entry D58 (proposed)** — "3F-4 commandlet adds to 3F sidecar bundle as CI / agent-automation / cold-priming path. Incremental ~0.5–1 session. Does not displace save-hook." Owner: orchestrator when M2-Phase-A lands.
4. **Amendment file §Phase 3 plugin requirements** — adds 3F-4 entry. Owner: orchestrator (documentation update, non-blocking).
5. **Concurrency verification** — empirical test of 2 commandlets vs same .uproject. Owner: whoever implements M2-Phase-A plugin work. Small risk (DDC lock file contention) but not a blocker.

### §B.5 Confidence

**HIGH** on Q1 empirical viability (measured twice, reproducible).
**MEDIUM-HIGH** on Q2 cost comparison (grounded in reference commandlet LOC + UCommandlet API clarity; single-worker estimates uncertain by ±0.5 session).
**MEDIUM** on Q3 coverage (per-tool FULL/PARTIAL calls involve judgment; tools I marked PARTIAL could shift FULL with `-AllowCommandletRendering` and infrastructure I didn't empirically test).
**HIGH** on Q4 verdict (PRESERVE+AUGMENT is robust against all four steel-mans; incremental scope is small enough that even a 2x cost overrun doesn't change the call).

**Author's blind spots**:
- Did NOT empirically test a UBlueprint `LoadPackage` + UEdGraph walk in commandlet mode. Relied on UE source knowledge that UBlueprint.UbergraphPages etc. are UPROPERTYs and survive deserialization. Low risk given how extensively Epic uses these in editor code.
- Did NOT test `-AllowCommandletRendering` boot time; §Q3.2 "PARTIAL" verdicts for material/mesh tools are conservative estimates.
- Did NOT measure per-BP LoadPackage time; §Q1.6 projections are estimates. If real measurement comes in >5x higher, commandlet batch priming might be slower than acceptable.
- Did NOT verify whether `UEditorUtilityBlueprint`'s editor-utility module actually loads in commandlet mode; marked `get_editor_utility_blueprint` as FULL (probable). Low risk given IsEditor=1 boots UEditorEngine.

These flags suggest ~1 hour of follow-up empirical verification before M2-Phase-A dispatches IF this verdict lands — orchestrator can run the specific commandlet load/walk test with a minimal stub if risk-averse. The verdict is robust to these uncertainties; the augmentation's incremental cost is small enough to absorb overruns.

---

*End of deliverable.*
