# Descendant process leak on protocol-deadline teardown

**Date**: 2026-08-25
**Status**: Diagnosed, not fixed
**Severity**: Real defect in shipped code, ~33% reproduction
**Surfaced by**: `test-protocol-smoke.mjs` — the assertions repeatedly dismissed as flaky

## Summary

When the deployment protocol smoke closes a stdio server, a **detached** grandchild process can survive permanently. It is not slow cleanup. Measured directly, the outcome is bimodal:

| Outcome | Runs |
|---|---|
| Reaped in **0-1 ms** | 8 / 12 |
| **Still alive at 60 s** | 4 / 12 |

Nothing lands in between. Teardown either works immediately or never happens.

Both scenarios leak — `spawn-descendant-hang` and `spawn-descendant-exit-on-eof` — at roughly a third of attempts each.

## Mechanism

`killProcessTree` (`server/deployment/process-runner.mjs`) terminates the tree with:

```
taskkill.exe /PID <child.pid> /T /F
```

`/T` enumerates the target's children **at the moment it runs**, by walking `ParentProcessId`. The fixture's descendant is spawned `detached: true` and `unref()`'d, so on Windows it sits in its own process group and does **not** die with its parent.

If the direct child exits before `taskkill` enumerates — which the EOF-exit path makes likely, and which scheduling can produce even in the hang path — then `taskkill` targets a PID that is already gone, finds no children, and the detached grandchild is orphaned for good.

Confirmed on the leaked processes: **3 of 4 had a dead parent** at the time of inspection.

## Why it looked like flakiness

The test asserts the tree is gone within 2 s. A leaked process fails that assertion, so the symptom is an intermittent red in the rotation — which reads as a timing-sensitive test rather than a defect.

It was misdiagnosed four times before measurement settled it:

1. **Contention from a concurrent engine build** — reproduced with nothing compiling.
2. **The suite leaking its own fixture servers** — exactly one was alive and it belonged to the running test.
3. **Reap budget too tight** — raised 2 s → 10 s; the failure recurred, because no budget helps a process that never exits.
4. **Ambient node-process pressure** — the machine's unrelated process count was irrelevant.

Each of those is plausible from the symptom alone. Only timing the descendant's actual exit distinguished them, and it did so immediately: 0 ms or never.

**The budget increase was reverted.** Two seconds is correct given a bimodal outcome; a larger budget only delays the report of a real leak.

## Impact

The affected path is deployment protocol smoke, which spawns candidate MCP servers to verify they initialize. A leaked descendant is an orphaned process holding memory until the machine reboots. Repeated smoke runs accumulate them — during this investigation alone, twelve runs produced four permanent orphans.

Nothing in normal UEMCP tool use spawns detached grandchildren, so the blast radius is the deployment tooling rather than the editor transport.

## Measured: the two obvious cheap fixes do not work

Both were tried and rejected on evidence, so nobody repeats them.

### Widening the wait budget — rejected

Raised 2 s to 10 s. The failure recurred. Obvious in hindsight given the bimodal
result: no budget helps a process that never exits, and a longer one only delays
the report. Reverted.

### Removing the aliveness guard — rejected

`close()` skips `_terminateTree` when the direct child has already exited:

```js
if (child.exitCode === null && child.signalCode === null) {
  await this._terminateTree(child);
}
```

That looks exactly like the bug — the detached descendant outlives its parent, so
skipping termination because the parent is gone is backwards. Removing the guard
is defensible in principle.

It changes nothing in practice:

| Configuration | Leak rate |
|---|---|
| Guard present (shipped) | 4 / 12 = 33% |
| Guard removed, n=12 | 1 / 12 = 8% |
| Guard removed, n=24 | **8 / 24 = 33%**, split evenly 4 EOF / 4 hang |

The 1-in-12 was small-sample luck. At n=24 the rate is identical to shipped. The
change also costs a `taskkill.exe` spawn on every close, including the common
case of a child that exited cleanly. No benefit, nonzero cost — **reverted**.

**Sample twenty or more runs before believing any result here.** A third of runs
already pass while leaking, so a short clean streak means nothing.

### Why neither works

The dominant race is not the guard. `taskkill /T` is itself a spawned process,
tens of milliseconds from decision to enumeration. If the child exits inside that
window, there is no parent left to enumerate children from, and the detached
grandchild is unreachable — regardless of what the calling code checked first.

That race cannot be won from userland. It can only be removed by making
descendant termination something the OS guarantees rather than something the code
races for, which is what option B does.

## Fix options

**A — Reorder or unguard the kill.** Measured above and rejected: it narrows nothing meaningful, because the race is `taskkill`'s own spawn latency rather than the ordering of the call.

**B — Job object (recommended).** Assign the child to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The OS then guarantees every descendant dies with the job, regardless of detachment or exit ordering. This is the mechanism Windows provides for exactly this problem, and it removes the race rather than shrinking it. Cost: a native binding or a helper, since Node does not expose job objects directly.

**C — Record and kill descendants explicitly.** Have the transport track spawned PIDs and kill them individually. Works, but only for descendants we know about — it cannot cover a server that spawns its own helpers, which is precisely the case the test models.

## Recommended next step

Reproduce with the timing probe (the technique in this document: run the scenario, then poll the descendant PID until exit or a hard cap), confirm the bimodal split still holds, then implement **B**. Verify by running the probe twenty times and requiring zero survivors — a pass rate is not sufficient evidence here, since a third of runs already pass while leaking.

Do **not** relax the test's 2 s assertion as part of the fix. That assertion is the only thing that surfaced this.
