# M-enhance Worker — HYBRID transport (RC HTTP + plugin TCP) + narrow sidecar

> **Dispatch**: Fresh Claude Code session. **Hard-gated on S-B-base landing** — needs `server/*` scope unoccupied (M-enhance adds `tcp-tools.mjs` extensions + HTTP-client infrastructure; S-B-base currently owns that tree).
> **Type**: Implementation — plugin C++ (compile-diagnostic capture + UEdGraph walkers + reflection broker + edge-case handlers) + server HTTP client infrastructure + M-enhance tool surface (~35 tools across RC + TCP + hybrid).
> **Duration**: 3-5 sessions (per D58 + D66 verdict; unchanged from D58 baseline). Absorbs what was standalone Phase 4 (RC HTTP client) — aggregate Phase 3 delta is −2 to −4 sessions.
> **D-log anchors**: D66 (FA-ε verdict HYBRID — load-bearing; read it first), D58 (M-enhance scope + re-sequence), D52 (near-plugin-parity goal refined), D53 (category-d tools split across L3/L4), D23 (4-layer architecture — Layer 4 activates inside M-enhance, not as standalone Phase 4), D59 (M1 scaffold infrastructure landed), D62 (Oracle-A commandlet precedent).
> **Deliverable**: 3-part shipment: (A) HYBRID transport infrastructure (plugin RemoteControl dep + server HTTP client + URL-scheme translator + tcp-tools.mjs extensions); (B) ~35 M-enhance tools implementing runtime/compile/reflection brokers per FA-ε §Q1 coverage table; (C) narrow sidecar (plugin-only fields) + save-hook + 3F-4 production commandlet + editor-menu prime.

---

## Mission

Build the enhancement layer that augments (not enables) the offline MCP-first foundation S-B-base/Verb-surface established. Three query categories, HYBRID transport per D66:

- **Runtime/PIE state** (live UObject values): 12 tools. Mostly RC HTTP; 3 FULL-TCP for PIE control + editor-selection state.
- **Compile-time/derived data**: 13 tools. Mix — material parameters go RC, material-graph walks go TCP, animation compiled state hybrid, compile-diagnostic capture is FULL-TCP (plugin C++ needed to capture `FCompilerResultsLog`).
- **Reflection metadata**: 10 tools. Mostly PARTIAL-RC + FULL-TCP — RC's sanitize allowlist caps flat reflection coverage to `{UIMin, UIMax, ClampMin, ClampMax, ToolTip}`; Category/Replicated/EditAnywhere/full UCLASS-flag surface needs plugin walker.

**Transport-agnostic agent-facing surface**: tools in `tools.yaml` don't expose the RC-vs-TCP split to Claude. Server-side dispatcher routes internally based on data-shape discriminator (`FA-ε §Q6 recommendation` — TCP-external-signature-with-RC-internal-substrate for PARTIAL-RC tools). One tool, one signature, one semantic — where the bytes come from is implementation detail.

**This absorbs what was Phase 4**: the 8 `remote-control` primitive tools ship as part of this bundle, not as a standalone post-M5 milestone. D23's Layer 4 allocation preserved semantically; scheduled-milestone Phase 4 does not exist.

---

## Scope — in

### §1 Prerequisites

Verify before anything:
1. **S-B-base landed** — `extractBPEdgeTopology()` exported from `offline-tools.mjs`. Verb-surface may or may not have shipped; irrelevant for M-enhance scope (no content dependency).
2. **M1 scaffold + D57 gate still working** — `test-uemcp-gate.bat` [PASS]. You add handlers to M1's plugin infrastructure; it must be functional.
3. **Test baseline**: confirm via `npm test` — should be ≥914 (914 pre-S-B-base + whatever S-B-base added).
4. **FA-ε deliverable read end-to-end** — `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md`. §Q1 coverage table is your per-tool work breakdown input; §Q2 RC capability inventory drives the RC endpoint usage; §Q3 cost/LOC breakdown calibrates expectations.
5. **RC plugin availability** — Remote Control ships with UE 5.6 as an engine plugin (`Engine/Plugins/VirtualProduction/RemoteControl/`). Verify it's enabled for ProjectA via `ProjectA.uproject` Plugins[] section before depending on it.

If any prerequisite is absent, **stop and surface to orchestrator**. Don't partial-implement against an incomplete base.

### §2 Plugin-side additions (~620-770 LOC per FA-ε §Q3.1)

#### §2.1 RemoteControl dependency add

- `plugin/UEMCP/UEMCP.uplugin` Plugins[] — add `{ "Name": "RemoteControl", "Enabled": true }` entry. UBT consistency rule (D60): module-dep without plugin-dep produces warning.
- `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs` PrivateDependencyModuleNames — add `"RemoteControl"`. This is the only runtime-exposure we need; the web-server side (`WebRemoteControl`) is what surfaces HTTP — already enabled by the engine plugin, no plugin dependency needed for us to talk TO it server-side.

#### §2.2 Compile-diagnostic capture handler (~120 LOC)

New file: `plugin/UEMCP/Source/UEMCP/Private/CompileDiagnosticHandler.{h,cpp}` (or integrated into an existing M-enhance handler file).

- Call `FKismetEditorUtilities::CompileBlueprint(UBlueprint*, EBlueprintCompileOptions, FCompilerResultsLog*)` directly (static C++ from `KismetEditorUtilities.h:169`).
- Capture `FCompilerResultsLog` messages — each has severity, message text, source node GUID (when applicable).
- JSON-serialize as `{errors: [], warnings: [], notes: [], info: []}` with per-entry `{message, severity, node_guid?, asset_path?}`.
- Register as command type e.g. `bp_compile_and_report`.

#### §2.3 UEdGraph traversal handlers (~200 LOC)

- **Material graph walk** (`materials.get_material_graph`): walk `UMaterial::MaterialGraph` edges through `UMaterialExpression*` — not a flat UPROPERTY surface, needs bespoke walk. Output shape: Oracle-A-aligned if possible (node_guid-keyed maps with pins/edges), but material-graph topology semantics differ from K2Node — document the shape divergence.
- **Event dispatcher walker** (`blueprint-read.get_blueprint_event_dispatchers`): K2Node-adjacent but with binding-target resolution. Reuse Oracle-A serializer patterns where possible.

#### §2.4 Reflection metadata walker (~150 LOC)

- Walks `FProperty::GetMetaDataMap()` directly — bypasses RC's `SanitizeMetadata` allowlist.
- Emits full UPROPERTY flag surface: `BlueprintReadWrite`, `EditAnywhere`, `Replicated`, `Category`, `SaveGame`, `Transient`, `Config`, all specifiers.
- Emits UCLASS flag set: `Blueprintable`, `BlueprintType`, `Deprecated`, `Abstract`, `Within`.
- Emits UFUNCTION signature: return type + params with flags.
- Register as a shared helper (not per-tool); both `get_blueprint_variables` and `get_blueprint_info` consume it.

#### §2.5 Edge-case handlers (~150 LOC)

Per FA-ε §Q1, these are FULL-TCP because RC can't cover them:

- `editor-utility.get_editor_state` — walks `GEditor->GetSelectedActors()` + active viewport via `FEditorViewportClient`
- `input-and-pie.start_pie` / `stop_pie` — calls `UEditorEngine::PlayInEditor` / `EndPlayMap` (non-reflection-exposed)
- `visual-capture.get_asset_preview_render` — offscreen render via `FPreviewScene` + `FWidgetRenderer`
- `blueprint-read.get_widget_blueprint` — widget tree traversal with property bindings
- `asset-registry.get_asset_references` — `IAssetRegistry::GetReferencers` + reverse-dep walk

Each is ~20-40 LOC; bundle in a single file or split by semantic group.

### §3 Server-side additions (~480 LOC per FA-ε §Q3.2)

#### §3.1 HTTP client in ConnectionManager (~150 LOC)

Extend `server/connection-manager.mjs` with Layer 4 (HTTP:30010):
- Follow the mock-seam pattern (like Layer 2/3 have `tcpCommandFn`) — add `httpCommandFn` for test injection
- Request/response: `fetch()` against `http://localhost:30010/remote/<endpoint>` with JSON body
- Timeout default 5s (RC is faster than editor-state queries; lower than TCP's 30s)
- Error normalization: HTTP non-2xx → `{success: false, message}` matching existing shape contract

Config surface: `UEMCP_RC_PORT` env var override (default 30010) per risks-and-decisions.md line 36.

#### §3.2 RC URL-scheme translator (~80 LOC)

New file: `server/rc-url-translator.mjs` (or method on ConnectionManager).

Converts M-enhance tool params → RC URL scheme:
- Input: `{tool_name, asset_path, property_name, ...}`
- Output: `{method, url, body}` matching RC's endpoint conventions (e.g., `PUT /remote/object/property` with `{objectPath, propertyName, access}` body)
- Handles `objectPath` resolution: `/Game/Blueprints/Character/BP_OSPlayerR.BP_OSPlayerR_C:Default__BP_OSPlayerR_C.Health` for CDO reads.

#### §3.3 `tcp-tools.mjs` extensions (~250 LOC)

Add M-enhance tool handlers. Per FA-ε §Q6 recommendation: PARTIAL-RC tools dispatch TCP-externally with RC-internally as optimization. The agent-facing signature is one tool; the handler internally decides RC-or-TCP.

Pattern per tool:
```js
// PARTIAL-RC example: rc_describe_object
async function rcDescribeObject(projectRoot, params) {
  // Happy path: RC covers tooltip/type/UI-clamp
  const rcResult = await connectionManager.httpCall('remote/object/describe', { ObjectPath: params.object_path });
  if (needsFullFlags(params)) {
    // Fallback: augment with plugin walker for flag set
    const tcpResult = await connectionManager.tcpCall('reflection_walk', { asset_path: params.asset_path });
    return mergeRcWithPluginFlags(rcResult, tcpResult);
  }
  return rcResult;
}
```

Caching: reads cached via ResultCache (existing infrastructure); writes bypass with `skipCache: true`.

### §4 Per-tool implementation — reference FA-ε §Q1 coverage table

The authoritative per-tool work breakdown lives at `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md` §Q1. Three groups:

**Group FULL-RC** (10 tools — implement first, lowest complexity):
- 8 `remote-control` primitives (`rc_get_property`, `rc_set_property`, `rc_call_function`, `rc_list_objects`, `rc_describe_object`, `rc_batch`, `rc_get_presets`, `rc_passthrough`)
- `materials.list_material_parameters` (BlueprintCallable UFUNCTIONs via `/remote/object/call`)
- `data-assets.get_curve_asset` (UCurveBase UPROPERTY + UFUNCTIONs)
- `geometry.get_mesh_info` (BlueprintCallable UFUNCTIONs)

**Group FULL-TCP** (12 tools — need plugin handlers):
- Material graph walk, event dispatchers, widget BP, compile diagnostic
- PIE start/stop, editor state, visual capture
- Asset references, struct definition, blueprint functions
- Console command + `is_pie_running` (prefer TCP for consistency with PIE control)

**Group PARTIAL-RC** (13 tools — hybrid dispatch, TCP-external + RC-internal):
- `rc_describe_object`, `blueprint-read.get_blueprint_info/_variables/_components`
- Animation tools (montage, sequence, blend space, curve data)
- Niagara info, data-table contents, string table, data asset types
- Editor utility BP

Each tool gets its `tools.yaml` entry (FA-β graceful-degradation envelope per D59) + handler in `tcp-tools.mjs` + test in `test-tcp-tools.mjs` (or `test-rc-wire.mjs` for RC primitives).

### §5 Narrow sidecar + save-hook + commandlet + editor-menu prime

Per D58 amendment of D54 — the narrow sidecar is M-enhance scope (NOT pre-M1 Phase A as D54 originally had). Scope:
- **Narrow-sidecar writer**: plugin-only fields emitted to `<project>/Saved/UEMCP/<asset>.sidecar.json`. Plugin-only means compile errors, reflection flags (full set, not RC-allowlist subset), runtime/compiled derivatives, via_knots annotation.
- **Save-hook**: `FCoreUObjectDelegates::OnAssetSaved.AddLambda(...)` triggers sidecar write on BP save. 0ms warm path.
- **3F-4 production commandlet**: `UDumpBPGraphCommandlet` promoted from Oracle-A's dev-only variant to production scope — emits full narrow-sidecar schema, not edge-only. Reuses Oracle-A's serializer skeleton but adds the plugin-only fields.
- **Editor-menu prime**: "Regenerate UEMCP sidecar" menu command for on-demand priming.

Sidecar is M-enhance scope because D58 re-sequence moved it there (out of pre-M1 Phase A). Narrowness enforced: plugin-only fields only; edge topology is offline-primary via S-B-base.

### §6 Tests

- **`server/test-tcp-tools.mjs`** extensions (+60-100 assertions): M-enhance TCP tools (group FULL-TCP + PARTIAL-RC fallback path). Follow existing mock-seam pattern.
- **New `server/test-rc-wire.mjs`** (+40-60 assertions): RC wire-mock harness. Mock `httpCommandFn` with canned HTTP responses for each RC primitive. Cover FULL-RC group.
- **Cross-transport consistency tests**: for PARTIAL-RC tools, verify that RC-path and TCP-path return structurally-equivalent data for identical queries. Catches server-side dispatch logic drift.
- **Integration test**: single test pointing at a running editor (skipped if port 30010 ECONNREFUSED) — verifies end-to-end one RC call + one TCP call against real RC + real plugin.

### §7 Test baseline + regression

- Current baseline **[LATE-BINDING per S-B-base landing]** — likely 914 + ~40-80 from S-B-base = ~950-990.
- M-enhance additions: estimate +100-180 assertions.
- Full rotation must stay green. No regressions in offline (D50 tagged-fallback + S-B-base + M-spatial verbs + EN-8/9).

### §8 Prescriptive checkpoint structure

3-5 sessions across 6 logical checkpoints:

| # | Scope | Verification |
|---|---|---|
| 1 | RemoteControl plugin dep + HTTP client in ConnectionManager + RC URL translator | `test-rc-wire.mjs` skeleton — one canned RC response round-trips through ConnectionManager |
| 2 | Group FULL-RC (8 primitives + 2 UFUNCTION delegates) — `rc_*` tools + material params + curve asset + mesh info | All 10 FULL-RC tools pass wire-mock tests |
| 3 | Plugin C++ handlers: compile diagnostic + reflection walker + edge-case handlers | Integration smoke test against live ProjectA editor: one compile report captured, one full UCLASS flag dump |
| 4 | Group FULL-TCP (12 tools) + Group PARTIAL-RC (13 tools) dispatch logic | Cross-transport consistency tests green; all 35 M-enhance tools in `tools/list` |
| 5 | Narrow sidecar writer + save-hook + 3F-4 production commandlet promotion + editor-menu prime | Sidecar JSON emitted on BP save; commandlet produces matching JSON headless |
| 6 | Full test rotation + yaml entries + TOOLSET_TIPS for M-enhance | Test count ≥ prior-baseline +100-180; no regressions |

Surface status between checkpoints 2 and 5 if any group takes >1 session — scope is large enough that silent drift can cost a whole session.

---

## Scope — out

- **Edge topology** (S-B-base / Verb-surface territory). M-enhance consumes it but does not re-implement.
- **UE 5.7 delta** (S-B-overrides scope; may affect narrow sidecar IF 5.7 changes sidecar-relevant APIs, but defer until actual drift observed).
- **Writes to non-RC UPROPERTIES** — M3 scope (oracle retirement).
- **WebSocket subscription / streaming workflows** — deferred per FA-ε §Open items (1).
- **Auth / TLS on RC** — default LAN-trusted matches D23 threat model; no change.
- **Custom RC exposers** (`URemoteControlPreset::ExposeProperty`) — not cost-effective per FA-ε §Q2.6.
- **M4 reduced-reads tools** — separate 3-5 session worker post-M-enhance.
- **M5 remaining toolsets** — separate 6-10 session worker post-M-enhance.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md` — §Q1 coverage table (per-tool), §Q2 RC capability inventory, §Q6 recommendation (PARTIAL-RC implementation strategy).
2. `docs/tracking/risks-and-decisions.md` D66 (HYBRID verdict + cross-references to D23/D53/D58/D52), D58 (re-sequence + M-enhance scope).
3. `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q5.3 M-enhance (scope outline).
4. `docs/research/sidecar-design-resolutions-2026-04-19.md` — narrow-sidecar scope (may have stale framing from pre-D58; prefer D58 re-sequence for authoritative M-enhance sidecar scope).

### Tier 2 — UE 5.6 reference
5. `Engine/Plugins/VirtualProduction/RemoteControl/Source/WebRemoteControl/Private/RemoteControlModels.h` — `SanitizeMetadata` allowlist at lines 31-46 (load-bearing).
6. `Engine/Source/Editor/UnrealEd/Public/Kismet2/KismetEditorUtilities.h:169` — `FKismetEditorUtilities::CompileBlueprint` signature with `FCompilerResultsLog*`.
7. `Engine/Source/Editor/Blutility/Public/BlueprintEditorLibrary.h:145-146` — `UBlueprintEditorLibrary::CompileBlueprint` UFUNCTION (returns void; insufficient for diagnostics).
8. context7 MCP — UE 5.6 Remote Control docs for HTTP endpoint reference.

### Tier 3 — Precedent / substrate
9. `server/connection-manager.mjs` — existing Layer 2/3 mock-seam pattern. Extend for Layer 4.
10. `server/tcp-tools.mjs` — existing handler style. M-enhance tools follow same pattern.
11. `server/test-tcp-tools.mjs` — assertion style for new test additions.
12. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPGraphCommandlet.{h,cpp}` — Oracle-A's dev-only commandlet; 3F-4 production variant promotes/reuses this.
13. `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.{h,cpp}` + `MCPCommandRegistry.{h,cpp}` — M1 scaffolding your TCP handlers register with.

### Tier 4 — Tools.yaml
14. `tools.yaml` — add ~35 entries (D44 single-source-of-truth). 8 `remote-control` tools likely already there with `layer: http-30010` — update their status flags (no longer "Phase 4 later" — they ship now).

### Tier 5 — D-log
15. `docs/tracking/risks-and-decisions.md` — D23 (4-layer), D52 (near-parity), D53 (tool surface + category split), D58 (re-sequence), D59 (M1), D66 (FA-ε HYBRID).

---

## Success criteria

1. Plugin compiles cleanly with RemoteControl dep added; `UBT` exits 0; no warnings about plugin/.uplugin consistency.
2. `test-uemcp-gate.bat` [PASS] — D57 commandlet gate unchanged.
3. HTTP client in ConnectionManager returns valid response for one canned RC round-trip.
4. All 10 FULL-RC tools pass `test-rc-wire.mjs` assertions.
5. All 12 FULL-TCP tools pass `test-tcp-tools.mjs` assertions with plugin integration.
6. All 13 PARTIAL-RC tools dispatch correctly — RC-internal path returns when possible, TCP-fallback activates when RC-coverage is insufficient.
7. Cross-transport consistency tests green for PARTIAL-RC group.
8. Narrow sidecar JSON emitted on BP save (verify against `ProjectA\Content\Blueprints\Character\BP_OSPlayerR` edit).
9. 3F-4 commandlet produces full-sidecar JSON headless (not edge-only like Oracle-A).
10. Full test rotation green: prior-baseline + ~100-180 new. No regressions.
11. `tools.yaml` entries updated for all ~35 M-enhance tools + 8 absorbed `remote-control` primitives.
12. TOOLSET_TIPS updated for any cross-toolset workflow surfacing.
13. Path-limited commits per D49: `plugin/UEMCP/*`, `server/*`, `tools.yaml`, optional `docs/tracking/backlog.md` edit to mark ship-complete.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — scope: `plugin/UEMCP/Source/UEMCP/*`, `plugin/UEMCP/UEMCP.uplugin`, `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`, `server/connection-manager.mjs`, `server/tcp-tools.mjs`, new `server/rc-url-translator.mjs`, `server/test-tcp-tools.mjs`, new `server/test-rc-wire.mjs`, `tools.yaml`, `server/server.mjs` (tool registration). Surface before editing anything else.
- **`UEMCP_RC_PORT` env var** for RC port override; default 30010.
- **No AI attribution**.
- **Checkpoint commits per §8** — don't one-shot; 3-5 sessions demands staged commits.
- **UBT-stale-DLL awareness (D61)** — if plugin behavior doesn't match source after rebuild, nuke `Binaries/` + `Intermediate/` and re-Build.bat before iterating.
- **D60 awareness** — any new `IsRunningCommandlet()` or similar global check uses `CoreGlobals.h` free function, NOT FApp member.
- **Editor must be running** for TCP/RC integration tests — CI may need a skip sentinel for those.

---

## Biggest load-bearing unknowns

1. **RC URL-scheme translator complexity** — FA-ε §Q3 estimated 80 LOC. If object-path resolution (`/Game/.../Asset.ObjectName:CDO.Property` form) turns out to need more cases than anticipated (soft-referenced assets, subobjects), the translator grows. Surface if >50 distinct path patterns emerge.
2. **Cross-transport transaction semantics** — FA-ε §Open items (3). A write spanning RC `WRITE_TRANSACTION_ACCESS` + TCP `FScopedTransaction` needs verification that the two transaction surfaces compose. If they don't, some PARTIAL-RC tools may need TCP-only dispatch even for reads (to keep transaction scope consistent).
3. **UE 5.7 RC version-drift** — FA-ε §Q2.2 noted `SanitizeMetadata` allowlist may differ in 5.7. ProjectA is 5.6 so not blocking; flag in final report for S-B-overrides or M-enhance-5.7-port worker.
4. **PIE teardown race with TCP** — `stop_pie` may tear down world before handler returns; plugin-side needs explicit game-thread post-tick flush. Low-risk but known UE edge case.

---

## Final report to orchestrator

Report (under 400 words given scope):
1. Commit SHAs (multiple expected; 6 per §8 checkpoint minimum).
2. Transport split empirical — how many FULL-RC tools shipped as RC-only vs how many PARTIAL-RC tools actually used the TCP-fallback path in practice (discriminator data, not coverage table).
3. Narrow sidecar save-hook verification — measured write latency on BP_OSPlayerR save.
4. 3F-4 commandlet output delta vs Oracle-A (what fields Oracle-A dev variant omits that 3F-4 production emits).
5. Cross-transport transaction test results (§Q4 §Open items (3)).
6. UE 5.6 RC idiosyncrasies discovered beyond FA-ε §Q2 (e.g., object-path resolution edge cases, response-shape drift between endpoint versions).
7. Test baseline delta: pre → post (expected +100-180).
8. D-log amendments needed (D66 is likely sufficient; note if any empirical finding contradicts FA-ε §Q1).
9. Phase 4 removal — confirm no remaining references to standalone Phase 4 in backlog / docs / yaml.
10. Next action: M3 + M4 + M5 dispatchable (parallelizable with M-enhance's narrow-sidecar completion in §8 checkpoint 5 if orchestrator wants).

If you hit a structural blocker (RC server won't start on 30010 despite plugin enabled, UE 5.6 RC endpoints return different shapes than FA-ε §Q2 catalogued, plugin compile fails on RemoteControl dep add), surface within 1 session — don't burn past a session on a single unknown without a status check.
