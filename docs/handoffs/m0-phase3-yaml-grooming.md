# M0 Worker — Phase 3 yaml grooming

> **Dispatch**: Fresh Claude Code session.
> **Type**: Implementation — yaml edits only. NO handler changes, NO test changes.
> **Duration**: ~0.5 session (30-45 min).
> **D-log anchors**: D53 (scope-refinement), D54 (DR-3 resolution), D55 (S-B verdict), D56 (widget-blueprint SPLIT), D51 (yaml dual-role — preserve).
> **Deliverable**: Updated `tools.yaml` + path-limited commit.

---

## Mission

Apply the Phase 3 scope-refresh Q1 dispositions to `tools.yaml`. This is the first concrete implementation step following the scope-refresh research (commit `9e9dbe5`).

**Three edit classes**:

1. **DROP (6 tools)** — remove entry entirely from yaml. Tool is fully displaced by shipped offline surface.
2. **MOVE-TO-SIDECAR (2 full + 1 split)** — remove entry entirely from yaml (MOVE cases); split the SPLIT case. These tools are absorbed by the 3F sidecar milestone (M2-Phase-A), not by a dedicated plugin-TCP tool.
3. **KEEP (reduced) annotation** — add `displaced_by:` + `reduced_scope:` YAML COMMENTS above each of the 18 KEEP (reduced) entries, so future agents can trace displacement lineage.

Preserve all other planning stubs per D51. No edits to shipped-toolset entries (offline, actors, blueprints-write, widgets) — those are D44-invariant-locked.

---

## Source of truth

Work from `docs/research/phase3-scope-refresh-2026-04-20.md` (commit `9e9dbe5`), specifically **§Q1.1 through §Q1.11**. Every disposition is in that table. Do not re-derive dispositions — the research already did the work.

**Verification before starting**: `git log --oneline -5` should show `ad21602` (D-log + backlog) at HEAD. If not, rebase forward to include D53-D56 before editing.

---

## §1 — DROP list (6 tools)

Remove these yaml entries entirely (delete the key + its sub-tree):

| Toolset | Tool | §Q1 source |
|---------|------|------------|
| `gas` | `list_gameplay_tags_runtime` | §Q1.1 |
| `blueprint-read` | (none — 2 are MOVE-TO-SIDECAR + 1 SPLIT; no DROP here) | — |
| `asset-registry` | `search_assets` | §Q1.3 |
| `asset-registry` | `get_class_hierarchy` | §Q1.3 |
| `asset-registry` | `get_asset_metadata` | §Q1.3 |
| `data-assets` | `get_data_asset_properties` | §Q1.6 |
| `editor-utility` | `create_asset` | §Q1.9 |

After DROP, each affected toolset's `tools:` list is shorter by 1. No other structural changes.

---

## §2 — MOVE-TO-SIDECAR list (2 full + 1 SPLIT)

### §2.1 Full MOVE (remove from yaml)

| Toolset | Tool | §Q1 source | Note |
|---------|------|------------|------|
| `blueprint-read` | `get_blueprint_graphs` | §Q1.2 | This IS the 3F `dump_graph` command. Remove from plugin-TCP scope. |
| `blueprint-read` | `get_animbp_graph` | §Q1.2 | Sidecar v1 covers state-machine data inline per Sidecar Design Q3. |

After MOVE, `blueprint-read.tools` is shorter by 2. Do NOT add these to an `offline` toolset — the sidecar reader verbs (`bp_list_graphs`, `bp_trace_exec`, etc.) are separate new offline tools that M2-Phase-A's offline worker will add. M0 does not touch the sidecar surface.

### §2.2 SPLIT — `get_widget_blueprint`

Per D56 + §Q1.2 + §FA-2 of the deliverable: `get_widget_blueprint` retains a reduced widget-tree plugin-TCP scope; the EventGraph + functions subset is absorbed by the sidecar.

**Action on M0**: keep the yaml entry but annotate per §3 below. Treat as KEEP (reduced). The annotation should make the split explicit — add a `reduced_scope:` comment covering "widget hierarchy tree + property bindings only; EventGraph + functions via 3F sidecar."

---

## §3 — KEEP (reduced) annotations (18 tools)

For every KEEP (reduced) entry in §Q1.1-Q1.11 of the deliverable, add **YAML comments** immediately above the tool key. Two lines:

```yaml
  # reduced_scope: <the retained plugin-TCP surface, per §Q1 Rationale column>
  # displaced_by: <comma-separated offline tool names from §Q1 Offline displacer column>
  get_blueprint_info:
    description: >
      ...
```

**Format rules**:
- YAML comments only (lines starting with `#`). Do NOT add new yaml keys — the loader schema is not set up for structured annotations, and M0 is yaml-edit-only (no loader changes).
- Indent comments to match the tool-key indentation (2 spaces under `tools:` is typical).
- Keep each comment on a single line. Short is fine — the full reasoning is in the deliverable.
- For the SPLIT case (`get_widget_blueprint`), the `reduced_scope:` comment must explicitly call out the split.

**The 18 KEEP (reduced) tools** (derive from deliverable §Q1; if the count differs from 18 by ±1, trust the deliverable's §Q1.12 rollup and note the discrepancy in your report):

- `blueprint-read`: `get_blueprint_info`, `get_blueprint_variables`, `get_blueprint_functions`, `get_blueprint_components`, `get_blueprint_event_dispatchers`, `get_niagara_system_info`, `get_widget_blueprint` (SPLIT)
- `asset-registry`: `get_asset_references`, `get_datatable_contents`
- `data-assets`: `list_data_asset_types`, `get_curve_asset`, `get_string_table`, `get_struct_definition`
- `animation`: `get_montage_full`, `get_anim_sequence_info`, `get_blend_space`, `get_anim_curve_data`, `get_audio_asset_info`
- `materials`: `list_material_parameters`

---

## §4 — MOVE-TO-SIDECAR consolidation header comment

Add a brief section comment at the top of the `blueprint-read` toolset (above its `tools:` block) noting the MOVE-TO-SIDECAR consolidation so future readers don't wonder where `get_blueprint_graphs` went:

```yaml
blueprint-read:
  layer: tcp-55558
  description: ...
  # MOVE-TO-SIDECAR per D54/§Q1.2: get_blueprint_graphs, get_animbp_graph (full) and
  # the EventGraph subset of get_widget_blueprint are absorbed by the 3F sidecar
  # milestone (M2-Phase-A). The 9 sidecar traversal verbs (bp_list_graphs,
  # bp_trace_exec, etc.) will land in the offline toolset, not here.
  tools:
    ...
```

Analogous header comments not needed for other toolsets — DROP removals are self-evident; MOVE-TO-SIDECAR concentration is only in `blueprint-read`.

---

## §5 — D51 preservation rule

Do NOT delete any Phase 3 yaml stub that is NOT in the DROP or MOVE-TO-SIDECAR lists. Every other un-shipped toolset entry is a D51 planning placeholder and must persist through M0.

Specifically preserve (these are NOT touched by M0):
- All other stubs in `gas`, `blueprint-read`, `asset-registry`, `animation`, `materials`, `data-assets`, `input-and-pie`, `geometry`, `editor-utility`, `visual-capture`, `cpp-introspection`, `remote-control`, `animation`.
- All shipped toolsets (`offline`, `actors`, `blueprints-write`, `widgets`) — no edits.
- The yaml header comment explaining the dual-role convention.

---

## §6 — Verification

1. **Yaml syntax check**: load `tools.yaml` via `js-yaml` (server startup is the natural test). Simplest verification:
   ```cmd
   cd /d D:\DevTools\UEMCP\server
   set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node -e "import('./server.mjs').then(()=>console.log('yaml parse OK'))"
   ```
   This triggers yaml load + Zod schema build. Any yaml error surfaces at boot.
2. **Test rotation unchanged**: run the primary rotation — baseline should stay at 825 assertions. M0 is yaml-only so no handler changes, no test changes, no test baseline drift.
   ```cmd
   cd /d D:\DevTools\UEMCP\server && node test-phase1.mjs && node test-mock-seam.mjs && node test-tcp-tools.mjs && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-mcp-wire.mjs
   ```
3. **D44 invariant**: `test-mcp-wire.mjs` includes a runtime D44 check that `tools/list` matches yaml. If that passes, the yaml structure is valid and the dropped/moved tools no longer appear in `tools/list` (confirming the DROP/MOVE took effect).
4. **Spot-check count**: grep for each dropped/moved tool name in `tools.yaml`; expect zero matches for the 8 removed tools.
   ```cmd
   findstr /C:"list_gameplay_tags_runtime" /C:"search_assets" /C:"get_class_hierarchy" /C:"get_asset_metadata" /C:"get_data_asset_properties" /C:"create_asset" /C:"get_blueprint_graphs" /C:"get_animbp_graph" tools.yaml
   ```
   Zero results = clean drop.

---

## §7 — Commit

Path-limited per D49:

```cmd
git commit tools.yaml -m "M0 Phase 3 yaml grooming: apply scope-refresh Q1 dispositions"
```

Desktop Commander (shell: "cmd") for git if sandbox bash can't acquire `.git/index.lock`. Native Git Bash is fine.

No AI attribution.

---

## §8 — Final report to orchestrator

Report (keep under 300 words):
1. Commit SHA.
2. Counts: tools dropped, tools moved-to-sidecar, tools annotated KEEP (reduced).
3. Any discrepancies between the deliverable's §Q1.12 rollup and your actual edits (e.g., "§Q1.12 says 6 DROP; I removed 6; match").
4. Test baseline: still 825? (Should be — M0 is yaml-only.)
5. Any edge cases worth flagging (e.g., "§Q1.X said tool X in toolset Y but the actual yaml has it in toolset Z — verified and resolved").
6. Next M-number is M1 or M2-Phase-A in parallel (per §Q5.3 of the deliverable) — note for orchestrator that M0 is clear for hand-off.

---

## Notes on what you are NOT doing

- NOT editing any handler code in `server/offline-tools.mjs`, `server/tcp-tools.mjs`, or the future plugin C++.
- NOT adding any new yaml keys (schema stability — only comments + key removal).
- NOT implementing any of the sidecar traversal verbs (that's M2-Phase-A).
- NOT designing the sidecar schema (already designed in `docs/specs/blueprints-as-picture-amendment.md` + `docs/research/sidecar-design-resolutions-2026-04-19.md`).
- NOT touching `tools.yaml` aliases section (out of scope — no alias in the 8 removed tools based on deliverable).
- NOT re-running the scope-refresh research or arguing with its Q1 dispositions. If you notice a genuine error in a disposition, flag it in your report but DO NOT change the edit — orchestrator decides whether to re-dispatch or accept.
