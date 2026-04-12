# Phase 1 Audit — 2026-04-12

**Scope**: All Phase 1 implementation files (server.mjs, offline-tools.mjs, tool-index.mjs, toolset-manager.mjs, connection-manager.mjs) audited against spec docs (dynamic-toolsets.md, architecture.md, risks-and-decisions.md, implementation.md).

**Method**: Two-pass audit. Pass 1: regression/architecture fidelity check. Pass 2: three parallel agents (ToolIndex scoring, bugs, plan gaps) + manual verification of all findings.

---

## Findings Summary

| Severity | Found | Fixed | Deferred |
|----------|-------|-------|----------|
| CRITICAL | 3     | 2     | 0        |
| HIGH     | 5     | 5     | 0        |
| MEDIUM   | 5     | 4     | 1        |
| LOW      | 4     | 0     | 4        |

---

## CRITICAL

### C1. tools/list visibility gap — FIXED
`server.tool()` (v1 API) registered all tools permanently in `tools/list`. Disabled toolsets' tools were still visible to Claude, defeating the entire dynamic toolset concept. The runtime guard returned errors *after* Claude already saw and attempted to call the tool.

**Fix**: Discovered that SDK 1.29.0's `server.tool()` returns a handle with `.enable()/.disable()` methods that control `tools/list` visibility (line 68-69 of SDK's mcp.js filters by `enabled` flag). Captured handles, stored in ToolsetManager, wired enable/disable into toolset state changes. Removed runtime guard.

**Files changed**: `server/server.mjs`, `server/toolset-manager.mjs`

### C2. Path traversal in readSourceFile — FIXED
Path comparison used string `.replace(/\\/g, '/')` without `path.resolve()` to collapse `..` segments. A crafted path like `Source/../../etc/passwd` could bypass the `.startsWith()` check.

**Fix**: Used `path.resolve()` (Node stdlib) on both project root and resolved file path before comparison. Resolves `.`, `..`, and produces canonical absolute paths.

**Files changed**: `server/offline-tools.mjs`

### C3. Regex `g` flag in searchSource — FALSE POSITIVE
Flagged as bug: `new RegExp(pattern, 'gi')` with `.test()` in a loop advances `.lastIndex`, skipping matches. However, line 328 already resets `regex.lastIndex = 0` after each test. Fix was already in place.

**Status**: No action needed.

---

## HIGH

### H1. ToolIndex scoring weights diverge from spec — FIXED
Implementation had 4 tiers with wrong weights. Spec (dynamic-toolsets.md) defines 6 tiers.

| Tier | Spec | Was | Now |
|------|------|-----|-----|
| Exact full name | +100 | missing | +100 |
| Token in name | +10 | +10 | +10 |
| Prefix of name token | +6 | +6 | +6 |
| Substring of name token | +4 | missing | +4 |
| Token in description | +2 | +3 | +2 |
| Prefix of desc token | +1 | +1.5 | +1 |

**Files changed**: `server/tool-index.mjs`

### H2. Coverage bonus missing — FIXED
Spec: "Final score multiplied by `(0.5 + 0.5 × matched_token_ratio)`." Was not implemented. Multi-word queries didn't reward tools matching ALL terms.

**Fix**: Track which query tokens contributed matches per entry, apply multiplier.

**Files changed**: `server/tool-index.mjs`

### H3. Auto-enable cap at 3 toolsets missing — FIXED
Spec: "find_tools caps auto-enable at top 3 matching toolsets per query." Implementation enabled ALL matching toolsets with no cap.

**Fix**: Rank toolsets by their best tool's score, take top 3.

**Files changed**: `server/server.mjs`

### H4. 40-tool warning missing — FIXED
Spec: "list_toolsets warns when active tool count exceeds 40." Not implemented.

**Fix**: Count active tools (6 management + enabled toolset tools), add warning to response when > 40.

**Files changed**: `server/server.mjs`

### H5. Alias map divergence — FIXED
tools.yaml defines 18 canonical aliases. tool-index.mjs had 42 hardcoded entries. 7 YAML aliases missing from implementation (`abp`, `wbp`, `eub`, `mw`, `mid`, `sm`, `sk`, `imc`).

**Fix**: `build()` now merges canonical aliases from `toolsData.aliases` into the default map at index build time. YAML entries overwrite defaults on conflict; extra defaults are preserved as useful supplements.

**Files changed**: `server/tool-index.mjs`

---

## MEDIUM

### M1. Missing error handling in listGameplayTags — FIXED
No try-catch around ini file read. Missing `DefaultGameplayTags.ini` produced unhelpful ENOENT error.

**Fix**: Wrapped in try-catch with descriptive message naming the expected file path.

**Files changed**: `server/offline-tools.mjs`

### M2. autoEnable() discards enable result — FIXED
`toolsetManager.autoEnable()` called `this.enable()` but didn't return the result. The `find_tools` handler worked around this by tracking `previouslyEnabled` manually.

**Fix**: `autoEnable()` now returns the enable result.

**Files changed**: `server/toolset-manager.mjs`

### M3. Unavailable toolset reasons lack fix instructions — FIXED
`_unavailableReason()` said "not loaded" but didn't tell Claude how to resolve it.

**Fix**: Each reason now includes actionable instructions (e.g., "Fix: set UNREAL_PROJECT_ROOT in .mcp.json env block").

**Files changed**: `server/toolset-manager.mjs`

### M4. searchGameplayTags redundant hierarchy build — DEFERRED
`searchGameplayTags` calls `listGameplayTags()` which builds the full hierarchy just to get the flat tag list. Performance optimization only — not a correctness issue.

### M5. .mcp.json template not created — FIXED
Spec mentions shipping a config template. Created `.mcp.json.example` in repo root.

**Files created**: `.mcp.json.example`

---

## LOW (Deferred)

### L1. TCP reconnection retry — DEFER to Phase 2
No retry logic when editor closes/reopens. Per risks-and-decisions.md: "IMPLEMENT Phase 2."

### L2. Fallback chain — DEFER to Phase 4
No graceful degradation across layers. Per spec: Phase 4 scope.

### L3. Write-op deduplication — DEFER to Phase 2
Request ID dedup for TCP write commands. ResultCache exists for reads only.

### L4. MCP Resources — DEFER
Per D21: "Deferred to Phase 1 end as optional polish."

---

## Additional Decisions Made During Audit

### D23. UEMCP absorbs all tools onto TCP:55558
Recorded in `tracking/risks-and-decisions.md`. Phase 2 uses existing UnrealMCP as conformance oracle. Phase 3 reimplements all 26 tools in custom plugin. Post-Phase 3: drop UnrealMCP dependency entirely. Layer assignments for `actors`, `blueprints-write`, `widgets` in tools.yaml are transitional.

---

## Methodology Notes

- Agent 3 (plan gaps) incorrectly claimed offline tools were "incomplete stubs." Verified: all 10 tools are fully implemented at 507 lines. This was a false positive from the agent not reading the full file.
- Agent 1 (ToolIndex) findings were all verified accurate.
- Agent 2 (bugs) C3 finding was a false positive — the `lastIndex` reset was already present.
