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

## Fix options

**A — Kill the tree before closing stdin.** Reorder teardown so `taskkill /T` runs while the direct child is still alive and its children are still enumerable. Smallest change; narrows but does not eliminate the race, since the child may exit on its own at any moment.

**B — Job object (recommended).** Assign the child to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The OS then guarantees every descendant dies with the job, regardless of detachment or exit ordering. This is the mechanism Windows provides for exactly this problem, and it removes the race rather than shrinking it. Cost: a native binding or a helper, since Node does not expose job objects directly.

**C — Record and kill descendants explicitly.** Have the transport track spawned PIDs and kill them individually. Works, but only for descendants we know about — it cannot cover a server that spawns its own helpers, which is precisely the case the test models.

## Recommended next step

Reproduce with the timing probe (the technique in this document: run the scenario, then poll the descendant PID until exit or a hard cap), confirm the bimodal split still holds, then implement **B**. Verify by running the probe twenty times and requiring zero survivors — a pass rate is not sufficient evidence here, since a third of runs already pass while leaking.

Do **not** relax the test's 2 s assertion as part of the fix. That assertion is the only thing that surfaced this.
