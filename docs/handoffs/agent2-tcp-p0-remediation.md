# Agent 2 Handoff — Track 1: TCP P0 Remediation (Server-Side Defensive Wraps)

## Who you are

You are a fresh implementer agent working on **UEMCP** (`D:\DevTools\UEMCP\`). This is a Node.js MCP server that bridges Claude to Unreal Engine 5.6 projects. Read `D:\DevTools\UEMCP\CLAUDE.md` first — full architecture, 4-layer model, code conventions.

You are Agent 2 of two parallel agents. Agent 3 is working Track 2 (offline tool expansion). File scopes do not overlap — don't touch `offline-tools.mjs`, `tools.yaml`, `server.mjs` tool registrations, `test-phase1.mjs`, or anything under `docs/research/` or `docs/specs/phase1.5-*`.

## Required reading before you code

1. `D:\DevTools\UEMCP\CLAUDE.md` — project overview, standards, testing conventions
2. `D:\DevTools\UEMCP\docs\audits\unrealmcp-comprehensive-audit-2026-04-12.md` — **SEALED audit**, P0 source of truth. Do not edit.
3. `D:\DevTools\UEMCP\docs\tracking\risks-and-decisions.md` — focus on **D23** (UnrealMCP plugin deprecated post-Phase 3 — this is why we don't patch C++) and **D33 revised 2026-04-13** (freshness model; relevant for understanding write-op→`assetCache.indexDirty` coupling even though you won't implement it)
4. `D:\DevTools\UEMCP\server\connection-manager.mjs` — existing TCP client with error normalization + mock seam
5. `D:\DevTools\UEMCP\server\tcp-tools.mjs` — TCP tool handlers (actors, blueprints-write, widgets)
6. `D:\DevTools\UEMCP\server\test-tcp-tools.mjs` and `test-helpers.mjs` — existing test infra

## Scope contract (locked — don't re-litigate)

Per D23, the existing UnrealMCP C++ plugin (TCP:55557) is being deprecated post-Phase 3. Rules:

- **IN SCOPE** — server-side defensive wraps in our Node layer to mitigate plugin misbehavior at the wire boundary
- **IN SCOPE** — expanded tests in `test-tcp-tools.mjs` using `FakeTcpResponder` / `ErrorTcpResponder`; extend `test-helpers.mjs` if you need new failure modes
- **IN SCOPE** — new doc at `docs/specs/phase3-plugin-design-inputs.md` capturing plugin-side P0s as **requirements for the Phase 3 custom plugin**
- **IN SCOPE** — D-log entry documenting the scope split
- **OUT OF SCOPE** — any edits to `D:\UnrealProjects\5.6\ProjectA\ProjectA\Plugins\UnrealMCP\` (C++). Don't touch, don't suggest touching.

## The 11 P0s (verbatim from the audit)

**P0-1: Error Response Format Inconsistency.** Three error formats coexist: Bridge envelope (`{"status":"error"}`), CommonUtils (`{"success":false}`), and UMG ad-hoc (`{"error":"msg"}` without status flag). The ad-hoc format passes through Bridge as "success" containing an error field.

**P0-2: Actor Lookup Uses GWorld Only.** Every actor command uses `UGameplayStatics::GetAllActorsOfClass(GWorld, ...)` — misses sublevels and streamed levels. Silent "not found" when actor exists in a different loaded level.

**P0-3: Actor Name-or-Label Resolution (D29).** Lookups use `Actor->GetName()` (FName like `BP_OSControlPoint_C_0`), but users see Outliner labels (`BP_OSControlPoint2`). No label field in responses.

**P0-4: SetObjectProperty Missing Vector/Struct/Object Support.** `set_actor_property` / `set_component_property` handle only Bool/Int/Float/String/Byte/Enum. Returns `"Unsupported property type: StructProperty"` for FVector, FRotator, FColor, FTransform, and all UObject references.

**P0-5: No Compile Error Reporting.** `compile_blueprint` returns `"compiled": true` unconditionally. Errors from `FKismetEditorUtilities::CompileBlueprint()` are discarded.

**P0-6: Graph Edits Have No Transaction Support.** No `FScopedTransaction` wrapping. Graph modifications can't be Ctrl+Z'd. Partial failures leave blueprint in broken state.

**P0-7: UMG Blueprint Path Loading Inconsistency.** Commands 1-3 load from `/Game/Widgets/<name>`, commands 4-6 load from `/Game/Widgets/<name>.<name>`. Widget created by command 1 can't be found by command 4.

**P0-8: `set_text_block_binding` Creates Invalid Graph (exec→data connection).** Connects Entry exec pin to GetVariable data pin. Missing `UK2Node_FunctionResult`. Compiles but binding fails at runtime.

**P0-9: Missing `params` Field Crashes Plugin.** Bridge calls `GetObjectField(TEXT("params"))` without null check. Omitting `params` from request crashes editor.

**P0-10: GetVectorFromJson / GetRotatorFromJson Silent Failures.** Returns `[0,0,0]` when array has wrong element count or field is missing. User's transform is silently zeroed.

**P0-11: No Pin Type Validation Before Connection.** `connect_blueprint_nodes` connects pins without checking type compatibility. Bool→Float silently created.

## Classification (locked by Noah — implement against this)

| P0 | Classification | Action |
|----|----|----|
| P0-1 | **server-patchable (full audit)** | Audit `connection-manager.mjs` against ALL THREE enumerated formats. Existing D24 check covers UMG ad-hoc partially — close any gap in coverage. Expand test coverage to exercise all three paths. |
| P0-2 | plugin-only | Document as Phase 3B input. |
| P0-3 | plugin-only | Document as Phase 3B input. |
| P0-4 | plugin-only | Document as Phase 3A infrastructure (INF-6, property-type handler registry). |
| P0-5 | plugin-only | Document as Phase 3C input. |
| P0-6 | plugin-only | Document as Phase 3C input. |
| P0-7 | **server-patchable partial** | Strip duplicate `.<name>` suffix in `tcp-tools.mjs` widget handlers before send. Fixes symptom. Plugin-side full fix documented as Phase 3D input. |
| P0-8 | plugin-only | Document as Phase 3D input. |
| P0-9 | **server-patchable** | Zod required-param validation before send. Plugin-side null-check still documented as Phase 3E input. |
| P0-10 | **server-patchable** | Client-side vector/rotator shape validation before send. Plugin-side bool-return documented as Phase 3A input (INF-2). |
| P0-11 | plugin-only | Document as Phase 3C input. |

If you disagree with any cell after reading the audit + existing code, raise it to Noah before coding — don't re-classify unilaterally.

## Deliverables

1. **Code in `server/connection-manager.mjs` + `server/tcp-tools.mjs`** for P0-1, P0-7, P0-9, P0-10. Functions under 50 lines; early-return on validation failure; comment intent not implementation.
2. **Tests in `server/test-tcp-tools.mjs`** — every new wrap gets happy-path + failure-path assertion. Extend `test-helpers.mjs` for new failure modes.
3. **New design-inputs doc** at `D:\DevTools\UEMCP\docs\specs\phase3-plugin-design-inputs.md`. For each plugin-only P0 (and the plugin-side residue of partial-server P0s), write:
   - (a) current plugin behavior
   - (b) required Phase 3 custom plugin behavior
   - (c) wire-protocol implications (if any)
   - (d) test case that would prove it fixed
   - (e) Phase 3 subsystem bucket (3A core infra / 3B actor / 3C blueprint / 3D UMG / 3E protocol per the audit's §"Implementation Priority Order")
4. **D-log entry** (D35; D34 already written by orchestrator documenting two-track dispatch) in `docs/tracking/risks-and-decisions.md`: "Server defends at wire boundary; Phase 3 plugin design absorbs plugin-side P0s; UnrealMCP C++ untouched per D23."
5. **No audit edits.** If you find a 12th issue, amend per the blockquote pattern in `docs/audits/offline-tool-expansion-audit-2026-04-13.md` §7.2.

## Testing

Baseline all three green first:

```
cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-phase1.mjs
cd /d D:\DevTools\UEMCP\server && node test-mock-seam.mjs
cd /d D:\DevTools\UEMCP\server && node test-tcp-tools.mjs
```

(CMD: no space before `&&`.) All three green post-changes. Report new assertion count on `test-tcp-tools.mjs`.

## Working style

- Direct communication; Noah prefers criticism over compliments. No "Great question!" prefaces.
- YAGNI — don't scaffold beyond the 11 P0s.
- Never add AI attribution to commits, docs, or code comments.
- CMD shell (not PowerShell). Desktop Commander's bash for multi-step.
- Genuine ambiguity → stop and ask Noah.

## Done criteria

- All 4 server-patchable P0s implemented + tested (P0-1 full, P0-7 partial, P0-9, P0-10)
- `phase3-plugin-design-inputs.md` committed with all 7 plugin-only P0s + residues specified per 5-field template
- D-log updated
- All three test suites green; new assertion count on `test-tcp-tools.mjs` stated in final summary
- Final summary to Noah: diff overview, new assertion count, any Phase 3 design questions surfaced
