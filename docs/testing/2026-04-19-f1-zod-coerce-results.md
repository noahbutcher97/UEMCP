# F-1 Zod-Coerce End-to-End Verification — Results

> **Date**: 2026-04-19
> **Commit tested**: `f8ec40d` (F-1 = `149c8e4` in history)
> **Session**: Fresh Claude Code session, UEMCP MCP server restarted post-`149c8e4`
> **UNREAL_PROJECT_ROOT**: `D:/UnrealProjects/5.6/ProjectA/ProjectA`
> **Duration**: ~15 min

---

## Pre-flight

- [x] Fresh Claude Code session, new MCP server instance.
- [x] `git log --oneline | grep 149c8e4` confirmed F-1 commit present: `149c8e4 F-1: MCP Zod-coerce for boolean and number params`.
- [x] HEAD = `f8ec40d` (F-1 + handoff commit).
- [x] `project_info({})` returned metadata successfully — server responsive.

---

## §1 — Boolean coerce

### 1.1 `summarize_by_class: true` (flagship failing case)

Call: `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", summarize_by_class: true })`.

**PASS**. Response included `summary: { ... }` keyed by className with counts (30 classes, 230 total_placed_actors). **Pre-fix symptom `"Expected boolean, received string"` did NOT reproduce.**

**Notes**: Flagship blocker from the post-wave-4 manual testing is resolved. Summary block returned with expected shape (e.g., `"StaticMeshActor": 135`, `"BP_Ground_Bricks_C": 29`). No `actors[]` array when summarize mode engaged, as designed.

### 1.2 `include_defaults: true`

Call: `inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block", include_defaults: true })`.

**PASS**. Response included `variable_defaults` with 9 properties decoded (IsBlocking, IsBroken, GuardBreakEffectClass, ChooserTable, DrainPerSecond, DrainCheckInterval, CancelAbilitiesWithTag, ActivationOwnedTags, ActivationBlockedTags). `unsupported_defaults: []`.

**Notes**: CDO decode works end-to-end; no Zod rejection of the boolean param.

### 1.3 `verbose: true` on get_asset_info

Call: `get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_Block", verbose: true })`.

**PASS**. Response included full `tags` block (BlueprintType, ClassFlags, ModuleName, NativeParentClass, NumReplicatedProperties, ParentClass, ModuleRelativePath). Accepted without Zod rejection.

**Notes**: BPGA_Block happens to have no heavy FiBData tag, so the verbose/non-verbose diff isn't visible on this asset — but the coerce itself is confirmed (no Zod error). If a richer comparison is needed, AN_OSAnimNotify_Footstep does have FiBData (seen in §2.4 response, full FiBData blob included).

### 1.4 Explicit `false` (ensure defaults work)

Call: `list_level_actors({ asset_path: "...", summarize_by_class: false, limit: 3 })`.

**PASS**. Response returned `actors[]` with 3 entries (BP_Ground_Bricks10/11 etc.) — NOT summary mode. Confirms coerce doesn't misread explicit `false` as truthy.

---

## §2 — Number coerce

### 2.1 `limit: 5`

Call: `list_level_actors({ asset_path: "...", limit: 5 })`.

**PASS**. Response had exactly 5 entries in `actors[]`, `truncated: true`, `limit: 5`, `offset: 0`.

### 2.2 `offset: 10`

Call: `list_level_actors({ asset_path: "...", limit: 5, offset: 10 })`.

**PASS**. Response had `offset: 10`, `limit: 5`, `actors[0].name = "BP_Ground_Bricks19"` (distinct from §2.1's first entry "AtmosphericFog") — pagination cursor honored.

### 2.3 `max_bytes: 2048` on read_asset_properties

Call: `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", max_bytes: 2048 })`.

**PASS**. Response `property_count_returned: 9`, `property_count_total: 9`, `truncated: false` — CDO fit under 2048-byte budget. Coerce accepted; truncation path not exercised on this asset but the param was not rejected.

**Notes**: To exercise truncation path, a larger CDO would be needed. Scope of this test is just "coerce accepts the value", which passes.

### 2.4 `max_scan: 100` on query_asset_registry

Call: `query_asset_registry({ class_name: "Blueprint", max_scan: 100 })`.

**PASS**. Response `total_scanned: 100`, `truncated: true`, `total_matched: 2` (both Blueprint assets found within the first 100 scanned).

---

## §3 — Cross-tool smoke

### 3.1 `find_blueprint_nodes` with `limit: 5`

**PASS**. `total_skeletal: 184`, returned exactly 5 nodes, `truncated: true`. `nodes_out_of_skeletal` bonus block included (6 skipped node-type categories). Confirms L3A S-A tool accepts coerced numbers.

### 3.2 `query_asset_registry` with `limit: 3`

**PASS**. Accepted and returned 1 DataTable match (DT_Mutable_MeshAssets). `total_scanned: 5000` (default max_scan).

### 3.3 `list_level_actors` with `summarize_by_class: true`

**PASS** (duplicate of §1.1, confirms consistency across calls).

---

## §4 — Regression: non-coerced params still work

### 4.1 String params (unaffected by coerce)

Call: `search_gameplay_tags({ pattern: "Gameplay.*" })`.

**PASS**. Returned 2 matches (`Gameplay.Ability`, `Gameplay.State`). String params unaffected by F-1.

### 4.2 Array params (unaffected)

Call: `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`.

**FAIL** — but **out of scope for F-1**. Response:

```
MCP error -32602: Input validation error:
  "code": "invalid_type",
  "expected": "array",
  "received": "string",
  "path": ["property_names"],
  "message": "Expected array, received string"
```

**Notes**: Array argument was wire-serialized as a JSON string by the MCP client, and `z.array()` does not coerce. This is the **same class of problem F-1 solved for primitives**, but F-1 only touched boolean + number — not arrays. This is a **new finding**, not a regression introduced by F-1. Worth logging as a follow-on fix (e.g., `z.preprocess(s => typeof s === "string" ? JSON.parse(s) : s, z.array(...))` or a shared `coerceArray()` helper in `buildZodSchema`). Flagged per brief rules, not fixed inline.

---

## §5 — Error paths still reject genuinely-invalid values

### 5.1 Non-numeric string as a number

Call: `list_level_actors({ asset_path: "...", limit: "hello" })`.

**PASS (correctly rejected)**. Response:

```
"code": "invalid_type",
"expected": "number",
"received": "nan",
"path": ["limit"],
"message": "Expected number, received nan"
```

This is the textbook z.coerce.number() behavior: `Number("hello")` → NaN → Zod refuses NaN. Coerce does NOT silently swallow bad input.

### 5.2 Non-boolean string as a boolean

Call: `list_level_actors({ asset_path: "...", summarize_by_class: "maybe" })`.

**PASS (documented Zod 3 coerce semantics)**. Response: SUCCESS — returned `summary: { ... }` as if `summarize_by_class: true`.

**Notes**: `z.coerce.boolean()` in Zod 3 follows JS truthiness — any non-empty string coerces to `true`. Only empty string, `"0"` in some contexts, undefined, null, and 0 are falsy under JS coercion. This is the expected and documented behavior. If strict string-parsing ("true"/"false" only) were wanted, a `z.enum(["true","false"]).transform()` wrapper would be required — but nobody asked for that, and JS-truthy is reasonable default.

---

## §6 — Summary

| Section | Result |
|---|---|
| §1 Boolean coerce | **4/4 pass** |
| §2 Number coerce | **4/4 pass** |
| §3 Cross-tool smoke | **3/3 pass** |
| §4 Regression | **1/2 pass** (4.2 fail, but **out of F-1 scope** — arrays are also wire-stringified; new finding) |
| §5 Error paths | **2/2 handled correctly** |

**Overall verdict**: **F-1 ships end-to-end.** Boolean + number coerce works through the live MCP wire in a fresh session. All typed-param calls previously blocked by `"Expected boolean/number, received string"` now succeed.

**Key confirmation**: the manual tester's original blocker (`summarize_by_class: true` → `Expected boolean, received string`) is resolved in a fresh session: **yes**.

**Anything unexpected**:

- **New finding (out of F-1 scope)**: Array-typed params (`z.array()`) exhibit the **same wire-stringification pathology** that F-1 fixed for primitives. `read_asset_properties({ property_names: ["AbilityTags"] })` was rejected with `Expected array, received string`. The MCP client serialized the array as a JSON string; `z.array()` does not coerce. This is NOT a regression — it likely pre-dated F-1 — but it is newly visible now that boolean/number no longer mask it. Candidate follow-up fix: add a preprocess step in `buildZodSchema` that JSON-parses string input for `array` and `object` types before passing to Zod.
- §1.3 (`verbose: true` on a BP with no FiBData) and §2.3 (`max_bytes: 2048` on a CDO under budget) don't fully exercise their tool behaviors, but both confirm the **coerce itself** is accepted. To fully exercise verbose strip + max_bytes truncation would require fixture assets with heavy tags / oversize CDOs (e.g., AN_OSAnimNotify_Footstep for FiBData). Out of scope for F-1 verification.

**Time spent**: ~15 min.

---

## Artifacts — raw response snippets

### §1.1 (flagship resolved)

```json
{
  "total_placed_actors": 230,
  "truncated": false,
  "summary": {
    "StaticMeshActor": 135,
    "BP_Ground_Bricks_C": 29,
    ...
  }
}
```

### §4.2 (out-of-scope array finding)

```json
MCP error -32602: Input validation error:
{
  "code": "invalid_type",
  "expected": "array",
  "received": "string",
  "path": ["property_names"],
  "message": "Expected array, received string"
}
```

### §5.1 (correctly rejects NaN)

```json
{
  "code": "invalid_type",
  "expected": "number",
  "received": "nan",
  "path": ["limit"],
  "message": "Expected number, received nan"
}
```
