# Audit B — Goal-Alignment / Trajectory Audit

> **Date**: 2026-04-17
> **HEAD at audit**: `0f5df4d` on main (Cleanup Worker wave 4 landed; 709 assertions green)
> **Type**: Goal-alignment + trajectory. Read-only. No code changes, no design authorship, no decisions.
> **Scope**: answers three sub-questions derived from Noah's ask "ensure the trajectory of our work aligns with the goal functionality."
> 1. Does the shipped state structurally honor each stated UEMCP design principle?
> 2. Workflow Catalog projected 67% → 76% offline coverage post-Agent-10.5. What's the actual coverage?
> 3. Given what's shipped, is the Phase 3 C++ plugin scope now well-defined?
>
> **Seal**: This document is sealed on creation. Amendments via blockquote convention.

---

## §1 Principle adherence scorecard

Eight principles drawn from `CLAUDE.md` Key Design Rules, the D-log (D44–D50), and Noah's 2026-04-16 correction (via the handoff brief §"Critical context"). Each is spot-checked against shipped code or docs.

| # | Principle | Stated where | Shipped evidence | Status | Notes |
|---|-----------|--------------|------------------|--------|-------|
| 1 | **Offline reads are first-class** | D45 entry + Noah 2026-04-16 correction (handoff §Critical context) | 15 offline tools registered (`server/server.mjs:473`, yaml `tools.yaml:55-139`). Covers introspection (`inspect_blueprint`, `read_asset_properties`, `find_blueprint_nodes`), orientation (`project_info`, `list_plugins`, `get_build_config`), config (`list_config_values`), gameplay tags, asset registry (`query_asset_registry`, `get_asset_info`), data sources, and level actors. Claude Code native `Read`/`Grep`/`Glob` officially absorbed per D31 (`server.mjs:62`). | **HONORED** | The offline surface is the bulk of the shipped tool catalog. 3F sidecar (the "soft editor dependency" case) is correctly deferred to Phase 3, not substituted into offline scope. |
| 2 | **tools.yaml is the single source of truth** (for shipped surface) | CLAUDE.md Key Design Rule 1; D44 | Pre-D44 `offlineToolDefs` duplicated const removed. Current `server/server.mjs:471` reads `TOOLS_YAML.toolsets.offline.tools` directly (same file, local alias, with comment at 469-470 acknowledging the history). TCP tools follow the same pattern via `getActorsToolDefs()` etc. in `tcp-tools.mjs`. D50 final report notes D44 invariant verified for `find_blueprint_nodes` (tools/list ↔ find_tools ↔ yaml byte-identical). | **HONORED** (NOTE) | The D44 entry text specifies the refactor should consume yaml via `toolsetManager.getToolsData()`; the shipped code accesses `TOOLS_YAML.toolsets.offline.tools` directly. Functionally equivalent — same yaml, no duplication — but a trivial deviation from D44's prescribed path. Not a violation. |
| 3 | **Markers never silently drop** | Agent 9 §1 rule; yaml `read_asset_properties` description (`tools.yaml:97`) enumerates marker reasons | `server/uasset-structs.mjs` emits `__unsupported__` markers at 25+ call sites (grep: lines 102, 149, 155, 161, 173, 181, 201, 205, 209, 215, 218, 222, 234, 237, 244, 255, 259, 263, 564, ...). Reason codes: `complex_element_container`, `container_count_unreasonable`, `map_with_removed_items`, `struct_key_map`, `map_key_type_unsupported`, `set_with_removed_items`, `body_instance_native_layout_unknown`, `expression_input_native_layout_unknown` (post-Parser Extensions), etc. `offline-tools.mjs:1292` collects unsupported list via `dedupeUnsupported`. Yaml description lines 97 enumerates reason codes for caller awareness. | **HONORED** | Extensive marker coverage. D50's tagged-fallback intentionally reduces the *count* of unknown_struct markers (91%) but preserves the *surface* — callers can still detect unsupported cases by reason code. |
| 4 | **3F sidecar has soft editor dependency** (not equivalent to pure offline) | D45 | `docs/specs/blueprints-as-picture-amendment.md:90-104` documents the sidecar cache model including explicit fallback `{available: false, reason: "no_sidecar_and_editor_offline"}`. D45 entry text captures the "pragmatic offline not pure offline" framing so future agents don't lose track. | **HONORED** | No shipped violation possible yet because 3F itself is Phase 3 scope. The *framing* of the soft dependency is preserved in the spec and D-log. |
| 5 | **Three-layer offline BP stack** (L0 structural + L1 semantic name-only + L2 spatial+trace-sidecar) | D48 | L0 = `inspect_blueprint` shipped D37 (`offline-tools.mjs`); L1 = `find_blueprint_nodes` shipped Agent 10.5 (`tools.yaml:103-123`, 13 skeletal K2Node types + 2 delegate-presence); L2 = 3F sidecar deferred to Phase 3 per D45/D48. Workflow Catalog §6.2 cross-anchors: "Rows answered by L0 today: 2, 4 partial, 7 partial, 11 partial. Rows answered by L1 S-A post-Agent-10.5: 3, 26, 27, 28, 29 name-only, 33, 42, 59, 60, 62, 63. Rows answered by L2 sidecar only: 9, 10, 13, 16, 30." | **HONORED** | Two of three layers shipped; L2 is correctly deferred. S-B pin-tracing is in backlog DR-1 with explicit reopening triggers. |
| 6 | **Path-limited commits in parallel sessions** | D49 | `git log --stat` on 5 most recent commits (`0f5df4d` → `f3ae608`) shows every commit touches ≤4 files, all scoped to the worker's declared surface. No sweep-ins. | **HONORED** | D49 discipline is visibly practiced. |
| 7 | **Bundle related follow-on work** | D48 Mode A decision (Agent 10.5) | CLAUDE.md Current State: "Agent 10.5 shipped (D46/D47/D48/D50): complex-element containers + tagged-fallback for unknown structs + L3A S-A skeletal K2Node surface" — one bundled session covered all three shared-infrastructure scopes. Memory hook `feedback_agent_scope_bundling.md` confirms the pattern. | **HONORED** | Mode A (bundled) chosen over Mode B (standalone 10.75) per D48's cost analysis. D-log entry captures the rationale for future similar calls. |
| 8 | **Deferred-with-trigger pattern** | D-log convention (explicit at D47/D48) | Every deferred item has named reopening conditions: DR-1 S-B (`backlog.md:86-88` two explicit triggers); DR-2 L3A full-fidelity (`backlog.md:92-95` architectural-shift trigger); D47 two-pass (before D50 supersession — trigger was "spot-check PURSUE"); D48 S-B reopening signals listed in D48 entry itself (2 specific scenarios); EN-4 math K2Node graduations ("workflow demand" trigger). D50 supersedes D47 with historical preservation (amend, don't delete — `risks-and-decisions.md:145` "NOTE (2026-04-16 amendment)"). | **HONORED** | Pattern is consistent across the D-log and backlog. No deferred item without a trigger. |

**Tally**: 8 honored, 0 partial, 0 violated. One NOTE on Principle 2 (trivial D44 implementation-detail deviation, no functional impact).

---

## §2 Workflow coverage re-measurement

Method: sample the four classification buckets in `docs/research/agent-workflow-catalog.md` (100 rows) against shipped state. Agent 10.5 shipping (`find_blueprint_nodes` for S-A; tagged-fallback per D50) is the main delta the catalog projected.

### §2.1 NOT_SERVED → ? (19 rows in catalog; Rank 1 cluster = 9 rows)

Rank 1 rows (3, 26, 27, 28, 33, 42, 59, 62, 63) were all projected to flip to SERVED_OFFLINE via S-A. Empirical re-check against the shipped `find_blueprint_nodes` surface:

| Row | Query | Scope | Shipped status | Evidence |
|-----|-------|-------|----------------|----------|
| 3 | "What events does BP_OSPlayerR handle?" | Single BP | **SERVED_OFFLINE** | `find_blueprint_nodes(asset_path='BP_OSPlayerR', node_class='K2Node_Event')` directly answers. Yaml line 103 covers Event + CustomEvent + FunctionEntry etc. |
| 26 | "Which BPs call ApplyGameplayEffectToTarget?" | Multi-BP scan | **SERVED_PARTIAL** | Single-BP: `find_blueprint_nodes(node_class='K2Node_CallFunction', member_name='ApplyGameplayEffectToTarget')` works. Multi-BP requires iteration via `query_asset_registry class_name:Blueprint` + loop — EN-2 backlog item `find_blueprint_nodes_bulk` is the missing consolidated tool. |
| 27 | "List BPs that handle ReceiveBeginPlay" | Multi-BP scan | **SERVED_PARTIAL** | Same shape as row 26; per-asset works, bulk needs EN-2. |
| 28 | "Which BPs read variable bIsInCombat?" | Multi-BP scan | **SERVED_PARTIAL** | Same shape. `node_class='K2Node_VariableGet'` + `member_name='bIsInCombat'`. |
| 33 | "Before renaming MaxHealth, find readers + writers on BP_Character" | Single BP | **SERVED_OFFLINE** | `find_blueprint_nodes` with `node_class='K2Node_VariableGet'` then `K2Node_VariableSet` on the one BP. |
| 42 | "Which BPs override ReceiveBeginPlay?" | Multi-BP scan | **SERVED_PARTIAL** | Duplicate shape of 27. |
| 59 | "Is it safe to rename MaxHealth? (call sites)" | Typically single BP + a grep | **SERVED_OFFLINE** | If the variable is private to one BP, single-BP find works. If it's on a base class and called from many BPs, downgrade to SERVED_PARTIAL (needs EN-2). Classifying as SERVED_OFFLINE for the dominant case. |
| 62 | "List BPs that call deprecated OldApplyDamage" | Multi-BP scan | **SERVED_PARTIAL** | EN-2 gap. |
| 63 | "If I rename AttributeSet.Health → HP, who breaks?" | Multi-BP scan | **SERVED_PARTIAL** | EN-2 gap. |

**Confirmed NOT_SERVED flips** (code-structural evidence): 3 rows to SERVED_OFFLINE (3, 33, 59); 6 rows to SERVED_PARTIAL (26, 27, 28, 42, 62, 63). Net: the catalog's "9 rows flip to SERVED_OFFLINE" projection was slightly optimistic because EN-2 (bulk variant) isn't shipped; partial-or-better coverage is hit, full-offline coverage is short by 6 rows.

Remaining 10 NOT_SERVED rows (21, 25, 35, 44, 45, 60, 83, 87, 88, 89) are in the reverse-reference / size-filter / cross-project / binary-diff clusters. None have shipped closure; all match catalog ranks 2/5/6.

### §2.2 SERVED_PARTIAL → SERVED_OFFLINE via D50 tagged-fallback (inferred, not empirically verified)

D50 final report (risks-and-decisions.md:148) documents marker reductions: `unknown_struct` 251K → 22K (91%), `complex_element_container` 65K → 6K (91%), `container_deferred` (TMap) 24K → 0 (100%). These reductions imply several catalog PARTIALs should now fully decode via `read_asset_properties`:

| Row | Query | Catalog classification | Inferred post-D50 | Verification status |
|-----|-------|------------------------|--------------------|--------------------|
| 18 | "What input action does IA_Jump map to?" (Enhanced Input IMC) | SERVED_PARTIAL (TArray<FEnhancedActionKeyMapping> complex struct) | **likely SERVED_OFFLINE** (tagged-fallback covers TArray<custom struct>) | Empirical open — requires running `read_asset_properties` on an ProjectA IMC asset |
| 50 | "What's the collision preset on this mesh?" | SERVED_PARTIAL (complex struct degrades to marker) | **likely SERVED_OFFLINE** | Empirical open |
| 68 | "Generate docs for all DataTables" (binary RowMap) | SERVED_PARTIAL | **likely SERVED_OFFLINE** for UserDefinedStruct-keyed; remains PARTIAL for engine-struct rows | Empirical open — catalog §7a confirms ProjectA has 14 binary DataTables + 0 CSVs, primary combat-data path |
| 69 | "Document localization strings used in W_MainMenu" (binary UStringTable) | SERVED_PARTIAL | **likely SERVED_OFFLINE** via `read_asset_properties` on the StringTable CDO | Empirical open |
| 94 | "What pattern do existing DataTables use for weapon stats?" | SERVED_PARTIAL | **likely SERVED_OFFLINE** | Empirical open |

These 5 potential flips are inferred from the 91% marker-reduction evidence, not verified against ProjectA fixtures in this audit (out of 2-3 hr scope).

### §2.3 SERVED_PLUGIN_ONLY → ? (14 rows)

Spot-check: rows 9, 10, 13, 16, 30 (sidecar-scope) remain PLUGIN_ONLY (3F not shipped). Rows 54, 55, 56, 57, 58, 95, 96, 97, 100 (runtime/visual) remain PLUGIN_ONLY (intrinsically editor-dependent). No PLUGIN_ONLY rows have moved offline — consistent with the principle that PLUGIN_ONLY classifications in the catalog are genuinely editor-dependent, not artifacts.

### §2.4 SERVED_OFFLINE sample (10 random) — regression check

| Row | Query | Tool | Still served? |
|-----|-------|------|---------------|
| 1 | List placed actors in .umap with transforms | `list_level_actors` | YES — transforms added via Option C (Agent 10 ship) |
| 2 | Parent class of BP_OSControlPoint | `inspect_blueprint` | YES |
| 6 | Default Damage/Cooldown on BPGA_Fireball | `read_asset_properties` / `inspect_blueprint include_defaults` | YES |
| 14 | Mesh/material BP_Sword references | `read_asset_properties` (FSoftObjectPath walk) | YES |
| 22 | BP_Sword forward dependency list | `read_asset_properties` | YES |
| 40 | Tags under Gameplay.State.* | `search_gameplay_tags` (D49 matchTagGlob refactor) | YES |
| 65 | Summarize GA_Fireball CDO | `read_asset_properties` | YES |
| 70 | Project overview | `project_info` + `list_plugins` + `get_build_config` | YES |
| 72 | Which UEMCP toolsets are available? | `list_toolsets` | YES (management tool, always on) |
| 86 | Assets tagged PrimaryAssetType=GameItem | `query_asset_registry tag_key:PrimaryAssetType` | YES |

Zero regressions in the sample.

### §2.5 Actual coverage now

| Bucket | Catalog baseline | Conservative (confirmed only) | Optimistic (inferred D50 flips) |
|--------|------------------|--------------------------------|----------------------------------|
| SERVED_OFFLINE | 41 (41%) | **44** (44%) | **49** (49%) |
| SERVED_PARTIAL | 26 (26%) | **32** (32%) | **27** (27%) |
| SERVED_PLUGIN_ONLY | 14 (14%) | 14 (14%) | 14 (14%) |
| NOT_SERVED | 19 (19%) | **10** (10%) | 10 (10%) |
| **Partial-or-better offline reach** | **67%** | **76%** | **76%** |

Catalog projected 67% → 76% partial-or-better. Both ranges hit 76% — projection accurate. The fully-offline fraction (catalog projected ~53%) lands at 44-49%; the shortfall is the 6 multi-BP find rows pending EN-2 `find_blueprint_nodes_bulk`.

---

## §3 Trajectory drift check

Comparing major research deliverables to what actually shipped.

| Research deliverable | Recommendation | Shipped | Drift |
|----------------------|----------------|---------|-------|
| **Agent 9** — `level12-tool-surface-design.md` | Option C hybrid (transforms on `list_level_actors` + `include_defaults` on `inspect_blueprint` + new `read_asset_properties`) | Exactly as designed (`tools.yaml:89-102`) | **None** |
| **Agent 9.5** — `level12-verification-pass.md` | 4 corrections: transform chain via `outerIndex` reverse scan, UE 5.6 FPropertyTag extensions, sparse-transform tolerance, mandatory pagination | CLAUDE.md Current State: "Agent 9.5's 4 implementation-critical corrections applied" | **None** (all 4 adopted) |
| **Agent 10** — Level 1+2+2.5 | Parser + 12 engine struct handlers + simple-element containers | Shipped, tests pass, 19K+ files zero errors (D38 tier-2 validation) | **None** |
| **Agent 10.5 D46/D47 original** — two-pass struct registry resolver | Load each UUserDefinedStruct .uasset, walk exports for member definitions, cache layout, apply to consumers | **PIVOTED** to tagged-fallback per D50 | **DOCUMENTED drift** — D50 entry captures the pivot as an empirical correction to the original mental model (UUserDefinedStruct member definitions live in `EditorData.VariablesDescArray`, not as child exports). Result: 71% total marker reduction, simpler code, no cache. D47 retained in-place with SUPERSEDED-BY-D50 footnote per `risks-and-decisions.md:145`. |
| **Agent 10.5 D48** — S-A skeletal parse | Tier S-A PURSUE (name-only, 13 K2Node types); Tier S-B FOLD-INTO-3F (pin-tracing zero reference coverage) | S-A shipped as `find_blueprint_nodes`; S-B deferred with triggers | **None** |
| **Agent 11** — `level3-feasibility-study.md` | L3A full-fidelity = permanently editor-only; 3F sidecar is the offline-read path | D45 captures; 3F scheduled for Phase 3 | **None** |
| **Agent 11.5** — `level3a-skeletal-parse-study.md` | Skeletal split along cost/coverage seam | D48 codifies | **None** |
| **Workflow Catalog** | 67% → 76% post-Agent-10.5 projection | 76% reached (both ranges); fully-offline short by 6 rows (EN-2 gap) | **Minor** — catalog implicitly assumed bulk-scan coverage on find/grep rows; EN-2 explicitly held out per D48 scope + `backlog.md:44-49` |

### Other drift items surfaced

**D1 — Stale TOOLSET_TIPS reference to dropped tool `search_source`** (minor):
- `server/server.mjs:99` — actors→offline workflow tip says "Use search_source to find C++ class names..."
- `server/server.mjs:122` — blueprints-write→offline workflow tip says "Use search_source to find C++ base class signatures..."
- `search_source` was dropped per D31 (inferior to native `Grep`). The tool no longer exists in `tools.yaml`. These tips would tell Claude to use a nonexistent tool if the `offline` toolset is co-enabled. Cosmetic — offline toolset is always enabled, `Grep` is available and does the same job — but misleading.
- Not captured in `backlog.md`. Suggested addition: TS-4 tool-surface cleanup entry or a single-line tip-string fix.

**D2 — tools.yaml carries Phase 3 entries that D32/D37 say should be eliminated** (see §4 for readiness framing):
- `tools.yaml:477-498` asset-registry has `search_assets`, `get_class_hierarchy`, `get_asset_metadata` — all should be eliminated per D32/D37 (already covered by offline `query_asset_registry` + `get_asset_info`).
- `tools.yaml:599-602` data-assets has `get_data_asset_properties` — should be eliminated per Agent 9 §3 (direct subset of `read_asset_properties`).
- This is NOT a Principle 2 violation — `server.mjs` only registers shipped toolsets (offline + actors + blueprints-write + widgets); Phase 3 entries are planned stubs with explicit yaml header comment acknowledging "params: stubs — populated incrementally during implementation" (`tools.yaml:9`). But the Phase 3 section of yaml hasn't been groomed to reflect post-shipping reductions.

**Net trajectory assessment**: **trajectory-correct with minor documented drift**. The one substantive pivot (D47 two-pass → D50 tagged-fallback) is captured explicitly in the D-log with SUPERSEDED footnote. The stale TOOLSET_TIPS reference and yaml-Phase-3-grooming gap are documentation debt, not design drift.

---

## §4 Phase 3 readiness assessment

**Verdict: YELLOW** — scope is decidable but documentation needs consolidation before dispatch.

### What's well-defined

✓ **P0 catalog** (`docs/specs/phase3-plugin-design-inputs.md`): P0-1 through P0-11 with subsystem buckets 3A–3E, each with 5-field template (current / required / wire impact / test / bucket). Infrastructure cluster 3A ordering locked ("must land first").

✓ **3F sidecar scope** (`docs/specs/blueprints-as-picture-amendment.md`): schema additions, traversal verb surface (9 verbs, v1.1/v1.2 deferrals per D41), cache model with D33 freshness coupling, 3 discrete plugin requirements (3F-1 `dump_graph` TCP verb, 3F-2 save-hook sidecar writer, 3F-3 `prime_bp_cache` command).

✓ **Oracle retirement path** (D40): single-milestone flip — all three transitional toolsets (`actors`, `blueprints-write`, `widgets`) change layer from `tcp-55557` to `tcp-55558` in one commit. D35 server-side residues retained as defense-in-depth ≥1 release after retirement.

✓ **Engine-skew strategy** (D42): `#if ENGINE_MINOR_VERSION` wrappers in single codebase. Forking deferred to API-depth trigger.

✓ **Phase 3 offline absorption** (D32/D37/D39/D45/D48/D50): registry-backed tools, BP structural introspection, Level 1+2+2.5 property decode, tagged-fallback, L3A S-A — all already absorbed offline.

### Unblockers before Phase 3 dispatch

1. **Yaml grooming pass** — reflect D32/D37/D39/D45/D48/D50 reductions in `tools.yaml`. Current Phase 3 toolsets still carry tools the D-log has eliminated. Specifically:
   - `asset-registry.search_assets` — eliminate (covered by offline `query_asset_registry`)
   - `asset-registry.get_class_hierarchy` — eliminate (covered by `query_asset_registry class_name:Blueprint` + AR tag walk)
   - `asset-registry.get_asset_metadata` — eliminate (covered by offline `get_asset_info`)
   - `data-assets.get_data_asset_properties` — eliminate (direct subset of offline `read_asset_properties`)
   - `blueprint-read.get_blueprint_info` — annotate as reduced (remainder: runtime-reflected interface list only)
   - `blueprint-read.get_blueprint_variables` — annotate as reduced (remainder: reflection-only flags; CDO defaults covered offline)
   - `blueprint-read.get_blueprint_components` — annotate as reduced (remainder: live-attached-via-script components)
   - `blueprint-read.get_niagara_system_info` — annotate as reduced (remainder: compiled VM state)
   - `data-assets.get_curve_asset`, `get_struct_definition` — annotate as reduced
   - `actors.*` (10 tools) — annotate static subset as absorbed offline, runtime/live subset remains
   - `materials.list_material_parameters` — annotate as reduced
   - `remote-control.rc_get_property` — annotate static subset as absorbed offline

2. **Resolve 5 open questions in `blueprints-as-picture-amendment.md:131-138`**:
   - Sidecar location (next-to-asset vs parallel `Saved/UEMCP/BPCache/` mirror)
   - Knot collapse semantics (original path annotation vs direct edge only)
   - AnimBP state machines (own traversal verbs or adapt existing)
   - Material graphs (same defer question)
   - CDO defaults scope (Phase 3 vs Phase 4 RC)

3. **Consolidated "Phase 3 scope as of 2026-04-17" spec** — the post-shipping picture is currently scattered across D32/D37/D39/D45/D48/D50 entries + Agent 9 §3 + `phase3-plugin-design-inputs.md` + `blueprints-as-picture-amendment.md`. A single inlined snapshot reduces dispatch-time friction.

4. **EN-2 decision** — `find_blueprint_nodes_bulk(path_prefix)` (backlog EN-2). Currently listed as offline enhancement. Decision: does this ship pre-Phase-3 to close the 6 multi-BP find rows in the catalog (rows 26/27/28/42/62/63), or is the iteration-plus-loop workaround acceptable? Affects whether Phase 3's BP-read scope needs a `find_blueprint_nodes_global` analogue.

### Why not RED

The scope inputs exist, the D-log is coherent, the 3F sidecar spec is drafted, and the D23/D40 oracle-retirement path is decided. Phase 3 does not need significant new research; it needs documentation consolidation and 5 design clarifications.

### Why not GREEN

A fresh agent dispatched to Phase 3 today would need to reconcile ≥4 docs and ≥7 D-log entries before understanding current scope. The yaml surface still describes pre-shipping targets. Open questions in the sidecar spec are unresolved.

---

## §5 Backlog accuracy spot-check

Cross-referencing `docs/tracking/backlog.md` against observations during this audit.

| Backlog category | Captured items | Missing items surfaced in audit |
|------------------|----------------|--------------------------------|
| Tool-surface cleanup | TS-1 (take_screenshot dup), TS-2 (add_widget_to_viewport NO-OP), TS-3 (create_asset scope review) | **TS-4 candidate**: stale `search_source` references in `server.mjs:99,122` TOOLSET_TIPS workflows. Also the 4 Phase 3 yaml-grooming targets listed in §4 (depending on whether those count as backlog items or Phase 3 prep work). |
| Enhancements | EN-1 (size filter), EN-2 (bulk find), EN-3 (parity audit), EN-4 (math K2Node) | None missed. |
| Fixture planting | FX-1 (TMap BP CDO) | None missed. |
| Deferred research | DR-1 (S-B), DR-2 (L3A full fidelity) | None missed. |

Backlog is mostly accurate. Two additions to consider:
- **TS-4**: TOOLSET_TIPS `search_source` stale reference (1 one-line fix across 2 locations).
- Depending on §4.1 scoping: yaml Phase 3 grooming items may deserve their own section or rollup as a single "Phase 3 pre-dispatch grooming pass" entry.

---

## §6 Open questions for Noah

**Q1** — **Yaml grooming timing**. Should the `tools.yaml` Phase 3 grooming pass (§4 unblocker 1) be a separate pre-Phase-3 worker, or folded into Phase 3 dispatch as the first deliverable? Separate worker keeps Phase 3 dispatch clean; folded-in keeps the yaml authoritative-during-planning for the dispatch itself. No strong preference signaled in the D-log.

**Q2** — **EN-2 prioritization**. The 6 multi-BP find rows (26/27/28/42/62/63) are currently SERVED_PARTIAL via iteration. `find_blueprint_nodes_bulk` in backlog closes them to SERVED_OFFLINE. Is this worth fitting in before Phase 3, or is the iteration-plus-loop workflow acceptable indefinitely? Affects whether Phase 3 BP-read scope needs a corresponding global-find plugin tool or whether the offline EN-2 subsumes it.

**Q3** — **Principle to add or reframe?** The audit surfaced an implicit "tools.yaml serves dual roles" pattern — shipped-state-of-truth for registered toolsets AND Phase 3 planning table for un-registered toolsets. The dual role isn't documented as a principle; the yaml header comment hints at it ("params: stubs — populated incrementally during implementation"). Per handoff rule (no new principles invented during audit), flagging as Q3: should this be explicitly documented, or is the current implicit convention fine?

**Q4** — **Five open questions in `blueprints-as-picture-amendment.md:131-138`** — unchanged since 2026-04-15 draft. Do they need a design session before Phase 3 dispatch, or are sensible defaults acceptable?

**Q5** — **Stale TOOLSET_TIPS search_source reference** (`server.mjs:99,122`) — add as TS-4 backlog item, or fix inline as part of a larger TOOLSET_TIPS refresh pass?

**Q6** — **D50 marker-reduction verification** — this audit inferred 5 catalog rows (18/50/68/69/94) likely flipped PARTIAL→OFFLINE via tagged-fallback but did not empirically verify. Worth a short manual-testing pass against ProjectA fixtures to confirm, or is structural evidence sufficient?

---

## §7 Confidence

**Overall: MEDIUM-HIGH.**

- **§1 principle adherence**: **HIGH**. Spot-checks are code-grounded at specific file:line citations. All 8 principles traceable to shipped evidence.
- **§2 workflow coverage**: **MEDIUM**. Confirmed flips (9 rows) are code-structural and solid. Inferred flips (5 rows via D50 tagged-fallback) are based on the 91% marker-reduction evidence from D50 final report, not re-run against fixtures. Range given to surface this.
- **§3 trajectory drift**: **HIGH**. Research-vs-shipped comparison is document-grounded. D47→D50 pivot is explicitly documented in-log; TOOLSET_TIPS stale refs and yaml grooming gap are observable with file:line.
- **§4 Phase 3 readiness**: **MEDIUM-HIGH**. Scope inputs are well-enumerated (`phase3-plugin-design-inputs.md` P0-1 through P0-11; `blueprints-as-picture-amendment.md` 3F-1 through 3F-3). YELLOW verdict reflects the documentation-consolidation gap, not missing research. Minor uncertainty: whether "yaml grooming + 5 open questions + consolidated scope doc" is 2-3 hours of housekeeping or materially more, depending on Noah's answers to Q1/Q2/Q4.
- **§5 backlog**: **HIGH**. Cross-reference is exhaustive for the surfaced items.

Audit method was sampling, not re-classification of all 100 rows — matches handoff §2 spec. Where findings are empirically unverified (§2.2), the audit flags and does not resolve.

---

## §8 Final Report

```
Audit B Final Report — Goal-Alignment / Trajectory

Principles honored:           8 / 8
Principles partial:           0 / 8
Principles violated:          0 / 8
                              (one NOTE on Principle 2: D44 implementation-detail
                              deviation — local alias vs getToolsData() path. No
                              functional impact. Not counted as partial.)

Workflow coverage actual:     76% partial-or-better offline reach
                              (catalog baseline 67% / projection 76% — MATCH)
                              Fully-offline fraction: 44-49% (conservative-optimistic range)
                              vs catalog projection ~53% — SHORT by 4-9 pts due to
                              EN-2 bulk find gap.

Phase 3 readiness:            YELLOW

Trajectory drift items:       3 flagged
  1. D47 → D50 tagged-fallback pivot (DOCUMENTED in D-log, not silent drift)
  2. Stale search_source references in TOOLSET_TIPS (server.mjs:99,122) — minor,
     backlog TS-4 candidate
  3. tools.yaml Phase 3 scope not groomed for D32/D37/D39/D45/D48/D50 reductions —
     Phase 3 readiness blocker #1, not a Principle 2 violation per yaml's dual role
     (shipped-SSoT + Phase 3 planning table)

Net assessment:               trajectory-correct with minor documented drift

Open questions for Noah:      6
  Q1: Yaml grooming timing — separate worker vs Phase 3 first deliverable
  Q2: EN-2 bulk find prioritization — pre-Phase-3 vs indefinite
  Q3: Document yaml's dual role (SSoT + planning) as explicit principle?
  Q4: Resolve 5 open questions in blueprints-as-picture-amendment.md
  Q5: TS-4 backlog add for stale TOOLSET_TIPS references
  Q6: Empirical D50 flip verification — run manual test pass?

Confidence:                   MEDIUM-HIGH
  HIGH: §1 principles, §3 trajectory, §5 backlog
  MEDIUM: §2 coverage (inferred D50 flips unverified), §4 readiness unblocker sizing

Deliverable:                  docs/audits/goal-alignment-audit-2026-04-17.md (SEALED)
```
