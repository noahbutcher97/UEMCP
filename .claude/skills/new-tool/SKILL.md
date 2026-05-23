---
name: new-tool
description: Use when adding a new tool to an existing UEMCP toolset (offline, TCP:55558, or HTTP:30010) — scaffolds the tools.yaml entry, the handler/executor case, and the test, then verifies the rotation assertion count grew. Triggers on "add a tool", "new UEMCP tool", "add a tool to the <X> toolset", "scaffold a tool".
---

# Adding a UEMCP tool

UEMCP's registry is driven by `tools.yaml` (the single source of truth, D44).
Adding a tool to an **existing** toolset is a YAML edit + a handler case + a test —
you do **not** touch the `registerToolGroup(...)` calls in `server.mjs`, because that
helper auto-registers every tool in a toolset's defs (W-A consolidation). You only
edit `server.mjs` when adding a *new toolset*.

## Step 0 — Decide the layer and toolset

| Layer | When | Handler file | Executor | Schema path |
|-------|------|--------------|----------|-------------|
| `offline` | disk reads, no editor | `server/offline-tools.mjs` | `executeOfflineTool` switch | yaml `params:` → `buildOfflineSchemaShape` |
| `tcp-55558` | live editor (UEMCP plugin) | the toolset's `*-tcp-tools.mjs` | that toolset's `execute<Toolset>Tool` switch | pre-built `def.schema` → `buildTcpSchemaShape` |
| `http-30010` | Remote Control primitives/delegates | `server/rc-*-tools.mjs` | `executeRcTool` switch | `buildTcpSchemaShape` |

Confirm the target toolset exists: `grep -nE "^  [a-z-]+:" tools.yaml` (toolset keys).
Check active tool count won't blow the ~40 accuracy ceiling (`list_toolsets` warns >40).

## Step 1 — Add the tools.yaml entry

Under the toolset's `tools:` block. Match the surrounding entries' shape:

```yaml
    your_tool_name:
      description: One sentence, agent-facing. Say what it returns + when to use it.
      params:
        some_arg:  { type: string, required: true }
        max_items: { type: integer, required: false, default: 25 }
      # aliases: optional, add under top-level aliases: if the tool has synonyms
```

snake_case names + params. For TCP/HTTP tools that map to a differently-named plugin
handler, add `wire_type: <plugin_command_name>` (see `m-enhance` examples).

## Step 2 — Implement the handler + add the executor case

- **Offline**: implement the function in `offline-tools.mjs`, add a `case 'your_tool_name':`
  to the `executeOfflineTool` switch. Keep functions under 50 lines; early-return on
  validation; comment intent, not implementation.
- **TCP/HTTP**: implement in the toolset's handler module, add a case to its
  `execute<Toolset>Tool` switch. Dispatch via `connectionManager.send(layer, type, params, { timeoutMs })`.
  If the op routinely runs >5s on the GameThread, add a per-toolset `*_TIMEOUT_OVERRIDES`
  entry (see `m5-editor-utility-tools.mjs` / `widgets-tcp-tools.mjs`) — the default-timeout
  silent-success-on-disk trap is documented in CLAUDE.md (D118/D121/D125).

No `server.tool()` call and no `handle.disable()` — `registerToolGroup` does both.

## Step 3 — Add a test

Add assertions to the toolset's existing test file (see the Testing table in CLAUDE.md):
offline → `test-phase1.mjs` / parser tests; TCP → `test-tcp-tools.mjs` or the toolset's file;
RC → `test-rc-wire.mjs`. Use the mock seam: `config.tcpCommandFn` with `FakeTcpResponder`
for happy path and `ErrorTcpResponder` for failure modes (timeout, ECONNREFUSED, success:false).

## Step 4 — Verify (do not skip — D104 silent-zero)

```bash
cd server && node run-rotation.mjs --json
```

Confirm the aggregate **assertion count grew by the number you added**. A flat count
after adding tests means a file failed on import and silently dropped its assertions
(the D97→D102 regression that lost 234 assertions for 5 days). The runner is FAIL-LOUD
on import errors; still eyeball the delta. Also confirm `tools/list` and `find_tools`
report your tool identically (D44 invariant — `test-mcp-wire.mjs` guards it).

## Definition of done
- [ ] `tools.yaml` entry added under the right toolset
- [ ] handler implemented + executor `switch` case added (NOT server.mjs)
- [ ] test added with mock-seam happy + error path
- [ ] `run-rotation.mjs` assertion count grew by the expected delta
- [ ] codename check: no project codenames in any committed file (the PreToolUse hook + pre-commit gate this, but verify)
