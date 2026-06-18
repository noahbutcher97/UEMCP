# UEMCP limitations found during the Project A animation audit (2026-06-18)

Source: a read-only animation-systems audit of Project A (UE 5.6),
editor PID 76856, UEMCP editor identity verified. These are real frictions hit in one session,
written up so the plugin author can patch. Stable IDs `UEMCP-LIM-N`. Severity: P0 = blocked a
deliverable; P1 = forced a workaround; P2 = papercut.

Context note: the two P0 anim-readback gaps (LIM-1, LIM-2) directly produced "proof limits" in the
audit report -- montage slot routing and chooser per-row mapping could not be read at all, so a
load-bearing diagnosis ("AM_Block_Break selects+plays but not seen") had to stay a differential
instead of a confirmed root cause.

---

## P0 -- blocked crux readback

### UEMCP-LIM-1: get_montage_full / get_anim_sequence_info -> "Could not resolve class"
- Tools: `get_montage_full`, `get_anim_sequence_info` (toolset: animation, layer tcp-55558).
- Symptom (verbatim): `Error in get_montage_full: tcp-55558: Could not resolve class at
  '/Game/ProjectA/Animations/FighterKit/Blocks/AM_Block_Break_M_Retargeted1'`. Same for
  `get_anim_sequence_info` on `/Game/.../AS_Block_Break_M_Retargeted1`.
- Repro: editor running + identity verified; call `get_montage_full {asset_path: "<any *_Retargeted
  montage>"}`. Tried bare package path AND `Package.Object` form -- both fail. Fails on the SUSPECT
  montage AND a known-good one (`AM_Fighter_HitReact_Body`), so it is NOT asset-specific.
- Contradiction: `get_asset_info` on the exact same path succeeds and reports
  `objectClassName: /Script/Engine.AnimMontage` -- the class exists; the asset just is not loaded.
- Hypothesis: the tool resolves the UClass from an already-loaded object and never force-loads the
  asset (these retargeted assets were not loaded into the editor). Or the resolve keys off the wrong
  export.
- Fix: `LoadObject`/`StaticLoadObject` (or AssetRegistry-resolve + load) the asset before class
  resolution; on load failure return the load error, not the generic "could not resolve class".
- Impact: highest. Montage slot names, sections, additive flags were unreachable -> top proof limit.

### UEMCP-LIM-2: no Chooser-table readback (per-row key -> result)
- Tool gap: there is no chooser tool, and `read_asset_properties` on a `UChooserTable` returns
  `ResultsStructs` / `ColumnsStructs` / `ContextData` as
  `{unsupported, reason: "complex_element_container", inner_type: "InstancedStruct"}`.
- What IS readable on a chooser: `NestedChoosers` (names), `OutputObjectType`, `DisabledRows`,
  `ChooserPropertyNames` (also surfaces in `get_asset_info` tags). The per-row key->result mapping is
  NOT.
- Repro: `read_asset_properties {asset_path: "/Game/Data/ChooserTable/CT_HitReact_Block"}`.
- Workaround used: `get_asset_references` dependencies give the montage SET a chooser can select, but
  never which row/key selects which montage.
- Fix: add `get_chooser_table` that walks the `FChooserColumn` data + `FInstancedStruct` rows and emits
  `[{column_keys: {...}, result: <objpath>}]`. High value for any Chooser-driven selection system.

### UEMCP-LIM-3: read_asset_properties on a montage cannot reach SlotAnimTracks / SlotName
- Symptom: default export resolves to `AnimDataModel` (export_index 1), NOT the `UAnimMontage` export.
  `property_names: ["SlotAnimTracks","SlotName"]` returned `{}` (it only inspected AnimDataModel).
- Bonus bug: the `NumberOfFrames` it returns is not human-meaningful -- it returned `30000`
  (NumberOfKeys 30001) for a montage whose `get_asset_info` `SequenceLength` is `0.5` s. Off by ~3
  orders of magnitude vs frames; looks like raw internal tick/sampling.
- Repro: `read_asset_properties {asset_path: "/Game/.../AM_Block_Break_M_Retargeted1"}`.
- Fix: for `UAnimMontage`, select the montage export as primary (not the AnimDataModel subobject) and
  decode `SlotAnimTracks` (slot name + segment refs). Normalize or relabel the frame value (or replace
  with length-seconds).

### UEMCP-LIM-4: inspect_blueprint does not decode AnimGraph node properties
- Symptom: for an AnimBP it dumps the full export table (every `AnimGraphNode_Slot`,
  `AnimGraphNode_LayeredBoneBlend`, `AnimGraphNode_StateMachine` as rows) but NOT their properties --
  so you can COUNT nodes (e.g. 3 Slot + 6 LayeredBoneBlend in `ABP_DroppedCharacter`) but cannot read a
  slot's `SlotName` or a layered-blend's per-bone weights. That routing data is exactly what anim
  debugging needs.
- Repro: `inspect_blueprint {asset_path: "/Game/ProjectA/Blueprints/Character/ABP_DroppedCharacter"}`.
- Fix: decode `FAnimNode_Slot::SlotName` and `FAnimNode_LayeredBoneBlend` layer setup, or add a focused
  `get_anim_graph` tool (slots, state machines, blend nodes + their key props).

---

## P1 -- forced a workaround

### UEMCP-LIM-5: editor identity not auto-verified; only detect_project flips it
- Symptom: editor running (PID 76856); `connection_info` showed `editor.state: not_checked`,
  `http-30010: unknown`. Editor-backed tools returned `EDITOR_IDENTITY_UNKNOWN`. None of these verified
  identity: `refresh_project_context`, `enable_toolset`, or even
  `attach_project {from_running_editor: "<.uproject>"}` (set `source: running_editor` but left
  `editorIdentityState: not_checked`). ONLY `detect_project` set it to `verified`.
- Fix: lazily verify identity on the first editor-backed call, or add `attach_project {verify_editor:
  true}`. At minimum, make the `EDITOR_IDENTITY_UNKNOWN` error say "run detect_project to verify".

### UEMCP-LIM-6: query_asset_registry -- output overflow + no native-parent filter/field
- Symptom: `query_asset_registry {class_names: ["AnimBlueprint"]}` returned ~302 KB / 6342 lines ->
  overflowed and spilled to a temp file. And the result does NOT include each asset's NATIVE parent
  class -- grepping the dump for `OSAnimInstance` found nothing (parent lives in the import table, not
  registry tags), so it cannot answer "which AnimBP derives from native class X". Had to
  `inspect_blueprint` per asset (where `parentClass` IS present).
- Fix: server-side `limit` / `offset` / `name_pattern` params, and expose `native_parent_class` (or a
  `parent_class` filter) in the result.

### UEMCP-LIM-7: bp_list_graphs omits the AnimGraph for AnimBlueprints
- Symptom: on `ABP_DroppedCharacter` it returned `EventGraph` + 4 K2 function graphs only -- no
  AnimationGraph / state-machine sub-graphs. To see anim nodes I had to fall back to the raw
  `inspect_blueprint` export table.
- Fix: include the `AnimationGraph` (and sub-graphs / state-machine graphs) in graph enumeration for
  AnimBP assets.

---

## P2 -- papercuts

### UEMCP-LIM-8: parameter-name inconsistency / drift
- snake_case required, camelCase rejected: `read_asset_properties`, `get_asset_info`, `bp_list_graphs`,
  `get_asset_references`, `inspect_blueprint`, `get_montage_full`, `get_anim_sequence_info` all want
  `asset_path`; `assetPath` fails with `Required: asset_path`.
- `enable_toolset` wants `toolsets` (array), not `name` -> `Required: toolsets`.
- `get_montage_full` uses `asset_path`, but Project A's local agent handoff referenced it as `montage_path`
  (and called it "disconnected") -- doc/alias drift.
- Fix: accept camelCase aliases (or `montage_path`), or make the validation error name the tool +
  list the accepted keys.

---

## What worked well (do not regress)
- `get_asset_info` -- registry tags `Skeleton`, `SequenceLength`, `PreviewSkeletalMesh`,
  `AnimNotifyList`. Reliable; answered skeleton-match.
- `get_asset_references` -- dependencies + referencers. Excellent; mapped chooser->montage sets and
  found an asset's consumers. The backbone workaround for LIM-2.
- `read_asset_properties` on BP CDOs -- clean (ability `ReplicationPolicy`, `ActivationRequiredTags`,
  `bRetriggerInstancedAbility`, `RecoilMontage`). Only the montage case (LIM-3) is weak.

## Suggested priority
LIM-1 and LIM-2 would have removed the entire live-editor detour and the two headline proof limits in
the audit. LIM-3/LIM-4 are the natural follow-ons (slot routing). LIM-5 is the cheapest UX win.
