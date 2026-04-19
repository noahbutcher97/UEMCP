# Manual Testing Handoff — F-1 Zod-Coerce End-to-End Verification

> **Dispatch**: Immediately (needs fresh Claude Code session with restarted MCP server to load post-`149c8e4` code).
> **Type**: Focused manual test — narrow scope, just F-1.
> **Duration**: 15-20 minutes.
> **Output**: Fill pass/fail + notes inline; save as `docs/testing/2026-04-19-f1-zod-coerce-results.md`.

---

## Mission

The Pre-Phase-3 Fixes Worker landed F-1 (`z.coerce.boolean()` / `z.coerce.number()` in `buildZodSchema`, commit `149c8e4`). Their unit tests pass (8 new in `test-phase1.mjs` covering coerce paths). Their empirical pre-fix reproduction confirmed the symptom exists on the old server.

**What remains unverified**: that the fix actually works through the live MCP wire in a fresh Claude Code session — the session the worker ran in was connected to a pre-commit server and can't validate post-commit behavior.

Your job: restart Claude Code + UEMCP MCP server, then confirm every previously-blocked typed-param call now succeeds.

---

## Pre-flight

- [ ] Close the current Claude Code session fully (if any is connected to UEMCP).
- [ ] Restart the UEMCP MCP server (whatever mechanism launches it from `.mcp.json` — usually closing + reopening the IDE window triggers this).
- [ ] Verify the new server has `149c8e4` loaded — check commit SHA via a quick `git log --oneline -10` in a shell if in doubt.
- [ ] UNREAL_PROJECT_ROOT = `D:/UnrealProjects/5.6/ProjectA/ProjectA`.
- [ ] Confirm server is responsive: call `project_info({})`. Should return project metadata without errors.

---

## §1 — Boolean coerce

### 1.1 `summarize_by_class: true` (was the flagship failing case)

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", summarize_by_class: true })`.

Expected: SUCCESS. Response has `summary: { className: count }`. Pre-fix symptom (`"Expected boolean, received string"`) should NOT reproduce.

**PASS/FAIL**:  **Notes** (include response snippet if useful):

### 1.2 `include_defaults: true`

Call `inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block", include_defaults: true })`.

Expected: SUCCESS. Response includes `variable_defaults`. No Zod rejection.

**PASS/FAIL**:  **Notes**:

### 1.3 `verbose: true` on get_asset_info

Call `get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_Block", verbose: true })`.

Expected: SUCCESS. Response includes full AR tags (verbose blob not stripped). Same shape as `verbose: false` but with richer tag payload.

**PASS/FAIL**:  **Notes**:

### 1.4 Explicit `false` (ensure defaults work)

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", summarize_by_class: false })`.

Expected: SUCCESS, falls through to per-row actors[] response (not summary). Confirms the coerce accepts explicit `false` without misreading as truthy.

**PASS/FAIL**:  **Notes**:

---

## §2 — Number coerce

### 2.1 `limit: 5`

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", limit: 5 })`.

Expected: SUCCESS. `actors[]` has ≤5 entries.

**PASS/FAIL**:  **Notes**:

### 2.2 `offset: 10`

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", limit: 5, offset: 10 })`.

Expected: SUCCESS. `actors[]` returns entries starting from index 10.

**PASS/FAIL**:  **Notes**:

### 2.3 `max_bytes` on read_asset_properties

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", max_bytes: 2048 })`.

Expected: SUCCESS. If the CDO exceeds 2048 bytes, response has `truncated: true` with `size_budget_exceeded` markers.

**PASS/FAIL**:  **Notes**:

### 2.4 `max_scan` on query_asset_registry

Call `query_asset_registry({ class_name: "Blueprint", max_scan: 100 })`.

Expected: SUCCESS. `total_scanned: 100`, `truncated: true`.

**PASS/FAIL**:  **Notes**:

---

## §3 — Cross-tool smoke

One-call-per-tool with typed params to confirm coerce is universal across tools:

- [ ] `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", limit: 5 })` — number
- [ ] `query_asset_registry({ class_name: "DataTable", limit: 3 })` — number
- [ ] `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", summarize_by_class: true })` — boolean (may duplicate 1.1; helps confirm)

**PASS/FAIL** for each:

---

## §4 — Regression: non-coerced params still work

### 4.1 String params (unaffected by coerce)

Call `search_gameplay_tags({ pattern: "Gameplay.*" })`.

Expected: SUCCESS. String params route through the non-coerce path; confirms F-1 didn't break anything.

**PASS/FAIL**:  **Notes**:

### 4.2 Array params (unaffected)

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`.

Expected: SUCCESS. Array-of-strings still validates.

**PASS/FAIL**:  **Notes**:

---

## §5 — Error paths still reject genuinely-invalid values

The coerce should accept string-of-number / string-of-bool but still reject actually-invalid input.

### 5.1 Non-numeric string as a number

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", limit: "hello" })`.

Expected: REJECTED with Zod validation error (something like `Expected number, received nan` — `"hello"` coerces to `NaN`). NOT a silent bypass.

**PASS/FAIL** (should reject — PASS if rejected, FAIL if silently accepted):  **Notes**:

### 5.2 Non-boolean string as a boolean

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", summarize_by_class: "maybe" })`.

Expected: Depends on z.coerce.boolean behavior in Zod 3 — typically any non-empty string coerces to `true`. Document what happens.

**PASS/FAIL** (what did the response say?):  **Notes**:

---

## §6 — Summary

| Section | Result |
|---|---|
| §1 Boolean coerce | X/4 pass |
| §2 Number coerce | X/4 pass |
| §3 Cross-tool smoke | X/3 pass |
| §4 Regression | X/2 pass |
| §5 Error paths | X/2 handled correctly |

**Overall verdict**: [F-1 ships end-to-end / blocker found / partial]

**Key confirmation**: the manual tester's original blocker (`summarize_by_class: true` → `Expected boolean, received string`) is resolved in a fresh session: [yes/no]

**Anything unexpected**:

**Time spent**: _ min

---

## Rules

- Read-only testing. No code/yaml edits. Flag anything weird in notes; don't fix inline.
- Single commit at end via path-limited `git commit <path> -m` per D49.
- Desktop Commander for git (shell: "cmd").
- No AI attribution.
- If MCP server isn't loading the new code, stop + report (restart may not be propagating).
