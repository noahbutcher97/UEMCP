# Live Usage Follow-On Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the 2026-06-18 live-project field reports into an ordered branch queue where every reported limitation has a direct follow-on owner and verification gate.

**Architecture:** Ship this as independent branches from current `main`, not as one large parser rewrite. D183 restores broken shipped behavior and hardens the call path; D184-D189 are direct follow-ons for graph literals, property/export fidelity, reverse references, animation/chooser readback, metadata/linting, and final live validation.

**Tech Stack:** Node.js ES modules, Zod, MCP SDK tool registration, `tools.yaml`, UE 5.6 C++ editor plugin handlers, PowerShell verification, opt-in live editor smoke.

## Global Constraints

- Preserve the agent-authored reports under `docs/reports/`, `docs/audits/`, and `docs/tracking/` as source evidence.
- Do not regress the good surfaces called out in the reports: offline availability, reason-code honesty, `inspect_blueprint.parentClass`, `find_blueprint_nodes` member resolution, `get_asset_info`, `get_asset_references`, `bp_list_graphs`, and `bp_list_entry_points`.
- Each branch starts from updated `main`, carries focused tests, and can merge independently.
- Add failing tests before production code for every behavior change.
- For plugin C++ changes, close the editor, sync the plugin into a target project, run Unreal `Build.bat`, relaunch editor, restart MCP, and run the opt-in live smoke relevant to the changed toolset.
- Every deploy-visible plugin C++ change must bump both `manifest.json` and `plugin/UEMCP/UEMCP.uplugin`, then run `node server/test-verify-deploy.mjs` and `verify-deploy.bat --no-pause`.
- Keep response contracts explicit: distinguish unavailable, unknown, unsupported, present-but-default, present-but-undecoded, and parser-failed states.
- Do not infer unobserved defaults from disk bytes. If a value is inherited, native-only, editor-only, or runtime-only, label that state explicitly.
- Keep branch staging narrow. Do not stage `.semgrep/` or unrelated agent-authored report edits unless the current branch explicitly owns them.
- Keep docs ASCII-clean.

---

## File Structure

- `server/menhance-tcp-tools.mjs`: live read-tool schemas and wire routing for M-enhance surfaces such as `get_montage_full`, `get_anim_sequence_info`, `get_asset_references`, and `bp_show_node`-adjacent surfaces.
- `server/m5-animation-tools.mjs`: animation mutation schemas; do not duplicate read handlers here unless the branch deliberately moves animation reads out of M-enhance.
- `server/create-uemcp-server.mjs`: dynamic tool registration, strict input validation, project-context guards, and user-facing error envelopes.
- `server/zod-builder.mjs`: YAML-to-Zod schema generation for offline tools.
- `server/project-context.mjs`: attachment, editor identity, and readiness diagnostics.
- `server/project-tools.mjs`: management tool input shapes and output shapes.
- `server/offline-tools.mjs`: `query_asset_registry`, `read_asset_properties`, Blueprint graph tools, export/property decoding, and offline parser helpers.
- `server/tool-index.mjs` and `server/toolset-manager.mjs`: discoverability, initially-visible tool handling, and find-tools workflow.
- `server/test-*.mjs`: focused wire, parser, registry, project-context, and routing tests.
- `tools.yaml`: source of truth for tool descriptions, params, aliases, tool metadata, discoverability, and fallback notes.
- `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`: live montage and animation asset reads/mutations.
- `plugin/UEMCP/Source/UEMCP/Private/ReflectionWalker.cpp`: generic class reflection; should not be used as an asset-instance reader for montages/sequences.
- `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp`: `get_asset_references` and editor-state utilities.
- `plugin/UEMCP/Source/UEMCP/Private/Tests/`: C++ automation coverage when a plugin behavior is not provable from Node routing tests alone.
- `manifest.json` and `plugin/UEMCP/UEMCP.uplugin`: deploy-visible version metadata for plugin C++ changes.
- `docs/reports/`, `docs/audits/`, `docs/tracking/`: field-report evidence and backlog cross-links.

---

## Execution Protocol

Each branch starts with these checks before implementation:

- [ ] **Refresh branch state**

Run:
```powershell
git status --short --branch
git fetch origin
git status --short --branch
```

Expected: branch is based on current `origin/main`; unrelated working-tree changes are identified and left untouched.

- [ ] **Reproduce or pin the reported symptom**

For server-only behavior, write a failing unit/wire test first. For live editor behavior, record a focused pre-fix repro if the editor is available; if not, add a fake TCP or parser fixture proving the server-side contract and mark live repro as gated.

- [ ] **Choose the split rule before coding**

If a branch touches both plugin C++ and broad server validation, commit in separate reviewed chunks. If either chunk grows beyond its acceptance criteria, split into `D###-A` and `D###-B` rather than carrying unrelated risk in one PR.

- [ ] **Run the relevant narrow test before the full rotation**

Every branch must run the focused test listed under its verification commands before `npm test`.

- [ ] **Document residuals immediately**

If empirical data disproves a planned implementation path, update this plan or create a residual backlog item in the same branch. Do not leave a report item silently half-addressed.

---

## Assurance And Rollback Checkpoints

Every implementation branch must pass these checkpoints before it is considered ready for merge. These gates are intentionally separate from the branch-specific verification commands so reviewers can tell whether the work was tested, self-reviewed, independently audited, source-verified, and safely revertible.

### Checkpoint 1: Baseline And Rollback Anchor

- [ ] **Record the starting point**

Run:
```powershell
git status --short --branch
git log --oneline -1
git rev-parse HEAD
```

Expected: branch point is known, unowned working-tree files are listed, and no unrelated files are staged.

- [ ] **Plan rollback before editing**

Write the intended rollback unit in the branch notes or PR body. Use atomic green commits as rollback boundaries. If a later checkpoint fails and the fix is not narrow, use `git revert <commit>` to back out the last completed unit; do not use `git reset --hard` or overwrite unowned work.

### Checkpoint 2: Self-Test Ladder

- [ ] **Red test or pinned repro**

Before production code, create a failing test or record a live repro for the reported behavior. If live repro is impossible in the current environment, mark it as `LIVE-GATED` and add a fake TCP, parser, or fixture test that pins the server-side contract.

- [ ] **Narrow green**

Run the branch-specific narrow test listed under that branch's **Verification Commands**. The narrow test must fail before the implementation when practical and pass after the implementation.

- [ ] **Rotation green**

Run `cd server; npm test` after narrow tests pass. If the branch changes plugin C++, also run `cd server; node test-verify-deploy.mjs`, `verify-deploy.bat --no-pause`, the target-project Unreal build, editor relaunch, MCP restart, and the relevant opt-in live smoke.

- [ ] **Evidence table**

Record each command, expected result, actual result, and artifact path in the PR body or branch report. A summary sentence without command evidence is not enough.

### Checkpoint 3: Self-Review

- [ ] **Diff ownership review**

Run:
```powershell
git diff --name-status origin/main...HEAD
git diff --check
```

Expected: only files owned by the branch scope changed, whitespace checks pass, and untracked local artifacts such as `.semgrep/` are not staged unless explicitly owned.

- [ ] **Contract review**

Review response shapes, error codes, aliases, payload-size defaults, cache behavior, and docs against `tools.yaml`. Confirm the branch does not overclaim offline fidelity, inherited defaults, runtime-only values, or editor-only behavior.

- [ ] **Regression review**

Check the "what worked well" sections in the four field reports and explicitly confirm they still pass or remain untouched: reason-code honesty, offline lane availability, `inspect_blueprint` parent/generated class output, `find_blueprint_nodes` member resolution, `get_asset_info`, `get_asset_references`, `bp_list_graphs`, and `bp_list_entry_points`.

### Checkpoint 4: Independent Audit

- [ ] **Fresh read-only review**

Before merge, run a separate read-only audit of the branch diff. Preferred path: use a fresh subagent or `superpowers:requesting-code-review` to review the diff for behavior bugs, missing tests, schema drift, and overbroad scope. Fallback path: do a manual review pass in a fresh context and save notes in the PR body.

- [ ] **Audit disposition**

Every audit finding must be classified as fixed, intentionally deferred with a named residual item, or rejected with evidence. Do not merge with unresolved audit notes hidden in chat context.

### Checkpoint 5: Research Verification

- [ ] **Primary-source check for external contracts**

When a branch relies on Unreal Engine API behavior, MCP SDK behavior, Zod behavior, AssetRegistry data layout, or file-format assumptions, verify against primary sources before coding or before finalizing the implementation. Preferred sources: local UE 5.6 engine headers/source, official package docs, official protocol docs, or the repository's existing tests. Blog posts and forum answers can inform hypotheses but cannot be the final citation for behavior.

- [ ] **Record source evidence**

Record exact source paths, doc URLs, versions, and access dates in the branch report or PR body. For local engine/source evidence, cite file path and symbol name. For web docs, cite the official URL and date checked.

- [ ] **Empirical fallback**

If primary documentation is missing or ambiguous, add an empirical fixture/test and label the claim as empirically verified for UE 5.6 / this repo, not as a universal engine guarantee.

### Checkpoint 6: Rollback Commit Discipline

- [ ] **Atomic commit sequence**

Use small green commits that can be reverted independently. Preferred commit units: failing-test/repro fixture plus implementation, server validation/alias change, plugin C++ change plus version bump, registry/docs update, live-smoke closure.

- [ ] **Rollback check before final**

Run:
```powershell
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: each commit has one coherent purpose and a reviewer can revert a risky unit without removing unrelated fixes.

---

## Coverage Matrix

| Report item | Owning branch | Closure condition |
|---|---|---|
| VFX P1, AssetRef Issue 2, LIM-8 param drift, Audio P3-1/P3-2 | D183, D189 | Unknown params reject or normalize with explicit accepted-key diagnostics; aliases are finite and tested. |
| VFX P2, Audio P2-2/P2-3 | D185, D186 | Export listing exists; requested properties get explicit default/not-found/undecoded markers; nested subobjects are opt-in and bounded. |
| VFX P3, AssetRef Issues 1/4/6 | D187 | Reverse references are discoverable; offline reverse-ref support works or returns a truthful live-fallback reason; `get_asset_info` no longer implies reverse referencers. |
| VFX P4 | D186 | CDO, SCS component templates, and graph spawn/reference summaries are either unified or documented as a tested recipe. |
| VFX P5 | D184 | MakeStruct/BreakStruct coverage and data-flow follow-up path exist; exec/data trace expectations remain explicit. |
| VFX P6, AssetRef Issue 5, LIM-8, Audio P3-x | D183, D189 | Common aliases and validation errors are consistent across management, offline, and live tools. |
| VFX P7 | D189 | Tool metadata exposes editor requirement and offline fidelity before use. |
| LIM-1, Audio P0-1 | D183 | Montage and sequence reads load asset instances and return domain data instead of class-resolution errors. |
| LIM-2 | D188 | Chooser row/result readback works or returns precise unsupported markers with live/offline lane guidance. |
| LIM-3 | D183, D188 | Montage primary export and slot-track readback are correct; misleading frame values are normalized or relabeled. |
| LIM-4, LIM-7 | D184, D188 | AnimBP graph enumeration and key AnimGraph node properties are surfaced or explicitly marked undecoded. |
| LIM-5, AssetRef Issue 3, Audio P1-1 | D183 | Live tool identity errors are actionable, and first live-read/refresh paths probe identity when safe. |
| LIM-6 | D187 | `query_asset_registry` has bounded output plus native-parent field/filter when empirically available. |
| Final proof | D190 | Closure report maps every row above to commit evidence, test output, live smoke, or a residual item. |

---

## Direct Follow-On Queue

### D183: Restore Montage/Sequence Reads And Harden Tool Inputs

**Purpose:** Fix the highest-confidence broken shipped behavior and the cross-cutting silent-argument footgun.

**Files:**
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `server/create-uemcp-server.mjs`
- Modify: `server/zod-builder.mjs`
- Modify: `server/project-context.mjs`
- Modify: `server/project-tools.mjs`
- Modify: `server/test-tcp-tools.mjs`
- Modify: `server/test-mcp-wire.mjs`
- Modify: `server/test-project-server-wire.mjs`
- Modify: `server/test-project-tools.mjs`
- Modify: `tools.yaml`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`
- Modify on plugin C++ change: `manifest.json`
- Modify on plugin C++ change: `plugin/UEMCP/UEMCP.uplugin`
- Test as needed: `plugin/UEMCP/Source/UEMCP/Private/Tests/*`

**Scope:**
- `get_montage_full` loads a `UAnimMontage` asset instance, not a `UClass` via `reflection_walk`.
- `get_anim_sequence_info` loads a `UAnimSequence` asset instance, not a `UClass` via `reflection_walk`.
- Dynamic tool calls reject unknown params instead of stripping them.
- Add targeted aliases only where field reports show repeated user-agent drift: `assetPath -> asset_path`, `projectRoot -> project_root`, `path -> path_prefix` for `query_asset_registry`, `montage_path -> asset_path` for `get_montage_full`, and bare-string `enable_toolset` only if it can be normalized before validation without hiding invalid objects.
- Alias normalization must happen before strict validation and must not bypass path/root safety checks.
- `EDITOR_IDENTITY_UNKNOWN` tells callers the concrete recovery path: run `detect_project` or `connection_info({force_reconnect:true})`, then retry the live tool.
- Prefer a safe non-mutating identity probe on first live-read failure, `refresh_project_context`, and `enable_toolset` when a project is attached and tcp-55558 is reachable. If probing cannot be made safe in the branch, ship actionable remediation in the error payload and leave lazy probing as an explicit residual.
- `query_asset_registry` rejects referencer-looking params with a hint to `get_asset_references`.
- `attach_project` unknown-key errors list accepted source params: `project_root`, `uproject_path`, `from_running_editor`, and `target`.

**Acceptance:**
- `get_montage_full` returns montage sections, notifies, slot tracks, skeleton, blend settings that are available from `UAnimMontage`, and clear unsupported markers for runtime-only fields.
- `get_anim_sequence_info` returns duration, frame count/rate, skeleton, notify summary, curve/sync-marker summary where available.
- `query_asset_registry({ path: "/Game/X" })` either aliases to `path_prefix` with an explicit `normalized_args` echo or fails with an unknown-param error that names `path_prefix`.
- `query_asset_registry({ referencers: "/Game/X" })` fails with a hint to `get_asset_references`.
- Unknown params no longer silently widen query scope.
- `attach_project({ projectRoot: "..." })` either normalizes to `project_root` or fails with `UNKNOWN_PARAMETER`-style diagnostics, not `PROJECT_PATH_INVALID` with empty sources.
- `enable_toolset({ toolsets: "animation" })` is either normalized to `["animation"]` or fails with an error that names the accepted array shape and examples.
- A live-read call that cannot verify identity returns `next` guidance naming `detect_project`; if lazy probing ships, the same scenario succeeds after the probe when the editor matches the attached project.
- Existing MCP wire coercions for stringified booleans, numbers, arrays, and objects still pass.

**Verification Commands:**
- `cd server; npm test`
- `cd server; node test-tcp-tools.mjs`
- `cd server; node test-mcp-wire.mjs`
- `cd server; node test-project-server-wire.mjs`
- After plugin C++ changes: `cd server; node test-verify-deploy.mjs`, `verify-deploy.bat --no-pause`, target-project Unreal build, editor relaunch, MCP restart, and an opt-in live call against at least one known montage and one known anim sequence.

**Split Rule:** If strict validation touches more than management + schema utilities + one representative dynamic group, split validation into `D183-B` after landing montage/sequence restoration as `D183-A`.

**Commit Boundary:** One branch and PR unless the split rule fires. Do not include deep `read_asset_properties` parser work here.

### D184: Blueprint Graph Literal Readback

**Purpose:** Make graph inspection trustworthy for unlinked literal pins and AnimBlueprint graph discovery.

**Files:**
- Modify: `server/offline-tools.mjs`
- Modify: `server/test-verb-surface.mjs`
- Modify: `server/test-phase1.mjs`
- Modify: `tools.yaml`

**Scope:**
- Extend `bp_show_node.pins[]` with pin-default literals when present in the serialized pin block: `default_value`, `default_object`, `default_text_value`, and `autogenerated_default_value`.
- Preserve existing `pin_id`, `name`, `direction`, `pin_kind`, and `linked_to` fields.
- Add `available_fields` / `not_available` markers that distinguish topology present but default literals absent from parser inability.
- Fix `bp_list_graphs` omission of AnimGraph graphs for AnimBlueprints if the current graph indexer filters them out.
- Graduate `find_blueprint_nodes` coverage for `K2Node_MakeStruct` and `K2Node_BreakStruct`, with member/struct identity when recoverable.
- Confirm whether literal pin data is already present in the parsed topology before changing binary parsing. If not present, add a focused parser fixture before changing `shapePublicPin`.
- Keep NodeGuid graph-scoping invariants intact; do not cross-scan sibling graphs to fill pin data.

**Acceptance:**
- A fixture node with an unlinked literal pin returns the literal on that pin.
- Existing topology-only tests still pass.
- AnimBlueprint graph enumeration includes AnimGraph when present.
- MakeStruct/BreakStruct nodes are returned or explicitly counted with a reason if the parser cannot yet decode the required identity.
- A pin with no serialized literal emits an absent/default marker, not a misleading null object path.

**Verification Commands:**
- `cd server; node test-verb-surface.mjs`
- `cd server; node test-phase1.mjs`
- `cd server; npm test`

**Commit Boundary:** One branch and PR. Do not add export recursion or GE decoding here.

### D185: Export Listing And Requested-Default Property Semantics

**Purpose:** Remove false-negative ambiguity when callers ask for a property or export that exists but is not serialized as an override.

**Files:**
- Modify: `server/offline-tools.mjs`
- Modify: `server/test-phase1.mjs`
- Modify: `server/test-uasset-parser.mjs`
- Modify: `tools.yaml`

**Scope:**
- Add a first-class export listing path, either `list_asset_exports` or `read_asset_properties({ list_exports: true })`; prefer a separate tool if the response shape would otherwise overload `read_asset_properties`.
- When `property_names` is supplied, return an explicit per-request marker for missing serialized values: `present_default_unknown`, `not_serialized_default`, or `property_not_found`, based on what the parser can actually prove.
- Keep the current behavior for unfiltered reads unless the new markers are clearly backward-compatible.
- Document that disk reads expose serialized overrides and parser-supported defaults, not arbitrary inherited C++ class defaults.
- Reconcile any stale `include_defaults` wording in `read_asset_properties` docs/schema so callers do not see a documented but unavailable parameter.
- For montage assets, make the offline default export selection truthful: either select the `UAnimMontage` export when available or explain why `AnimDataModel`/notify export was selected.

**Acceptance:**
- Callers can enumerate exports before choosing `export_name`.
- A requested property omitted from serialized bytes no longer disappears silently.
- The response distinguishes "not found" from "not serialized here."
- Existing filtered `unsupported[]` scoping remains intact.
- `read_asset_properties({ property_names: [...] })` returns a row or marker for every requested property name.

**Verification Commands:**
- `cd server; node test-phase1.mjs`
- `cd server; node test-uasset-parser.mjs`
- `cd server; npm test`

**Commit Boundary:** One branch and PR. Do not recurse nested subobjects yet.

### D186: Nested Subobjects, GE Components, And Component Collision Readback

**Purpose:** Make `read_asset_properties` usable for modern component-heavy assets without overclaiming parser fidelity.

**Files:**
- Modify: `server/offline-tools.mjs`
- Modify: `server/test-phase1.mjs`
- Modify: `server/test-uasset-parser.mjs`
- Modify: `tools.yaml`
- Add fixtures only if needed under the existing server fixture pattern.

**Scope:**
- Add opt-in nested export traversal such as `include_subobjects` with a conservative depth cap.
- Decode common component subobject references enough to expose class, export name, outer, and readable serialized properties.
- Add specific coverage for GameplayEffect component/cue structures that blocked the VFX audit, including `FGameplayEffectCue` where byte layout is empirically proven.
- Add per-component collision response visibility for component templates when serialized data exists.
- Return `present_but_undecoded` for reachable nested data that exists but cannot be decoded.
- Add a BP runtime reference/spawn summary or documented recipe that unions CDO properties, SCS component template asset references, and graph `SpawnSystem*`/equivalent call nodes.
- Keep recursive traversal opt-in and byte-budgeted; nested reads must not change default response size.

**Acceptance:**
- A GameplayEffect with component/cue subobjects surfaces cue tags or marks them `present_but_undecoded`.
- Component templates expose collision settings when serialized.
- A BP with a Niagara component template and a graph spawn call can be audited without raw byte-grep.
- Nested traversal is opt-in and bounded.
- Existing top-level `read_asset_properties` responses do not balloon unexpectedly.

**Verification Commands:**
- `cd server; node test-phase1.mjs`
- `cd server; node test-uasset-parser.mjs`
- `cd server; npm test`

**Split Rule:** If nested traversal, GE decoding, collision responses, and spawn-summary work do not share one parser change, split into `D186-A include_subobjects`, `D186-B GE/cue decode`, and `D186-C component collision/spawn summary`.

**Commit Boundary:** One branch and PR unless the split rule fires.

### D187: Reverse References And Asset-Registry Discoverability

**Purpose:** Make "what references this asset" discoverable and available in the right lane.

**Files:**
- Modify: `server/tool-index.mjs`
- Modify: `server/toolset-manager.mjs`
- Modify: `server/offline-tools.mjs`
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `server/test-phase1.mjs`
- Modify: `server/test-query-asset-registry.mjs`
- Modify: `server/test-project-server-wire.mjs`
- Modify: `tools.yaml`

**Scope:**
- Surface `get_asset_references` earlier for reverse-dependency intent, either as initially visible when tcp-55558 is available or through stronger `find_tools` routing.
- Add explicit `query_asset_registry` description and runtime hint: it is a bulk class/path/tag scan, not a reverse-referencer.
- Add output bounds or projection mode for `query_asset_registry` to prevent large default payloads.
- Add native-parent tag/filter support if the asset registry metadata already exposes it.
- Add or reject `class_names` plural intentionally. If supported, normalize a one-element array to `class_name`; if rejected, the error must name `class_name`.
- Tighten `get_asset_info` wording so it says forward header metadata/import-export counts and points reverse-dependency users to `get_asset_references`.
- Require at least one narrowing filter for high-volume `query_asset_registry` calls, or lower the default interactive page size and emit a narrowing hint.
- Design and implement an offline reverse-reference path only if `AssetRegistry.bin` dependency records can be read empirically from target assets; otherwise ship a truthful `offline_unavailable` reason and keep the live `get_asset_references` path first-class.

**Acceptance:**
- A "who references X" query through `find_tools` ranks `get_asset_references` first.
- `query_asset_registry` no longer emits a giant project-wide payload for a mistaken referencer query.
- `get_asset_info` no longer implies it returns referencers.
- `query_asset_registry({ class_names: ["AnimBlueprint"] })` is either accepted with a normalization echo or rejected with a precise `class_name` correction.
- `query_asset_registry` can answer or explicitly cannot answer "which AnimBP derives from native class X"; no silent 300 KB dump is acceptable.
- Offline reverse-reference either works from parsed registry data or fails with an explicit reason that names the live fallback.

**Verification Commands:**
- `cd server; node test-phase1.mjs`
- `cd server; node test-query-asset-registry.mjs`
- `cd server; node test-project-server-wire.mjs`
- `cd server; npm test`

**Commit Boundary:** One branch and PR. Do not add raw binary grep as the primary implementation.

### D188: Animation, Chooser, And AnimGraph Deep Readback

**Purpose:** Close the remaining animation-audit proof limits after D183 restores the broken live reads.

**Files:**
- Modify: `server/offline-tools.mjs`
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `server/test-tcp-tools.mjs`
- Modify: `server/test-phase1.mjs`
- Modify: `tools.yaml`
- Modify if live path is required: `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`

**Scope:**
- Add chooser table readback for per-row key/result visibility, either offline when `InstancedStruct` layout can be decoded or live when the editor can expose rows safely.
- Ensure montage reads expose `SlotAnimTracks` and do not accidentally select `AnimDataModel` as the primary export in offline fallbacks.
- Decode AnimGraph node details needed by the reports, especially SlotName and blend weights, when serialized data makes those fields reachable.
- Normalize or relabel misleading animation frame/tick values, including the `NumberOfFrames`/`NumberOfKeys` confusion reported for short montages.
- Keep runtime-evaluated animation behavior marked live-only or unsupported; do not infer runtime blend output from disk.

**Acceptance:**
- A chooser table can show which montages or assets a row can select, or returns a precise unsupported reason.
- Montage slot names and track segments are readable through the intended montage tool.
- AnimGraph SlotName/blend-weight fields are surfaced or marked `present_but_undecoded`.
- Time/frame fields are named with units and do not imply human frame counts when they are internal keys/ticks.

**Verification Commands:**
- `cd server; node test-tcp-tools.mjs`
- `cd server; node test-phase1.mjs`
- `cd server; npm test`
- If plugin C++ changes: target-project build, relaunch editor, and live smoke against one chooser, one montage, and one AnimBlueprint.

**Commit Boundary:** One branch and PR. Split chooser into D188-B if its empirical layout differs from AnimGraph work.

### D189: Tool Metadata, Schema Lint, And Ergonomic Alias Parity

**Purpose:** Prevent this class of drift from returning and make tool capability limits visible before use.

**Files:**
- Modify: `tools.yaml`
- Modify: `server/zod-builder.mjs`
- Modify: `server/create-uemcp-server.mjs`
- Modify: `server/test-tool-registry-truth.mjs`
- Modify: `server/test-mcp-wire.mjs`
- Add: `server/test-tool-param-lint.mjs`
- Modify: `server/run-rotation.mjs`

**Scope:**
- Add registry metadata for `requires_editor`, `offline_fidelity`, `mutates_asset`, `mutates_level`, `saves_asset`, and `offline_fallback` where missing or stale.
- Add a param-lint test that compares `tools.yaml` param declarations with server handler access for offline tools and any schema-backed live tools where static analysis is reliable.
- Keep aliases intentional and finite; do not accept arbitrary camelCase for every param if it would hide wrong tool selection.
- Add tests proving unknown-param rejection still catches typos after aliases normalize known drift.
- Add a registry-truth check that active tool descriptions do not claim replaced/superseded functionality.
- Ensure metadata changes reflect shipped behavior from D183-D188, not intended future behavior.

**Acceptance:**
- The rotation fails when a tool reads an undeclared param or advertises a stale param.
- Tool descriptions expose editor/offline fidelity without forcing callers to learn it by failure.
- Aliases normalize known high-friction names but still reject unrelated unknown keys.
- The lint does not fail on deliberate dynamic params without an explicit allowlist entry and reason.

**Verification Commands:**
- `cd server; node test-tool-registry-truth.mjs`
- `cd server; node test-mcp-wire.mjs`
- `cd server; node test-tool-param-lint.mjs`
- `cd server; npm test`

**Commit Boundary:** One branch and PR after D183-D188, so metadata reflects final behavior instead of desired behavior.

### D190: Full Live Smoke And Report Closure

**Purpose:** Prove the follow-on queue solved the field-report failures in a real project, then close the tracking loop.

**Files:**
- Modify: `docs/tracking/backlog.md`
- Add or modify: `docs/reports/live-usage-follow-on-closure-2026-06-18.md`
- Modify live smoke scripts only if the existing smoke suite lacks coverage for the fixed tools.

**Scope:**
- Run a live smoke in Project A or another target project with UEMCP synced and editor restarted.
- Reproduce each original report symptom and record new behavior.
- Update EN-8 and the dated reports with closure links instead of deleting evidence.
- Keep any remaining unsolved edge case as a new explicit backlog item with reproduction and owner.
- Build a row-by-row closure table from the Coverage Matrix and the four report files. Each row must cite the closing branch or residual item.

**Acceptance:**
- Every item from the four agent reports is either closed by branch evidence or moved to a named residual item.
- Closure report includes exact commands, project path, editor/process state, commit SHAs, and pass/fail table.
- No report claim relies only on memory or prose.
- Reports keep their original evidence intact; closure links are additive.

**Verification Commands:**
- `verify-deploy.bat`
- `smoke-live.bat` with `UEMCP_LIVE_SMOKE=1`
- Focused MCP calls for `get_montage_full`, `get_anim_sequence_info`, `bp_show_node`, `read_asset_properties`, `query_asset_registry`, and `get_asset_references`

**Commit Boundary:** Final docs/validation branch after D183-D189 have merged.

---

## Self-Review

- Spec coverage: all field-report issues have direct branches: montage/sequence breakage in D183; strict params and identity guidance in D183/D189; `bp_show_node` literals and graph coverage in D184; export/default semantics in D185; nested GE/component/collision reads in D186; reverse references and registry output bounds in D187; chooser/montage/AnimGraph deep readback in D188; metadata/lint prevention in D189; live proof and closure in D190.
- Placeholder scan: no red-flag placeholder entries.
- Type consistency: branch names D183-D190 are sequential and every branch has scope, files, acceptance, verification, and commit boundary.
- Gap hardening pass: added preflight/repro gates, split rules for oversized branches, plugin version/deploy gates, explicit report-to-branch coverage, `get_asset_info` doc drift ownership, `class_names` handling, stale `include_defaults` reconciliation, frame-unit labeling, branch staging constraints, and row-by-row closure requirements.
