# Editor readiness wait — design

**Date**: 2026-08-25
**Status**: Implemented and live-verified
**Predecessor**: `2026-08-25-transport-reliability-decision-record.md` §8

## Problem

After launching the editor there is no way to ask "is the transport live yet?" except to call a real tool and interpret the failure. The window is long and highly variable — **128 s measured** from launch to `TCP server listening` on a first cold launch of a large sample project, and **~22 s** for the same project once shader and derived-data caches were warm. That spread is itself why a fixed per-call retry budget cannot solve this. During it, every call returns `connect ECONNREFUSED`.

The documented remedy is "retry on the next user prompt": a human polling by hand. Worse, a bare `ECONNREFUSED` is indistinguishable from a genuinely broken deployment, so it invites diagnosis of a non-problem — a trap D131 already warns about.

The transport-reliability record established that **retry is the wrong shape** for this: no per-call retry budget can span 128 s, and widening the budget so it could would block every caller for over two minutes on a cold editor. What is actually needed is an explicit, opt-in wait that a caller chooses to enter.

## Non-goals

- **No implicit waiting anywhere.** No existing tool gains a hidden wait. A silent multi-minute block is a worse failure than a fast, clear error, which is the reasoning that closed L1.
- **Not a retry mechanism.** This does not re-issue failed operations; it establishes readiness before the caller issues one.
- **Not a health monitor.** One-shot, caller-initiated. No background polling.

## Shape

A management tool, `wait_for_editor`, registered alongside `connection_info` via `registerManagementTool`. Management scope is required rather than stylistic: it must be callable *before* any toolset is usable, and toolsets are what it makes usable.

### Input

| Param | Type | Default | Notes |
|---|---|---|---|
| `timeout_ms` | number | `30000` | Per-call ceiling. Clamped to `[1000, 55000]`. |

The ceiling stays under typical MCP client timeouts by design. See *Wait contract*.

### Output

```jsonc
{
  "ready": false,
  "phase": "initializing",
  "elapsed_ms": 30012,
  "attempts": 14,
  "editor": null,               // populated on ready
  "last_error": { "code": "SOCKET_ERROR", "nativeCode": "ECONNREFUSED" },
  "hint": "Editor is initializing. Call wait_for_editor again to continue waiting."
}
```

`editor` carries `{ project_name, world_path }` from `get_editor_state` once ready.

## Wait contract — bounded block, resumable

A single call blocks up to `timeout_ms`, then returns what it learned.

**Not-ready is a successful result, not an error.** `ready: false` with `ok: true`. This is the load-bearing decision: if in-progress surfaced as a tool error, an agent would treat a normal intermediate state as a transport failure and start diagnosing — exactly the behaviour D131 tells people to avoid.

Resuming is just calling again. The 128 s case costs roughly four calls at the default ceiling.

**Why not one long block.** A tool call is subject to the *client's* timeout, which UEMCP does not control and cannot inspect. A two-minute block risks being killed mid-wait and surfacing as a transport failure — converting a fix into a new instance of the problem it fixes. A bounded ceiling is the only version that cannot fail that way.

## Phase classification

The diagnostic value is here. A naive implementation waits the full budget to tell a caller they never launched the editor.

| Phase | Detected by | Returns immediately? | Meaning |
|---|---|---|---|
| `no_editor_process` | `listEditorProcesses()` empty | **Yes** | Nothing to wait for. |
| `wrong_project` | Running editor's `canonicalEditorProjectPath` ≠ attached project | **Yes** | Waiting can never succeed; workspace drift (D136 `[MCP]` class). |
| `initializing` | Our process present, TCP probe refused | No | The real case. |
| `transport_ready` | `ping` answers, `get_editor_state` does not | No | Listener answers ping, but the handler does not. |
| `ready` | `get_editor_state` round-trips | — | Terminal success. |

Two phases short-circuit. Both are cases where waiting is *provably* futile, and both are common mistakes worth naming precisely rather than timing out on.

`wrong_project` requires an attached project; with none attached, treat a running editor as `initializing` rather than guessing.

### Readiness signal

`get_editor_state`, not `ping`. D131 designates it canonical: it confirms a real handler round-trip, not merely that a socket accepted a connection.

**Correction from live observation.** An earlier draft justified this as "avoids declaring ready while the map is still loading". That is wrong: a cold editor answered `get_editor_state` with `world_path: null` before loading any map. Requiring a world would mean never reporting ready for asset-only work with no map open, which is a legitimate state. Readiness therefore means *the editor answers*, and a null world is reported rather than concealed. `transport_ready` covers the narrower real case — `ping` answers but `get_editor_state` does not.

Cost is one extra round-trip against an editor that has already answered — negligible beside the wait it replaces.

## Constraints

**Never enqueue.** `ConnectionManager._queue.enqueue` chains promises per layer (`prev.then(fn, fn)`), so a wait running inside it would block every subsequent call on that layer for its whole budget. `_probeLayer` already calls `tcpFn` directly; the wait follows that precedent. **A wait that serialized behind the queue would freeze the layer it is trying to make usable** — the single most important implementation note here.

**Backoff, no knob.** ~500 ms growing to ~2 s, capped. Not caller-configurable: it is a policy, not a preference, and exposing it invites hammering a starting editor.

**Health cache is warmed, not bypassed.** Probing updates `layer.status`/`lastCheck`, so a later `isLayerAvailable` benefits from the 30 s TTL rather than re-probing.

**Clamping is silent and reported.** An out-of-range `timeout_ms` is clamped and the effective value echoed, rather than erroring.

## Testing

All phase classification is pure and testable project-less:

- **Process detection** injected (the module already exports `listEditorProcesses` with a `spawnSyncImpl` seam).
- **Transport** injected via the existing `config.tcpCommandFn` mock seam; `ErrorTcpResponder` already produces `ECONNREFUSED`.

Cases: each of the five phases; short-circuit phases return without consuming the budget; `ready: false` carries `ok: true`; `timeout_ms` clamping at both bounds; attempts increment; a transition from refused → `ping`-only → full readiness across successive probes; and no call reaches `enqueue`.

The live path stays opt-in under the existing live-smoke harness.

## Open questions

1. **Cumulative elapsed across calls.** Should the manager track total wait for this editor generation, so the fourth call can report ~120 s rather than four separate ~30 s? Useful for reporting the real cost; costs a small piece of session state. Recommend deferring until the tool has been used.
2. **Remote-control layer.** `layer` is accepted but only the TCP layer is implemented. The RC server has its own readiness curve; unify only if the need appears.
3. **`connection_info` overlap.** It already reports editor/transport readiness as a snapshot. This tool is the *waiting* form. If they drift, `connection_info` should delegate its readiness dimensions to the shared classifier rather than keeping a parallel implementation.
