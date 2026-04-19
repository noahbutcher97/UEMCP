# F-1.5 Worker — Array/Object Preprocess for Wire Stringification

> **Dispatch**: Immediately. Blocks EN-2 Worker (wave C) — EN-2 would otherwise inherit the same array-stringification pathology on any future array params.
> **Type**: Surgical fix. Mirrors F-1's approach (Pre-Phase-3 Fixes worker) but for array/object param types instead of boolean/number.
> **Duration**: 20-30 min.

---

## Mission

F-1 (z.coerce.boolean + z.coerce.number in `buildZodSchema`) closed the wire-stringification gap for primitive types. The F-1 Verifier (2026-04-19) discovered the same pathology affects **arrays and objects**:

- `read_asset_properties({ property_names: ["AbilityTags"] })` → MCP wrapper stringifies the array → server sees `"[\"AbilityTags\"]"` → Zod rejects with `Expected array, received string`
- Same symptom exists for any `type: object` param (not currently widely used, but structurally present)

F-1.5 mirrors F-1's approach — add defensive preprocessing to `buildZodSchema` so stringified JSON inputs are parsed before Zod validation.

---

## Fix

In `server/zod-builder.mjs` (extracted by Pre-Phase-3 Fixes Worker, commit `149c8e4`), extend `buildZodSchema` for `array` and `object` types:

**Current pattern**: `z.array(...)` / `z.record(z.any())` validate directly.

**Post-F-1.5 pattern**: wrap with `z.preprocess` that JSON-parses string input:

```js
case 'array':
  field = z.preprocess(
    (val) => typeof val === 'string' ? safeJsonParse(val, val) : val,
    z.array(def.items === 'string' ? z.string() : z.any())
  );
  break;
case 'object':
  field = z.preprocess(
    (val) => typeof val === 'string' ? safeJsonParse(val, val) : val,
    z.record(z.any())
  );
  break;
```

Where `safeJsonParse(str, fallback)` attempts JSON.parse and returns `fallback` (the original string) on failure, so Zod gets a chance to produce a clean "expected array/object, got string" error rather than a cryptic SyntaxError bubbling up.

**Semantics**: typed arrays/objects pass through unchanged (Zod validates normally). Stringified arrays/objects get parsed then validated. Genuinely-malformed strings fall through as strings and fail Zod with a clear message.

---

## Test coverage

Add assertions in `server/test-phase1.mjs` paralleling F-1's Test 12 coerce block:

1. Typed array → passes (e.g., `property_names: ["AbilityTags"]` — Zod validates directly)
2. Stringified array → coerces + passes (e.g., `property_names: "[\"AbilityTags\"]"` — preprocess parses)
3. Stringified non-array JSON as array → rejects (e.g., `property_names: "{\"foo\": 1}"` — parse succeeds but isn't an array)
4. Malformed JSON string as array → rejects with clear error (e.g., `property_names: "not json"`)
5. Empty-array stringified → passes (e.g., `property_names: "[]"`)

Also extend `server/test-mcp-wire.mjs` (the harness from MCP-Wire Worker) with end-to-end assertions: send stringified JSON array through the MCP wire, confirm handler receives parsed array. Mirror the pattern the harness uses for boolean/number coerce.

---

## File scope

| File | Action |
|---|---|
| `server/zod-builder.mjs` | Extend case 'array' + case 'object' with z.preprocess |
| `server/test-phase1.mjs` | +5 assertions (array coerce paths) |
| `server/test-mcp-wire.mjs` | +3-5 assertions (end-to-end array wire coerce via MCP-Wire harness) |

**Do NOT touch**: `uasset-parser.mjs`, `uasset-structs.mjs`, `offline-tools.mjs`, `tcp-tools.mjs`, `tools.yaml`, `docs/tracking/`.

---

## Verification

After shipping:
- Unit tests: 767 + ~8-10 new assertions = ~775-777 baseline.
- End-to-end (requires fresh Claude Code session + MCP server restart — Noah's verification step, mirror of F-1): call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`. Should SUCCEED. Pre-fix behavior was `Expected array, received string`.

---

## Constraints

- Path-limited commits per D49. Desktop Commander for git (shell: "cmd").
- Tests must stay green (767 baseline; you add ~8-10).
- No AI attribution.
- Match F-1's structural approach — defensive preprocess, not a fundamental Zod schema change.
- Don't add coverage beyond arrays/objects (e.g., don't try to handle "stringified struct types" — those aren't real tool params today).

---

## Final report

```
F-1.5 Worker Final Report — Array/Object Preprocess

Fix landed: [yes/partial]
  zod-builder.mjs extended: [yes]
  array type: [done]
  object type: [done]
  safeJsonParse helper: [inline / new helper / reused]

Tests: [X]/[Y] — delta vs 767 baseline
  New in test-phase1.mjs: [N]
  New in test-mcp-wire.mjs: [N]

End-to-end verification: requires Noah's fresh-Claude-Code-session check (same pattern as F-1). Flag in final report.

Commit: [SHA]
Time spent: [N min]
```
