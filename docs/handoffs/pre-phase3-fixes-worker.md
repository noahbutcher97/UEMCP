# Pre-Phase-3 Fixes Worker

> **Dispatch**: Immediately. Parallel-safe with Sidecar Design Session (different file scope).
> **Type**: Surgical fixes. 8 items across yaml + server.mjs + TOOLSET_TIPS + backlog.md + docs.
> **Duration**: 60-90 min.
> **Source**: Audit A (5 MEDIUMs), Audit B (Q5 TOOLSET_TIPS), Manual tester (MCP Zod-coerce + doc nit).

---

## Mission

Consolidated cleanup bundle from 3 upstream sources to unblock Phase 3 scope refresh. No new features; all items are drift/gap/fix.

### The 8 items (roughly by priority)

**HIGH — blocks agent-facing usability under D52**

### F-1 — MCP Zod-coerce for booleans/numbers (buildZodSchema)

**Problem**: Claude Code's MCP wrapper passes booleans and numbers as strings on the wire. Every `summarize_by_class: true`, `limit: 5`, `include_defaults: true` call rejects with Zod `invalid_type`. Tool code is correct; unit tests pass; agent-facing usability is broken for typed params.

**Fix**: in `server/server.mjs` `buildZodSchema` (~lines 432-442), replace:
- `z.boolean()` → `z.coerce.boolean()`
- `z.number()` / `z.number().int()` → `z.coerce.number()` / `z.coerce.number().int()`

Test: after fix, a call like `list_level_actors({ summarize_by_class: "true" })` should succeed, coercing the string to boolean. Add an assertion in `test-phase1.mjs` that exercises the coerce path.

**Critical verification**: this affects EVERY offline tool with non-string params. Run the full test suite after; visually confirm via a fresh Claude Code session that `list_level_actors`, `inspect_blueprint`, `read_asset_properties` accept typed params through the MCP wire.

---

**MEDIUM — Audit A findings**

### F-2 — `search_gameplay_tags.params.pattern` missing from yaml

`server/offline-tools.mjs:searchGameplayTags` reads `params.pattern` but the yaml declaration has no `params` block. Breaks D44 invariant (tools/list ↔ find_tools must agree — one source has pattern, yaml has none).

Fix: add to `tools.yaml` → `offline.tools.search_gameplay_tags`:
```yaml
params:
  pattern: { type: string, required: true, description: "Glob pattern (*, **). Matches tag hierarchy." }
```

### F-3 — `list_config_values` 3 params missing from yaml

Handler reads `params.config_file`, `params.section`, `params.key`. Yaml has no params block. Silently changes behavior on `{}` call. Add all 3 to yaml with correct types + optional markers.

### F-4 — `find_blueprint_nodes` count drift (13 → 19 shipped)

Yaml description claims "13 skeletal K2Node types" but shipped implementation covers 19 (13 skeletal + 6 variants per Agent 10.5 shipment). Update:
1. Yaml description in `tools.yaml`
2. Any D-log references (D48 amendment if needed — flag but do NOT edit D-log; orchestrator will)
3. Tool's inline description if present

### F-5 — FBodyInstance + 10+ marker reason codes missing from yaml reason-code catalog

The `read_asset_properties` yaml description added a reason-code catalog in P5 (Polish Worker). Additional reason codes emitted by subsequent shipments aren't in the catalog. Audit A lists them — add to yaml.

### F-6 — `backlog.md` tail stale

The backlog has 5 completed handoffs listed in its "Currently-known-issues not in this file" section that should have migrated OUT per the file's own maintenance rule. Remove:
- Polish worker (shipped `8812c1c`)
- Parser Extensions (shipped `bdd1527`, `f3ae608`)
- Cleanup worker (shipped `905c48e`, `de8d146`)
- Manual testing handoff for Agent 10 (completed `e77c48a`)
- Docs housekeeping (completed `bc212d7`, `9cf36f5`, `6638e9d`)

Keep the "Currently-known-issues not in this file" section but update it with current post-wave-4 state (any in-flight dispatches).

---

**LOW — miscellaneous**

### F-7 — TOOLSET_TIPS stale `search_source` reference

`server/server.mjs:99,122` reference `search_source` which is no longer in tools.yaml (dropped per D31). Remove or replace references.

### F-8 — Doc nit: snake_case vs camelCase in manual-testing handoff

`docs/handoffs/manual-testing-post-wave4-2026-04-19.md` §2.2 uses `output_index`, `mask_r` etc. Shipped code emits `outputIndex`, `maskR` (camelCase). Update the handoff to match. Historical artifact but worth fixing.

---

## File scope

| File | Action |
|---|---|
| `server/server.mjs` | F-1 (buildZodSchema), F-7 (TOOLSET_TIPS refs) |
| `server/offline-tools.mjs` | None expected — fixes are yaml + server.mjs |
| `tools.yaml` | F-2, F-3, F-4 (description), F-5 |
| `docs/tracking/backlog.md` | F-6 |
| `docs/handoffs/manual-testing-post-wave4-2026-04-19.md` | F-8 |
| `server/test-phase1.mjs` | F-1 test assertion |

**Do NOT touch**: `uasset-parser.mjs`, `uasset-structs.mjs`, `tcp-tools.mjs`, `connection-manager.mjs`, `plugin/`, `docs/tracking/risks-and-decisions.md` (orchestrator writes D-log).

---

## Constraints

- Path-limited commits per D49.
- Desktop Commander for git (shell: "cmd").
- Tests must stay green (709 baseline + some new from F-1 coerce test).
- No AI attribution.
- F-1 is HIGH priority — verify end-to-end via MCP wire after landing (not just unit tests).
- Time budget: 60-90 min. If any item exceeds 2x its expected scope, flag and move on.

---

## Final report

```
Pre-Phase-3 Fixes Worker Final Report

F-1 (MCP Zod-coerce):                  [done/partial]  commit [SHA]
  Verified via MCP wire: [yes/no, how]
F-2 (search_gameplay_tags yaml):       [done/partial]  commit [SHA]
F-3 (list_config_values yaml):         [done/partial]  commit [SHA]
F-4 (find_blueprint_nodes count drift): [done/partial]  commit [SHA]
F-5 (reason-code catalog gaps):        [done/partial]  commit [SHA]
F-6 (backlog.md tail):                 [done/partial]  commit [SHA]
F-7 (TOOLSET_TIPS search_source):      [done/partial]  commit [SHA]
F-8 (manual-testing doc nit):          [done/partial]  commit [SHA]

Tests: [X]/[Y] — delta vs 709 baseline
Commits landed: [N]
Time spent: [N min]
Items deferred (if any): [list]
```
