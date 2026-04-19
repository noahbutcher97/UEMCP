# Manual Testing Handoff — Post-Wave-4 Offline Tier Surface

> **Dispatch**: Parallel-safe with Audits A + B (different file scopes — you hit MCP tools; they read docs/source).
> **Session**: Fresh Claude Code session at UEMCP project root, MCP server connected, UEMCP toolset auto-enabled.
> **Duration**: 30-45 minutes.
> **Output**: Fill pass/fail + notes inline; save as `docs/testing/2026-04-19-post-wave4-manual-results.md`.

---

## Mission

Validate the capabilities shipped since Agent 10.5's manual test (results at `docs/testing/2026-04-16-agent10-5-manual-results.md`). Three worker waves landed after that test:

- **Polish Worker** (commit `8812c1c`) — 7 response-shape ergonomic fixes across Option C tools
- **Parser Extensions Worker** (commits `bdd1527`, `f3ae608`) — FieldPathProperty L1 dispatcher case + FExpressionInput native binary + 7 MaterialInput variants
- **Cleanup Worker** (commits `905c48e`, `de8d146`) — matchTagGlob (no new RegExp on gameplay-tag search path) + int64 salvage at `readExportTable` (127 VFX mesh files now parse)

Test baseline is now 709/709 (436 primary + 258 supplementary). Your job is to verify the live-tool surface actually delivers what the final reports claimed.

---

## Pre-flight

- [ ] UNREAL_PROJECT_ROOT = `D:/UnrealProjects/5.6/ProjectA/ProjectA`
- [ ] MCP server running; HEAD at `0f5df4d` or later
- [ ] All 7 test suites green (709 total)

---

## §1 — Polish Worker's 7 items (P1-P7 in the response-shape space)

### 1.1 P1 — summary-mode omits offset/limit
Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", summarize_by_class: true })`.

Expected: response has `summary: { className: count }` + `total_placed_actors`; does NOT contain `offset` or `limit` fields.

**PASS/FAIL**:  **Notes**:

### 1.2 P2 — filter-scoped unsupported[]
Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`.

Expected: `unsupported[]` contains ONLY markers for `AbilityTags` and any `__stream__`-wide markers (like `unexpected_preamble`). No entries for other unrelated properties.

**PASS/FAIL**:  **Notes**:

### 1.3 P3 — no `packageIndex` leakage
Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", limit: 5 })`.

Expected: response JSON contains NO `packageIndex` field at any nesting depth. Grep the response for "packageIndex"; it should be absent.

**PASS/FAIL**:  **Notes**:

### 1.4 P4 — duplicate markers deduped
Find a response that previously surfaced duplicate `unsupported[]` entries (check earlier test notes). Re-run the call.

Expected: `unsupported[]` entries unique by `{name, reason}` tuple.

**PASS/FAIL**:  **Notes**:

### 1.5 P5 — `unexpected_preamble` documented
Check `tools.yaml` → `offline.tools.read_asset_properties.description` (or adjacent docs). Look for reason-code catalog mentioning `unexpected_preamble`.

Expected: the reason code is documented either in the yaml description, the tool's inline help, or tracked via `find_tools`. No longer "undocumented."

**PASS/FAIL**:  **Notes**:

### 1.6 P6 — delegate-path test note
Not user-visible; `test-phase1.mjs` has an explanatory comment on the delegate test. Skip if you're not inspecting the test file.

### 1.7 P7 — response field ordering
Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", limit: 3 })`. Inspect row ordering.

Expected: rows show consistent field order (e.g., `{name, className, classPackage, outer, bIsAsset, transform, unsupported?}`). No random-looking field mix.

**PASS/FAIL**:  **Notes**:

---

## §2 — Parser Extensions capabilities

### 2.1 FieldPathProperty resolves (FGameplayAttribute.Attribute)
Find a BP CDO holding a `FGameplayAttribute` (look for GAS AttributeSet refs, ability-cost attributes, etc.). `BPGE_GenericCost` is a likely candidate.

Call `read_asset_properties({ asset_path: "/Game/GAS/Effects/BPGE_GenericCost" })`.

Expected: any `FGameplayAttribute.Attribute` property that previously emitted nested `{unsupported: "unknown_property_type", type: "FieldPathProperty"}` now resolves to `{ owner: <path>, path: ["<FName1>", "<FName2>"] }` structure.

**PASS/FAIL**:  **Notes**:

### 2.2 FExpressionInput decodes on Material fixtures
Find a Material asset. ProjectA has `/Game/ProjectA/Art/VFX/Materials/` candidates. Or use `query_asset_registry class_name:Material limit:5` to find one.

Call `read_asset_properties({ asset_path: "/Game/<path-to-material>" })`.

Expected: any `FExpressionInput`-based property (inputs on material expressions) decodes to `{ expression: {path, index}, outputIndex, inputName, mask, maskR, maskG, maskB, maskA }` structure, NOT `expression_input_native_layout_unknown` marker.

**PASS/FAIL**:  **Notes**:

### 2.3 MaterialInput variants (FColorMaterialInput, FScalarMaterialInput, etc.)
Same fixture or a different Material. Look for properties typed `FColorMaterialInput`, `FScalarMaterialInput`, `FVectorMaterialInput`, `FVector2MaterialInput`, `FShadingModelMaterialInput`, `FSubstrateMaterialInput`, `FMaterialAttributesInput`.

Expected: each variant decodes to the base expression-input fields PLUS `{ useConstant: bool, constant: <variant-specific value> }`. No generic `unknown_struct` markers for these named variants.

**PASS/FAIL**:  **Notes**:

---

## §3 — Cleanup Worker capabilities

### 3.1 `matchTagGlob` behaves like the old regex
Call `search_gameplay_tags({ pattern: "Gameplay.*" })` or a project-specific pattern.

Expected: returns matching tags. Behaviorally identical to what the old dynamic-regex path returned. No error about invalid input; whitelist + nosemgrep annotation are gone from the implementation (can verify via `grep -n "nosemgrep" server/offline-tools.mjs` — should return nothing).

**PASS/FAIL**:  **Notes**:

### 3.2 Glob patterns work per CLAUDE.md spec
Try multiple patterns:
- `*` — single-segment wildcard
- `**` — multi-segment wildcard
- Exact tag name
- Partial prefix

Expected: each returns the same results as the old regex implementation would have.

**PASS/FAIL**:  **Notes**:

### 3.3 int64 salvage — VFX mesh files now parse
Find a VFX mesh file that was previously failing. Agent 10.5's bulk validation identified 127 of them post-Parser-Extensions. Pattern-match on `/Game/ProjectA/Art/VFX/` paths ending `.uasset` with large file sizes.

Call `get_asset_info({ asset_path: "/Game/<vfx-mesh-path>" })`.

Expected: returns asset info (maybe partial summary with `int64_overflow: true` marker) instead of throwing. File-level parse SUCCEEDS.

**PASS/FAIL**:  **Notes**:

### 3.4 No regression on non-overflow files
Verify that `get_asset_info` still works correctly on ordinary (non-VFX) assets. Any BP or DataTable from ProjectA.

**PASS/FAIL**:  **Notes**:

---

## §4 — Regression smoke test

Quick sanity that Agent 10 + Agent 10.5 capabilities still work:

- [ ] `list_level_actors` returns transforms on small maps
- [ ] `inspect_blueprint` with `include_defaults: true` returns `variable_defaults`
- [ ] `read_asset_properties` resolves UUserDefinedStruct values (e.g., `BP_OSPlayerR.cacheAura → {School, Tier, Energy}`)
- [ ] `find_blueprint_nodes` returns 184 skeletal nodes on `BP_OSPlayerR`
- [ ] `query_asset_registry`, `get_asset_info`, `list_gameplay_tags`, `list_config_values`, `project_info` all functional

**PASS/FAIL** for each:

---

## §5 — Free-form agent-workflow exploration

Run 2-3 realistic queries that exercise the newly-unlocked surface:

1. "What's the default Attribute ref on BPGE_GenericCost's cost calculation?" → tests FieldPathProperty decode
2. "What material expressions feed the Emissive input of <some Material>?" → tests FExpressionInput + variants
3. "Find all BPs in /Game/GAS that handle OnDamaged events" → tests find_blueprint_nodes composition

Notes on ergonomics, response shape, surprises:

---

## §6 Summary

| Section | Result |
|---|---|
| §1 Polish (P1-P7) | X/7 pass |
| §2 Parser Extensions | X/3 pass |
| §3 Cleanup | X/4 pass |
| §4 Regression smoke | X/8 pass |
| §5 Free-form | notes |

**Overall verdict**: [ship / minor issues / blocker]

**Items flagged to orchestrator**:
- [ ]

**Time spent**: _ min

---

## Rules

- Read-only testing. No code/yaml edits. If you find a bug, flag in notes and continue.
- Single committed results file at the end via path-limited `git commit <path> -m`.
- Desktop Commander for git (shell: "cmd").
- No AI attribution.
- If MCP server crashes or desync, stop and report.
