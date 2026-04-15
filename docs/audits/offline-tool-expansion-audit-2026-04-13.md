# Offline Tool Expansion Audit — 2026-04-13

**Scope**: Identify TCP:55558 (Phase 3) and TCP:55557 handlers currently classified as "requires editor" that could instead run as offline disk parsers in the Node MCP server. Evaluate each candidate against the CLI-agent-usefulness bar (D17 philosophy: a tool must earn its place over Claude Code's native `Read`/`Write`/`Grep`/`Glob`/`Bash`).

**Method**: Four-pass review.
1. Initial scan of Phase 3 toolsets in `tools.yaml` for handlers whose outputs are file-shaped (not runtime-shaped).
2. Validation pass — cross-check each candidate against `docs/specs/conformance-oracle-contracts.md` and sample source files in ProjectA / ProjectB.
3. CLI-agent lens — re-score each candidate by asking "can Claude Code already do this with `Read`/`Grep`?"
4. Editor-assumption challenge — probe whether "requires editor" tools could be served by binary-format parsing of `.umap`, `.uasset`, or the Asset Registry cache.

**Status**: Research complete. No code written. Handoff to agent 1 (orchestrator) for prioritization and scheduling.

---

## TL;DR

- **3 new offline tools worth building** for DataTable/StringTable read support (forward compatibility — not used in current projects but are standard UE patterns).
- **3 new offline tools worth building** by parsing UE binary formats — a genuinely new capability tier that neither Claude Code nor the existing TCP plugin covers well.
- **1 candidate rejected** on CLI-agent grounds (`create_attribute_set` — Claude Code can pattern-match existing AttributeSet headers natively).
- **1 candidate marginal** (`write_gameplay_tag` — defensible but replaceable by a CLAUDE.md rule).
- **Existing offline toolset has redundancy with Claude Code built-ins** — Phase 1.5 cleanup proposed (see Section 5).

---

## 1. CLI-Agent Usefulness Bar

A tool earns its place in the MCP surface when at least one is true:

1. **Parses a binary format Claude Code cannot read** (`.uasset`, `.umap`, `DevelopmentAssetRegistry.bin`).
2. **Wraps a runtime operation** requiring a live `UEngine` (covered by TCP/HTTP layers, not offline).
3. **Aggregates data across many files** with domain-specific logic that would be expensive to reconstruct from primitives each time (e.g., "list every `+GameplayTagList` across all ini files" — saves a multi-step `Grep`+parse loop).
4. **Encodes non-obvious rules** that prevent a CLI agent from making format-breaking mistakes (e.g., "tag writes must go in the `+GameplayTagList` section, not the redirect or settings blocks").

A tool does **not** earn its place when it wraps `Read`/`Write`/`Grep`/`Bash` with a Zod schema.

---

## 2. New Offline Tools — Worth Building

### 2.1 `read_datatable_source` / `list_data_sources` / `read_string_table_source`

**Earns place via**: Rules 3 + 4.

DataTables and StringTables are standard UE authoring patterns. Neither ProjectA nor ProjectB uses them today, but both are likely to adopt them (localization for ProjectB; combat-tuning CSV for ProjectA). Source forms are CSV/JSON sitting next to the `.uasset`, which Claude Code *can* read — but:

- `list_data_sources` aggregates across `Content/` trees to answer "what data is in this project?" in one call.
- `read_datatable_source` encodes the UE CSV conventions (first column = row name, `---` header delimiter behavior, type-column introspection from the companion `RowStruct` header reference).
- `read_string_table_source` handles the `StringTable.csv` format and the namespace/key layout.

**Why not TCP**: Source-of-truth CSVs are authored on disk and edited outside the editor. Reading them does not need a live engine.

### 2.2 `query_asset_registry` — Asset Registry binary parser

**Earns place via**: Rule 1 (high leverage).

UE maintains a documented binary index at `Saved/Cooked/<Platform>/<Project>/Metadata/DevelopmentAssetRegistry.bin` (cooked) and an in-editor working registry. The format is defined in `AssetRegistryState.cpp`. Contents include, for every asset in the project:

- Full object path, class name, package dependencies (hard + soft).
- Class-specific tags — for Blueprints: `ParentClass`, `ImplementedInterfaces`, `NativeParentClass`, `NumReplicatedProperties`.
- Package file size, cook flags.

Parsing this file unlocks offline equivalents for:

| Tool | Currently On | Can Move To Offline |
|------|--------------|---------------------|
| `search_assets` (by class/path/tag) | TCP:55558 | Offline |
| `get_class_hierarchy` | TCP:55558 | Offline |
| `get_asset_references` / `get_asset_dependencies` | TCP:55558 | Offline |
| `find_blueprints_implementing_interface` | TCP:55558 | Offline |

**This is the single highest-leverage offline capability in the audit.** The registry exists *specifically* so external tools don't have to parse every `.uasset`. Build effort: moderate (binary parser, but single well-documented format).

**Caveat**: The registry must be generated (enable `bSerializeAssetRegistry` or run a cook / editor session). If stale, the tool must surface the timestamp clearly so a CLI agent doesn't make decisions off outdated data.

### 2.3 `list_level_actors` — `.umap` export-table walker

**Earns place via**: Rule 1.

A `.umap` file is a UE package file. Its header (`FPackageFileSummary`) + name table + export table are enough to enumerate every `UObject` serialized into the level, including actor classes and labels (`ActorLabel` property is a serialized string). Returns `[{label, class, packagePath}]`.

**What it does not do**: Property values (those require full property-system deserialization, which is the hard half of a `.uasset` parser). Stays on TCP for `get_actor_properties`.

**Build effort**: Low-moderate. Parser scope is bounded — header + name table + export table, no per-property type dispatch needed.

### 2.4 `inspect_blueprint` — `.uasset` structural walker

**Earns place via**: Rule 1.

Walks a Blueprint `.uasset` export table to extract:

- Parent class (native or Blueprint).
- Implemented interfaces.
- Variable list (names + type imports from the import table).
- Function list (`UFunction` exports).
- Component tree (`USCS_Node` exports, parent pointers).

**This closes a real Claude Code gap.** Claude Code can read `.h` to infer C++ class hierarchies, but Blueprint-only classes and Blueprint-derived variables are invisible to it. An MCP tool that exposes BP structure to a CLI agent that otherwise only sees C++ is distinctive value.

**Build effort**: Moderate — overlaps with `list_level_actors` parser (same package format).

---

## 3. Rejected / Demoted Candidates

### 3.1 `create_attribute_set` — REJECTED

Initial pass proposed this as a clean offline codegen tool. Rejected on CLI-agent grounds.

**Reason**: Claude Code can pattern-match from `OSAttributeSet.h` (ProjectA) or `ZKAttributeSetLivingEntity.h` (ProjectB) using `Read` + `Write` natively. The `ATTRIBUTE_ACCESSORS` macro + `UPROPERTY(ReplicatedUsing = OnRep_X)` + `DOREPLIFETIME_CONDITION_NOTIFY(...)` triple is a stable, copyable pattern. Wrapping it in an MCP tool reduces flexibility (can't add project-specific macros, can't mix meta and replicated attributes, can't handle the inheritance split ProjectB uses between `ZKAttributeSetBase` and `ZKAttributeSetLivingEntity`).

A CLAUDE.md pattern note is more useful than a tool here.

### 3.2 `write_gameplay_tag` — MARGINAL

Defensible value: encodes the rules "append to `+GameplayTagList` section, not the redirect or settings blocks; dedup against existing tags; auto-create missing parent tags if project convention requires; note hot-reload gap (editor restart needed)."

But: these rules can be documented in CLAUDE.md and executed by Claude Code with `Read` + `Edit`. The hot-reload gap is the one piece of knowledge the tool would encode — surfaceable as a CLAUDE.md line.

**Recommendation**: Document rules in CLAUDE.md, build only if friction materializes.

---

## 4. Editor-Assumption Audit — What Actually Needs a Live Engine

For completeness, handlers confirmed to require a running editor (no offline path):

- Actor mutation (spawn/delete/transform).
- Blueprint compilation.
- PIE session control.
- Remote Control live property get/set.
- Transient state (selection, viewport camera, current tool).
- Material parameter live preview.
- `get_actor_properties` with overridden values — possible offline in theory but requires full property serialization parser (build cost exceeds payoff).
- `get_blueprint_nodes` / event graph structure — `UEdGraph` serialization is large and unfriendly. Stay on TCP.

These remain TCP:55558 / HTTP:30010 scope. No change.

---

## 5. Phase 1.5 Cleanup Proposal (Existing Offline Toolset)

Audit noticed collateral redundancy. Roughly half of the current offline toolset duplicates Claude Code's native capabilities:

| Current Tool | Overlaps With | Keep? |
|--------------|---------------|-------|
| `read_source_file` | `Read` | **Drop** — Claude Code reads .h/.cpp natively with line numbers. |
| `search_source` | `Grep` | **Drop** — Grep is more flexible (regex, context, multiline). |
| `browse_content` | `Glob` + `LS` | **Drop** — Glob `**/*.uasset` is equivalent. |
| `get_asset_info` | `Bash stat` | **Drop or reframe** — fs.stat() adds no value; reframe to "asset metadata from registry" once `query_asset_registry` exists. |
| `project_info` | — | **Keep** — aggregates `.uproject` JSON + module list, domain-specific. |
| `list_gameplay_tags` | `Grep +GameplayTagList` | **Keep** — hierarchy tree building is the value-add. |
| `search_gameplay_tags` | (above) | **Keep** — scoped search with hierarchy awareness. |
| `list_config_values` | `Read *.ini` | **Keep** — progressive drill-down + section handling. |
| `list_plugins` | `Read .uproject` | **Keep marginal** — aggregates `.uproject` plugins + `Plugins/*/*.uplugin`. |
| `get_build_config` | — | **Keep** — Target.cs parsing, domain-specific. |

**Proposed**: New decision record **D29 — Shrink offline toolset to tools that earn their place under CLI-agent bar**. Drop 3-4 tools, redirect their registrations, update `SERVER_INSTRUCTIONS`. Net effect: lower always-on surface area, higher signal-to-noise.

Needs Noah's sign-off before execution — some of these tools were built deliberately as "safety rails" for a less capable CLI agent and the drop decision is partly philosophical.

---

## 6. Recommended Build Order

Ranked by leverage-per-effort:

1. **`query_asset_registry`** — single biggest unlock, single well-documented format. Subsumes 3-4 TCP:55558 tools and shifts them offline permanently.
2. **`read_datatable_source` / `list_data_sources` / `read_string_table_source`** — cheap, forward-compat, covers a likely-imminent authoring surface.
3. **`inspect_blueprint`** — closes the Blueprint-visibility gap for a CLI agent. Parser reuses `.umap` walker work.
4. **`list_level_actors`** — useful but narrower than `inspect_blueprint`. Co-build with #3.
5. **Phase 1.5 cleanup (D29)** — can happen in parallel with any of the above; zero dependency.

Build order #3 + #4 together — shared parser code.

---

## 7. Decisions (resolved 2026-04-13 with Noah)

### 7.1 Sequencing — RESOLVED: offline-first, blocks Phase 2/3 continuation (D30)

Any tool identified as belonging offline is built before further TCP work. This supersedes the original Phase 2 → Phase 3 ordering. `query_asset_registry` is critical path; its existence reshapes what TCP:55558 tools need to be built at all. Captured as **D30**.

**Impact on existing plan**: D23 (UEMCP absorption of TCP:55557 tools) is unaffected. The Phase 3 scope shrinks because `search_assets`, `get_class_hierarchy`, `find_blueprints_implementing_interface`, and related registry-backed tools move offline permanently. Captured as **D32**.

### 7.2 Stale-registry policy — RESOLVED: drift-based detection with `allow_stale` escape hatch (D33)

> **AMENDMENT A (2026-04-13, same-day): §7.2 below is SUPERSEDED.** Agent 1's post-audit verification of registry state on the two target projects found that ProjectB has never been cooked (no `DevelopmentAssetRegistry.bin` exists) and ProjectA's registry was 6 days stale. This invalidated the "parse the registry binary" approach as the sole offline index source.
>
> **Approach revised to header scanning.** Every `.uasset` file embeds an `FAssetRegistryData` block in its header — the same data the editor uses to rebuild the registry cache. Parsing headers directly achieves parity on 4 of 5 use cases (search_assets, get_class_hierarchy, forward refs, find_blueprints_implementing_interface) and works without a cook step, so ProjectB is supported out of the box. Reverse-dep lookup is O(N) — solved with a cached reverse index built at server startup.
>
> **Staleness model replaced, not patched.** With no registry to compare against, the "drift between registry and disk" signal has no referent. The new freshness model is an in-memory `assetCache` with hybrid TTL + mtime/size-diff + write-suspicion invalidation (Option D). Per-file freshness is checked on every pointed query via `shouldRescan()`. Bulk queries sweep at most every 60s. Response metadata reports `files_added_since_last_sweep` and `files_removed_since_last_sweep` for transparency instead of a gate+escape-hatch pattern. The `allow_stale` parameter is **dropped** — sweep-on-TTL is cheap enough (~1s for 10k files on SSD) that automatic refresh replaces explicit opt-in.
>
> **Canonical source now**: **revised D33** in `docs/tracking/risks-and-decisions.md`. The body of §7.2 below is retained for audit-trail continuity; do not implement against it.
>
> **Rejected alternatives from original §7.2 remain valid reasoning** for why time-only thresholds and blanket refusals are wrong — those arguments transfer cleanly to the new model and are why we dropped the `allow_stale` gate rather than keeping it with different triggers.

---

**Key reframe**: staleness is not about time, it is about *drift*. A 30-day-old registry for an untouched project is accurate; a 1-hour-old registry for a project where 50 Blueprints were just added is not. Time-based thresholds (the initial proposal) measure the wrong thing. The real signal is whether the on-disk content has diverged from the registry's view of it.

**Primary signal — drift detection**. Every `query_asset_registry` response includes:

- `assets_on_disk_not_in_registry: N` — count of `.uasset` / `.umap` files under `Content/` whose paths don't appear in the registry index.
- `assets_with_mtime_newer_than_registry: N` — count of content files whose filesystem mtime is newer than the registry file's mtime.
- `drift: true | false` — true if either count above is non-zero.

**Escape hatch**: When drift exceeds a meaningful threshold (initial guess: >50 files OR >5% of total indexed assets, whichever is smaller), the tool errors unless the caller passes `allow_stale: true`. The error message includes the drift counts so the agent knows what it's accepting.

This preserves the "no blanket refusal" principle from the original 7.2 — any caller can override with one explicit parameter — while making the stale-data decision *legible in the call itself*. In logs and transcripts, `allow_stale: true` distinguishes "knowingly accepted stale data" from "ignored a warning."

**Secondary signal — age** (informational only, not used for gating):
- `registry_timestamp` — always returned.
- `registry_age_days` — always returned.
- A soft `warning` string may accompany responses when `age_days > 7` AND `drift: true` — reinforces to the agent that data is both old and known-diverged.

**P4 workspace refinement**: Both ProjectA and ProjectB are Perforce projects. P4 `sync` rewrites local file mtimes to sync time by default, so local-mtime comparison can produce false drift signals after a fresh sync. Implementation should prefer `p4 fstat headModTime` (server-side last-modify time) when the P4 CLI is available, with graceful fallback to local mtime when P4 is offline or the workspace isn't configured. See `CLAUDE.md` "Perforce Workflow" section for connection flags.

**Rejected alternatives**:
- **Time-only threshold (original 7.2)**: measures drift proxy, not drift itself. Produces false positives on stable projects and false negatives on rapidly-changing ones.
- **Blanket refusal above N days**: paternalistic, arbitrary, forecloses legitimate historical/archaeology queries.
- **Auto-regen via TCP**: out of scope for pre-TCP work; coupling a read tool to a minutes-long side-effecting cook operation is wrong even later.

**Orthogonal correctness note**: The registry reflects assets present at last generation. The tool's description must always state: "If an expected asset is missing, verify it existed at last registry generation." This is a universal rule that applies regardless of drift or age signals.

**Threshold calibration**: The "50 files OR 5%" threshold is an initial guess. Calibration happens at implementation time — see D29/D30 follow-up decisions and the `computeDriftStatus()` function in `query_asset_registry`'s implementation.

### 7.3 Phase 1.5 cleanup — RESOLVED: drop 3, reframe 1 (D31)

**Drop outright** from the offline toolset:
- `read_source_file` (Read is strictly superior)
- `search_source` (Grep is strictly superior)
- `browse_content` (Glob `**/*.uasset` is equivalent)

**Reframe**: `get_asset_info` — drop the current `fs.stat`-based implementation, reserve the tool name. Once `query_asset_registry` lands, reimplement as "given an asset path, return all registry metadata (class, parent, dependencies, tags)." That version is genuinely useful and non-redundant.

**Replacement guidance**: `SERVER_INSTRUCTIONS` gains a short section orienting the CLI agent toward its native capabilities:
> For source file reading use `Read`; for source search use `Grep`; for content tree browsing use `Glob`. UEMCP offline tools cover UE-specific parsing that native tools cannot do (gameplay tags, config drill-down, Target.cs parsing, binary asset registry).

Rationale: the "safety rail" framing in the initial draft was wrong. These tools predate our full understanding of Claude Code's native capabilities. They are not defensive — they are redundant, and redundancy has real cost in a 40-tool-budget dynamic-toolset system (lower ToolIndex precision, noisier `tools/list`, invites wrapper-preference over native-tool use).

Captured as **D31** in `docs/tracking/risks-and-decisions.md` since the policy is persistent, not a point-in-time finding.

### 7.4 Build order — RESOLVED (implements D30)

Critical path, in order:

1. **`query_asset_registry`** — biggest unlock, blocks downstream registry-backed work. Scope includes drift detection (7.2): filesystem scan of `Content/` tree, optional P4 `fstat` integration, `allow_stale` parameter.
2. **Phase 1.5 cleanup (D31)** — lands alongside #1 so `get_asset_info` reframes cleanly without a gap.
3. **`read_datatable_source` / `list_data_sources` / `read_string_table_source`** — cheap forward-compat, no dependency on #1.
4. **`inspect_blueprint` + `list_level_actors`** — co-built; shared `.uasset` / `.umap` parser idioms established by #1.
5. **Resume Phase 2 / enter Phase 3** with registry-backed TCP tools struck from scope.

---

## Appendix A — Sources

- `docs/specs/conformance-oracle-contracts.md` — 36 UnrealMCP handler contracts.
- `docs/tracking/risks-and-decisions.md` — D17 (iteration speed with AI-assisted dev), D23 (UEMCP absorption plan).
- UE source: `Engine/Source/Runtime/AssetRegistry/Private/AssetRegistryState.cpp` (format reference).
- Third-party reference implementations (format-compat checks): CUE4Parse, UAssetAPI.
- Sample files: `D:\UnrealProjects\5.6\ProjectA\ProjectA\Config\DefaultGameplayTags.ini`, `D:\UnrealProjects\5.6\ProjectA\ProjectA\Source\ProjectA\Public\GAS\Attributes\OSAttributeSet.h`, `D:\UnrealProjects\5.6\BreakoutWeek\ProjectB\Source\ProjectB\Public\GAS\Attributes\ZKAttributeSetLivingEntity.h`.
