# Manual Testing Handoff — EN-2 `find_blueprint_nodes_bulk` (+ F-1.5 belt-and-braces)

> **Dispatch**: Fresh Claude Code session with restarted MCP server (loads post-`ae7fb96` code).
> **Type**: Focused manual test — EN-2 primary, F-1.5 sanity secondary.
> **Duration**: 20-30 minutes.
> **Output**: Fill pass/fail + notes inline; save as `docs/testing/2026-04-20-en2-results.md`.

---

## Mission

EN-2 Worker shipped `find_blueprint_nodes_bulk` (corpus-wide K2Node scan; commits `125a62c`/`53daaed`/`ae7fb96`). 42 new tests pass structurally — 36 unit + 6 MCP-wire. **What remains unverified**: that the tool actually behaves correctly through the live MCP wire with a real Claude Code session, including the two design deviations from the handoff spec:

1. **`scan_truncated` + `page_truncated` split** (not a single `truncated` bool) — each flag should tell the caller which knob to turn.
2. **`max_scan` semantic**: means "BPs processed" not "files walked" — defaults should surface the full ProjectA BP corpus, not the first 12 files.

Secondary goal: sanity-check F-1.5 (array-param wire preprocess, commits `2789ef1`/`b936585`) by passing an array through `read_asset_properties.property_names` end-to-end. Structural MCP-wire coverage exists; this is belt-and-braces through real Claude Code.

---

## Pre-flight

- [ ] Close the current Claude Code session fully (if any is connected to UEMCP).
- [ ] Restart the UEMCP MCP server (closing + reopening the IDE window typically triggers this).
- [ ] Verify the new server has `ae7fb96` loaded or later — check via `git log --oneline -5` in a shell if in doubt.
- [ ] `UNREAL_PROJECT_ROOT = D:/UnrealProjects/5.6/ProjectA/ProjectA`.
- [ ] Confirm server is responsive: call `project_info({})`. Should return project metadata.
- [ ] Confirm new tool is registered: call `find_tools({ query: "find_blueprint_nodes_bulk" })`. Should return the tool in top results with the offline toolset already active.

---

## §1 — Smoke test: default behavior

### 1.1 Broadest scan (no filters)

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/" })`.

Expected:
- SUCCESS.
- `total_bps_scanned` is meaningful (hundreds — ProjectA has ~469 BPs).
- `total_bps_scanned` > 12 (sanity check for the max_scan semantic fix — if you see ~12 BPs returned, the regression is back).
- `total_bps_matched` ≤ `total_bps_scanned`.
- `results[]` has up to 50 entries (default limit).
- Both `scan_truncated` and `page_truncated` fields present (not a single `truncated`).
- `scan_truncated: false` expected (ProjectA ~469 BPs is under the default 500 max_scan — close to the limit, may be true).
- `offset: 0`, `limit: 50` echoed.
- `include_nodes: false` default → results entries have `match_count` only, no `nodes[]` array.

**PASS/FAIL**:  **Notes** (record `total_bps_scanned` value):

### 1.2 Narrow prefix

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/ProjectA/AI/" })` (or any narrow path with <20 BPs).

Expected: SUCCESS. `total_bps_scanned` in the single/double digits. Fast (<100ms warm cache).

**PASS/FAIL**:  **Notes**:

### 1.3 Invalid prefix

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/NonexistentFolder/" })`.

Expected: SUCCESS (not an error). `total_bps_scanned: 0`, `results: []`, both truncation flags `false`. Graceful empty response, not a crash.

**PASS/FAIL**:  **Notes**:

---

## §2 — Filter combinations

### 2.1 `node_class` filter (most common — "find all callers of class X")

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", node_class: "K2Node_Event" })`.

Expected: SUCCESS. `results[]` entries all have at least one matching event node. `total_bps_matched` should be large (most BPs have events). Warm: <2s.

**PASS/FAIL**:  **Notes**:

### 2.2 `member_name` filter (the flagship workflow — "which BPs handle X?")

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", member_name: "ReceiveBeginPlay" })`.

Expected: SUCCESS. Per the EN-2 worker's report, this returns ~304/469 BPs on ProjectA. Exact count may vary by BP state but should be in the 200-400 range.

**PASS/FAIL**:  **Notes** (record actual count):

### 2.3 `target_class` filter (suffix match)

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", target_class: "UAbilitySystemComponent" })`.

Expected: SUCCESS. Returns BPs that call any method on the ability system component. Count depends on ProjectA's GAS usage — should be non-zero if AbilitySystemComponent is used.

**PASS/FAIL**:  **Notes**:

### 2.4 Combined filters

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", node_class: "K2Node_CallFunction", member_name: "GetActorLocation" })`.

Expected: SUCCESS. Intersection filter — only BPs that have a `CallFunction` node targeting `GetActorLocation`. Narrower than either filter alone.

**PASS/FAIL**:  **Notes**:

---

## §3 — Pagination

### 3.1 First page + verify `page_truncated`

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", member_name: "ReceiveBeginPlay", limit: 10 })`.

Expected: SUCCESS. `results[]` has exactly 10 entries. `page_truncated: true` (because total_bps_matched >> 10). `scan_truncated: false` (scan itself completed). **This is the key deviation-from-spec test** — `page_truncated` signals "advance offset," not "widen max_scan."

**PASS/FAIL**:  **Notes**:

### 3.2 Second page

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", member_name: "ReceiveBeginPlay", limit: 10, offset: 10 })`.

Expected: SUCCESS. `results[]` has 10 different entries from §3.1's response (paths should not overlap).

**PASS/FAIL**:  **Notes**:

### 3.3 Beyond-end offset

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/ProjectA/AI/", offset: 10000 })`.

Expected: SUCCESS. `results: []`, `page_truncated: false`. Not an error.

**PASS/FAIL**:  **Notes**:

---

## §4 — `max_scan` cap + `scan_truncated`

### 4.1 Low max_scan surfaces scan_truncated

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", max_scan: 10 })`.

Expected: SUCCESS. `total_bps_scanned: 10`. `scan_truncated: true` (widen max_scan to see more). `page_truncated` may be true or false depending on how many of those 10 matched.

**PASS/FAIL**:  **Notes**:

### 4.2 Semantic sanity — max_scan counts BPs not files

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", max_scan: 500 })`.

Expected: SUCCESS. `total_bps_scanned` ≈ 500 (or less if corpus is smaller). **Critical regression check**: value should NOT be ~12 or similar low number (which would indicate max_scan reverted to "files walked" semantic, sweeping past non-BP files without counting BPs).

**PASS/FAIL**:  **Notes** (record `total_bps_scanned`):

### 4.3 Max_scan above cap

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", max_scan: 99999 })`.

Expected: SUCCESS. `max_scan` clamps to 5000 (cap per handoff spec). No error.

**PASS/FAIL**:  **Notes**:

---

## §5 — `include_nodes` detail level

### 5.1 Default counts-only response is compact

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/ProjectA/AI/", limit: 5 })`.

Expected: SUCCESS. Each `results[i]` has `path` + `match_count`, NO `nodes[]` array. Response payload should be small (<2KB).

**PASS/FAIL**:  **Notes** (record approx response size):

### 5.2 `include_nodes: true` adds per-node detail

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/ProjectA/AI/", limit: 5, include_nodes: true })`.

Expected: SUCCESS. Each `results[i]` now has a `nodes[]` array with per-node entries (class_name, member_name if applicable, etc.). Response payload notably larger.

**PASS/FAIL**:  **Notes**:

---

## §6 — Workflow validation (golden path)

### 6.1 "Which ProjectA BPs call ApplyGameplayEffectToTarget?"

Call `find_blueprint_nodes_bulk({ path_prefix: "/Game/", member_name: "ApplyGameplayEffectToTarget" })`.

Expected: SUCCESS. Non-zero `total_bps_matched` (ProjectA uses GAS). `results[]` lists specific BP paths.

**PASS/FAIL**:  **Notes** (record count + 2-3 example BP paths):

### 6.2 "Where does this specific variable get accessed?"

Pick a common ProjectA variable name you know exists (e.g., `"Health"` or `"MaxHealth"` or similar — check an ProjectA character BP's variables if unsure). Call:

`find_blueprint_nodes_bulk({ path_prefix: "/Game/", node_class: "K2Node_VariableGet", member_name: "<var_name>" })`

Expected: SUCCESS. Returns BPs that read the variable.

**PASS/FAIL**:  **Notes**:

### 6.3 End-to-end subjective check

With the tool available, try to answer this without writing any code: **"Which three BPs in ProjectA have the most event handlers overall?"** Use the tool creatively (multiple calls if needed). Note how many tool calls it took and whether the tool was sufficient.

**Workflow observations**:

---

## §7 — Performance & cache

### 7.1 Cold cache (first call after restart)

Record the wall time of a fresh call (may be noisy — restart the MCP server first OR pick a `path_prefix` you haven't touched yet this session).

Call: `find_blueprint_nodes_bulk({ path_prefix: "/Game/" })`.

Expected per EN-2 benchmark: ~12.9s cold on ProjectA's 469-BP corpus. Not hard-gated; record actual.

**Cold time**:  **PASS/FAIL** (fail only if >30s):

### 7.2 Warm cache (repeat call)

Repeat the §7.1 call immediately.

Expected: ~1.1s warm (EN-2 benchmark). Should be noticeably faster than cold.

**Warm time**:  **PASS/FAIL** (fail only if >5s or not meaningfully faster than cold):

---

## §8 — F-1.5 belt-and-braces (array-param wire preprocess)

Optional but cheap while the session is fresh. Structural MCP-wire coverage exists; this confirms end-to-end through Claude Code's actual JSON-RPC client.

### 8.1 Array param as native array

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`.

Expected: SUCCESS. Response filters to the single named property. Common case: native-array passes through Zod untouched.

**PASS/FAIL**:  **Notes**:

### 8.2 Array-typed param — multi-element

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags", "CooldownGameplayEffectClass"] })`.

Expected: SUCCESS. Response includes both properties if they exist on the CDO.

**PASS/FAIL**:  **Notes**:

### 8.3 Empty array

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: [] })`.

Expected: SUCCESS. Either returns all properties (empty filter = no filter) OR returns no properties (empty filter = match nothing). Either is acceptable — **just document which you observe**; this tells us the handler's empty-array semantic.

**PASS/FAIL**:  **Notes** (which semantic?):

---

## Results summary

- **Total PASS**:  / 20 (1.1-7.2 main) + 3 (§8)
- **Regressions detected**:
- **Deviations-from-spec validation**:
  - `scan_truncated` + `page_truncated` split working as advertised? **YES / NO**
  - `max_scan` counts BPs (not files)? **YES / NO**
- **Performance envelope OK?**: **YES / NO**
- **Unexpected behaviors**:

---

## Save + commit

When complete, save filled results as `docs/testing/2026-04-20-en2-results.md` and commit path-limited per D49:

```cmd
git commit docs/testing/2026-04-20-en2-results.md -m "EN-2 manual testing results"
```

Desktop Commander for git ops (shell: "cmd") if sandbox bash can't acquire `.git/index.lock`. Native Git Bash is fine if that's your environment.

No AI attribution in commit or results body.

---

## Report back to orchestrator

Report: (a) results commit SHA, (b) PASS/FAIL count, (c) any regression or design-deviation surprises, (d) whether the two EN-2 design deviations (truncation split + max_scan semantic) held up under real-session use.
