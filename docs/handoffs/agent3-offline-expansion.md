# Agent 3 Handoff — Track 2: Offline Tool Expansion + Phase 1.5 Cleanup

## Who you are

You are a fresh implementer agent working on **UEMCP** (`D:\DevTools\UEMCP\`). Read `D:\DevTools\UEMCP\CLAUDE.md` first — architecture, 4-layer model, conventions.

You are Agent 3 of two parallel agents. Agent 2 is working Track 1 (TCP P0 remediation). File scopes do not overlap — don't touch `connection-manager.mjs`, `tcp-tools.mjs`, `test-tcp-tools.mjs`, `test-helpers.mjs`, or `docs/specs/phase3-plugin-design-inputs.md`.

## Required reading before you code

1. `D:\DevTools\UEMCP\CLAUDE.md` — project overview, standards
2. `D:\DevTools\UEMCP\docs\audits\offline-tool-expansion-audit-2026-04-13.md` — **SEALED audit with Amendment A on §7.2**. Amendment A supersedes the original drift-based staleness model. Canonical freshness model is the revised D33. Do not edit the audit body; if you find new issues, amend using the blockquote pattern already established in §7.2.
3. `D:\DevTools\UEMCP\docs\tracking\risks-and-decisions.md` — **D30** (offline-first sequencing), **D31** (Phase 1.5 cleanup), **D32** (TCP scope reduction), **D33 revised 2026-04-13** (canonical freshness/cache model)
4. `D:\DevTools\UEMCP\server\offline-tools.mjs` — 10 existing offline tools + the new `assetCache` + `shouldRescan()` singleton already added. Scaffolding is in place; you consume it.
5. `D:\DevTools\UEMCP\tools.yaml` — single source of truth for tool definitions.
6. `D:\DevTools\UEMCP\server\test-phase1.mjs` — existing offline test patterns to extend.

---

## Track 2a — Offline expansion (build these tools, in this order)

Ranked by leverage-per-effort per audit §6. Headers are tool names.

### 1. `query_asset_registry` — PRIMARY UNLOCK

**Approach: header scanning (per Amendment A).** Original audit proposed parsing `DevelopmentAssetRegistry.bin`. Dead approach — ProjectB has never been cooked, ProjectA's .bin was 6 days stale. **New approach**: scan `.uasset` / `.umap` headers directly. Every package embeds an `FAssetRegistryData` block with the data the editor uses to rebuild the registry cache.

**Returns per asset**: full object path, class name, package dependencies (hard + soft), class-specific tags. Blueprint tags include `ParentClass`, `ImplementedInterfaces`, `NativeParentClass`, `NumReplicatedProperties`.

**Capabilities unlocked (previously TCP-only, now offline)**:
- `search_assets` by class/path/tag
- `get_class_hierarchy`
- `get_asset_references` / `get_asset_dependencies` (reverse-dep — build cached O(N) reverse index at first query)
- `find_blueprints_implementing_interface`

**Freshness**: consume `assetCache` + `shouldRescan()` already in `offline-tools.mjs`. Per revised D33:
- 60s bulk TTL sweep
- per-file `mtime + size` invalidation via `shouldRescan()`
- read `assetCache.indexDirty` flag (Phase 3 TCP write-ops will set this later — you just consume the signal on reads)
- response metadata: `files_added_since_last_sweep`, `files_removed_since_last_sweep`
- **do not** implement the dropped `allow_stale` parameter

**Dependency**: needs a working `.uasset` header parser. See Track 2c — start there, circle back here.

### 2. `read_datatable_source` / `list_data_sources` / `read_string_table_source`

Cheap, forward-compat. Neither project uses DataTables/StringTables today but both likely will.

- `list_data_sources` — aggregates across `Content/` answering "what data is in this project?"
- `read_datatable_source` — encodes UE CSV conventions: first column = row name, `---` header delimiter behavior, type-column introspection from companion `RowStruct` header reference
- `read_string_table_source` — `StringTable.csv` format, namespace/key layout

No binary parsing needed. Claude Code can read the CSVs raw — these tools encode the UE conventions.

### 3 + 4. `inspect_blueprint` + `list_level_actors` — co-build (shared package-format parser)

**`inspect_blueprint`** walks a Blueprint `.uasset` export table and returns:
- Parent class (native or Blueprint)
- Implemented interfaces
- Variable list (names + type imports)
- Function list (`UFunction` exports)
- Component tree (`USCS_Node` exports, parent pointers)

Closes a real Claude Code gap — Blueprint-only classes and BP-derived variables are invisible to `Read`-based C++ inspection.

**`list_level_actors`** walks a `.umap` export table. Returns `[{label, class, packagePath}]`. Does **not** return property values — that's the hard half of a parser. Property values stay on TCP.

Co-build because they share the same package-format idioms: `FPackageFileSummary` header + name table + export table walker. No per-property type dispatch needed.

### tools.yaml entries

Every new tool needs a full `tools.yaml` entry: `name`, `description`, `layer: offline`, `toolset: <appropriate>`, full `params` schema with types / required flags / descriptions. Register in `server.mjs` following the existing offline tool pattern.

---

## Track 2b — Phase 1.5 cleanup (D31, verbatim from §7.3)

**Drop outright** — remove from `tools.yaml`, remove handlers from `offline-tools.mjs`, remove registrations from `server.mjs`, remove tests:

- `read_source_file` — `Read` is strictly superior
- `search_source` — `Grep` is strictly superior
- `browse_content` — `Glob **/*.uasset` is equivalent

**Reframe**: `get_asset_info` — drop the `fs.stat`-based implementation, reserve the tool name. Once `query_asset_registry` lands in Track 2a, reimplement as "given an asset path, return all registry metadata (class, parent, dependencies, tags)." Land in the same changelist as `query_asset_registry` so there's no capability gap.

**Keep**: `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `list_plugins`, `get_build_config`.

**Update `SERVER_INSTRUCTIONS`** in `server.mjs` to add (verbatim from §7.3):
> For source file reading use `Read`; for source search use `Grep`; for content tree browsing use `Glob`. UEMCP offline tools cover UE-specific parsing that native tools cannot do (gameplay tags, config drill-down, Target.cs parsing, binary asset registry).

Organize drops in their own commit(s), separate from Track 2a expansion so the diff is legible.

---

## Track 2c — `.uasset` parser research (blocking for Track 2a items 1, 3, 4)

Research doc at `D:\DevTools\UEMCP\docs\research\uasset-parser-options-2026-04-14.md`. Decide: **vendor** existing Node/JS parser, or **hand-write** minimal FAssetRegistryData block reader.

### What we need from a header

- `FPackageFileSummary`: name table offset/count, export table offset/count, `FAssetRegistryData` tag block offset
- Name table walker (resolving FName indices in exports)
- Export table walker (class name, object path, outer resolution)
- `FAssetRegistryData` tag block reader — key/value pairs with `ParentClass`, `ImplementedInterfaces`, dependencies, etc.

We do **not** need: full property-system deserialization, asset body deserialization, PIE-only data.

UE 5.6 is the target version.

### Candidates to evaluate

Check npm + GitHub. For each, record: last commit date, license, UE version coverage, maintenance status, does it expose FAssetRegistryData specifically, install size / dep tree.

Known candidate names to investigate (verify currency — don't assume any exist on npm): `unreal-asset`, `uasset-reader`. Python references (CUE4Parse, UAssetAPI) useful as format specs but not directly usable from Node.

### Hand-written option

Rough LOC estimate for: `FPackageFileSummary` reader, name table reader, export table walker (enough for class names), `FAssetRegistryData` tag block reader.

Reference source: `Engine/Source/Runtime/AssetRegistry/Private/AssetRegistryState.cpp` and `Engine/Source/Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp` (UE 5.6 install: `C:\Program Files\Epic Games\UE_5.6\Engine\Source\...` if present).

### Deliverable

Short doc (~1-2 pages), clear recommendation with justification. Noah decides after reading — **do not implement either option without sign-off**. If recommendation is "vendor X", pause Track 2a items 1/3/4 until Noah confirms. Item 2 (DataTable/StringTable source readers) has no parser dependency — proceed in parallel.

---

## Deliverables summary

1. `query_asset_registry` implemented + registered + tested (blocked on 2c sign-off)
2. DataTable/StringTable source readers (3 tools) implemented + registered + tested
3. `inspect_blueprint` + `list_level_actors` co-built + registered + tested (blocked on 2c sign-off)
4. Phase 1.5 D31 cleanup executed (3 drops + `get_asset_info` reframe + `SERVER_INSTRUCTIONS` update)
5. `docs/research/uasset-parser-options-2026-04-14.md` with recommendation
6. `tools.yaml` updated for all new tools + dropped tool removals
7. `test-phase1.mjs` assertion count expanded — state new total
8. **D-log entry (D36)** in `docs/tracking/risks-and-decisions.md` summarizing offline expansion + D31 cleanup + parser-research outcome. D36 is pre-allocated by the orchestrator — do not pick a different number. D34 (two-track dispatch) and D35 (Agent 2's server-patchable vs plugin-only scope split) are already spoken for.

## Testing

Baseline green first:

```
cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-phase1.mjs
cd /d D:\DevTools\UEMCP\server && node test-mock-seam.mjs
cd /d D:\DevTools\UEMCP\server && node test-tcp-tools.mjs
```

(CMD: no space before `&&`.) All three stay green post-changes. Focus assertion expansion on `test-phase1.mjs`.

## Working style

- Direct communication, YAGNI, no AI attribution in commits / docs / code
- CMD shell, snake_case params for offline tools (convention per CLAUDE.md)
- Ambiguity → stop and ask Noah
- Ground research in real files: `D:\UnrealProjects\5.6\ProjectA\ProjectA\Content\` and `D:\UnrealProjects\5.6\BreakoutWeek\ProjectB\Content\` have real `.uasset` / `.umap` to test parsers against

## Done criteria

- Parser research doc delivered with clear recommendation
- DataTable/StringTable tools shipped
- Header-scan tools shipped (post-parser sign-off)
- Phase 1.5 D31 executed
- All three test suites green with expanded `test-phase1.mjs` assertion count
- D36 D-log entry committed
- Final summary to Noah: tools added, tools dropped, assertion count delta, parser recommendation, any blocked items awaiting sign-off
