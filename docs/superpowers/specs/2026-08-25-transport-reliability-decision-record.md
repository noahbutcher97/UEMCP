# Transport reliability (L1 / L2 / L3) — decision record

**Date**: 2026-08-25
**Status**: Decided — all three closed or deferred; one replacement feature proposed
**Scope**: `L1` TCP reconnection retry, `L2` graceful fallback across layers, `L3` write-op deduplication

## Verdict

None of the three should be built as filed.

| Item | Disposition | Basis |
|---|---|---|
| L1 — reconnection retry | **Closed** | Retry cannot span the window it was meant to bridge (measured 128 s vs a 10 s budget). Residual case is unobserved. |
| L2 — cross-layer fallback | **Closed as filed**; error-message improvement adopted | Layers share **zero** tool names; there is no tool with two backends to fall back between. |
| L3 — write-op dedup | **Deferred, hazard recorded** | Guards a real hazard, but content-hash dedup would suppress intended repeats, and the root cause already has a better fix. |

The real unmet need these were standing in for is **explicit editor-readiness waiting** (§5), which is a different feature.

This document exists because all three are easy to re-derive from plausible-but-wrong premises. The reasoning below was itself wrong twice before it was right; the evidence is recorded so the next person does not repeat the loop.

## 1. What these were

Long-standing entries in CLAUDE.md's *Known Issues & Deferred Work*:

- **L1** — No TCP reconnection retry (filed as Phase 2 scope)
- **L2** — No graceful fallback across layers (Phase 4 scope)
- **L3** — Write-op deduplication not implemented (Phase 2 scope)

They were never specified, only named. That is part of why they persisted: a name is not a design, and nobody had tested the premises behind them.

## 2. Evidence gathered

All measurements are from this repository and a live UE 5.8 target project.

**Editor pre-init window — 128 seconds.** From the editor's own log on a large sample project: first log line to `LogUEMCP: UEMCP: TCP server listening on port 55558` spans `23:21:55.249` → `23:24:03.149`. Default `tcpTimeoutMs` is 10 000 ms.

Caveat, stated plainly: that project carries 356 built-in game-feature plugins and was opening on a freshly built engine version, so shader compilation inflates it. It is the slow end of the range. It is also the exact scenario cited to justify L1.

**Cross-layer tool-name overlap — zero.** 107 `tcp-55558` tools, 25 `offline`, 8 `http-30010`; no name appears in more than one layer. The nearest "equivalent" pair is not substitutable: the live actor-listing tool takes **no** parameters, while the offline one **requires** an asset path plus pagination and returns a different shape.

**Effect classification — already complete.** 105 handler tool definitions: 32 explicit `isReadOp: true`, 73 explicit `isReadOp: false`, **zero** omitted. `skipCache` derives from it centrally. There is no drift to lint against.

**Delivery phase is distinguishable.** The transport sets `tConnected` / `tSent` in `onConnect`; a connect-phase failure fires `onSocketError` before `onConnect` runs. Retry safety is therefore decidable — this part of the L1 analysis was sound and is preserved in §6 in case the item is ever reopened.

## 3. L1 — reconnection retry: closed

**The case for it.** D131 documents that during editor pre-init every call returns `ECONNREFUSED`, with the documented remedy "retry on the next user prompt" — a human doing what the transport could do. Retrying is provably safe when the request was never delivered, because no side effect can exist; that holds for writes as much as reads, so the usual write-retry objection does not apply.

**Why it fails anyway.** The window is ~128 s against a 10 s budget. Bounded in-call retry cannot bridge it. Widening the budget to cover it would block every caller for over two minutes on a cold editor, which is worse than a fast, clear failure.

Even against CLAUDE.md's (incorrect, see §6) 5–30 s figure, a 10 s budget covers only the optimistic end.

**What remains.** Transient connect failures unrelated to startup — socket backlog, a momentarily busy editor. These are **unobserved**. Building for them is speculative work of exactly the kind this analysis rejected elsewhere.

**Revisit if**: a connect-phase failure is observed on an editor already known-ready. Then the delivery-gated design in §6 applies directly and is small.

## 4. L2 — cross-layer fallback: closed as filed

**Why the premise does not hold.** "Graceful fallback across layers" presumes one tool served by multiple backends. UEMCP has distinct tools with distinct names, required parameters, and return shapes — zero overlap. Falling back would mean silently invoking a *differently named tool the caller never requested*, with different required parameters, returning a different payload shape.

For the canonical case it is not even mechanically possible: when the live actor-listing tool fails, the offline alternative needs an asset path the caller never supplied, and *which map is current* is knowable only from the editor that just failed to answer.

**What is adopted instead.** When a TCP tool fails because the editor is unreachable, the error should say so in those terms and note that offline tools can answer from disk, with the staleness caveat — rather than surfacing a bare `ECONNREFUSED`. This is a message change on an existing error path.

**Explicitly rejected**: a per-tool `offline_alternative:` mapping in `tools.yaml`. Agents already have `find_tools` for discovery, so a static per-tool mapping is metadata with no consumer the generic message does not serve.

## 5. L3 — write-op dedup: deferred, hazard recorded

**The hazard is real.** It is not made moot by declining L1. Retries we do not control exist: an agent or MCP client can re-issue a tool call. D118's actual incident was exactly that — the caller saw a timeout, retried, and double-applied a rename/delete.

**Why not build it now.**

1. **Content-hash dedup suppresses intended repeats.** Two legitimate identical add-component calls should add two components. Replaying the first result would be a new bug, in a system whose current failure mode is at least loud.
2. **The root cause already has a better fix.** D118 / D121 / D125 responded with per-tool timeout ceilings, preventing the false timeout that provokes the retry. Removing the trigger beats tolerating the retry.
3. **A correct dedup needs caller-supplied idempotency keys**, which is a tool-contract change rather than a transport tweak.

**Revisit if**: a caller-level double-apply is observed *after* the timeout ceilings — that would show the root-cause fix is insufficient. Design it around explicit idempotency keys, not content hashing.

## 6. Preserved analysis: if L1 is ever reopened

The safety rule, which held up under audit:

- Retry **only** when the request was never delivered. The predicate is *"no write was attempted"* — i.e. `onConnect` never ran — **not** `tSent` being unset. `socket.write()` is asynchronous, so `tSent` being *set* does not prove delivery; but if `write()` was never called, nothing was sent.
- Once a write has been attempted, never retry: the handler may have completed with the response lost. That ambiguity is what made D118 damaging.
- This axis is **delivery, not effect class**. Delivery-gated retry is safe for destructive writes and unsafe for idempotent reads-after-send alike.

Consequence: retry does **not** need read/write metadata, which removes one of the arguments for §7.

## 7. Related decision: effect classification not adopted now

A companion proposal — promoting effect classification (`read` / `write` / `destructive`) from handler modules into `tools.yaml` — was designed and then withdrawn under the same audit.

It fails the same test. Classification is already complete and explicit (105/105, zero drift), and no consumer needs it today:

- `destructive` would gate a confirm/dry-run policy for the 10 `status: planned` tools — **not being built**
- W6 Phase 2's per-tool `invalidates:` needs it — **deferred and metrics-gated**
- Retry would need it — **no longer true** (§6: retry keys on delivery)
- Surfacing destructiveness to a tool-selecting agent — marginal; names and descriptions already signal mutation

**Revisit when** the first real consumer is actually being built — most likely the planned destructive-write tools. Doing it then costs the same and carries a concrete requirement to design against.

## 8. The real unmet need — editor-readiness wait

The friction behind L1 is genuine; retry is simply the wrong shape for it. After launching the editor, callers must guess when the transport is live, and on a large project that is over two minutes.

Proposed instead, as its own small feature:

- An **explicit, opt-in readiness wait** with a caller-visible budget far larger than the per-call timeout (minutes, not seconds), polling until the listener answers.
- **Opt-in and explicit**, never implicit inside every call: a two-minute silent block is a worse failure than a fast error.
- Reports progress and the elapsed window, so a caller learns their project's real cost instead of inheriting a wrong constant.

Not specified here. It is a separate design with its own questions (tool-level or management-level, interaction with the per-layer queue, behaviour when the editor never becomes ready).

## 9. Corrections this record makes

- **CLAUDE.md's pre-init figure is wrong.** It documents "~5-30s (depending on project size + AR scan)"; measured 128 s on a large project. That understatement is part of why retry looked viable.
- **L1 / L2 / L3 are removed from *Known Issues*** and replaced by pointers here, so they read as decided rather than pending.

## 10. Method note

Three of five dispositions in the first draft of this analysis collapsed under adversarial review, including two reversals of the author's own reversals. Each collapse came from testing a premise rather than arguing it — measuring the pre-init window, counting cross-layer name overlap, counting classification coverage.

The recurring failure was accepting a *documented* number or a *plausible* architectural assumption without checking it. Where a claim is cheap to measure, measure it before designing on it.
