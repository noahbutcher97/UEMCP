# Descendant process leak on protocol-deadline teardown

**Date**: 2026-08-25
**Status**: FIXED — one constant. Earlier sections preserved as the record of four wrong diagnoses.
**Severity**: Real defect in shipped code, ~33% reproduction
**Surfaced by**: `test-protocol-smoke.mjs` — the assertions repeatedly dismissed as flaky

## Resolution

**`taskkill` was being abandoned mid-flight, not defeated.**

Separating spawn cost from work cost found it. On this machine:

| Command | Median |
|---|---|
| `cmd /c exit` — pure spawn | **82 ms** |
| `taskkill /PID 999999` — a PID that does not exist | **3474 ms** |
| `tasklist` | 4422 ms |

`taskkill` costs about three and a half seconds with nothing to do. Its budget in
`terminateProcessTree` was **5000 ms**, and it measured **3125-4975 ms** across
runs — straddling its own timeout. On timeout the code kills the taskkill process
and falls back to `killDirectChild`, which reaches the direct child and nothing
below it. The detached descendant then survives, and its parent is gone, which is
why every leaked process looked orphaned.

Orphaning was the *consequence*. The cause was giving up on a tree kill that was
about to succeed.

**Fix**: `timeoutMs` default 5_000 to 30_000 in `terminateProcessTree`.

**Verification**: 56 of 56 clean across two independent 28-run probes, against
8 of 24 leaking before. `test-protocol-smoke` 29/0 standalone; three consecutive
rotations at 7371/0, where the same three runs previously failed 1, 1 and 2.

**Cost**: none. Teardown already paid taskkill's ~3.5 s; a larger bound does not
slow the successful path, it stops premature abandonment. Nothing is spawned that
was not already spawned.

**Retired by this**: the job object and its native dependency, the orphan sweep,
and the proposal to accept the leak as a documented limitation. All were reasoned
from the assumption that the tree kill *ran and failed*. It was not running to
completion.

**Note the environment dependence.** A no-op `taskkill` at 3.5 s is abnormal;
typical is tens of milliseconds. `cmd /c exit` at 82 ms rules out general spawn
slowness, so something machine-specific — Defender is the usual suspect — inflates
it here. A fixed budget tuned on a fast machine is exactly the kind of thing that
fails silently on a slow one, which is the transferable lesson.

## Everything below is superseded

Kept deliberately. It is an accurate record of four diagnoses that fit every
observation and were still wrong, and of two fixes measured and rejected. Read it
for the reasoning, not for the conclusions — the mechanism it describes is not
what was happening.

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

### Orphan sweep by parent PID — tried, measured, rejected

The most promising no-native option, and the one that made the job object look
avoidable. Windows keeps `ParentProcessId` on a surviving child's record after
the parent dies, so the orphan stays discoverable by the dead parent's PID.
Verified directly: parent gone, grandchild alive, query by the dead PID returned
it. `taskkill /T` fails only because the PID is gone, not because the link is.

Implemented as a post-`taskkill` sweep — enumerate children of the child PID and
stop them — plus removing the aliveness guard, since the sweep is unreachable
without it. **Neither half works alone**, which is why each measured as a no-op
in isolation:

| Configuration | Leak rate |
|---|---|
| Shipped | 8 / 24 = 33% |
| Guard removed only | 8 / 24 = 33% |
| Sweep only, guard still in place | 10 / 28 = 36% |
| **Guard removed + sweep** | **2 / 28 = 7%** |

A real improvement — `hang` mode went 14/14 clean. It is still rejected, on cost:

**Process enumeration costs about five seconds on this machine.** Not PowerShell
startup — `tasklist` measured 5185 ms and `wmic` is removed entirely (ENOENT) on
current Windows. The PowerShell CIM sweep measured 4.5-5.5 s across six runs.

That is fatal twice over. The sweep's own budget is 5 s, so it times out about
half the time and gives up — that is the residual 7%. And when it does succeed it
adds five seconds to every teardown, including the common case where nothing
leaked, which also breaks the test's 2 s assertion even when the fix worked.

No tuning rescues it: a longer budget makes teardown slower, a shorter one makes
the sweep useless. The approach needs an enumeration primitive that costs
milliseconds, and none is available externally.

**Reverted.** ~~This is the measurement that turns the job object from
*preferred* into *necessary*.~~ **Wrong conclusion — see Resolution.** The sweep
timed out for the same reason the tree kill did: a ~5 s budget against a ~5 s
operation. Every process-enumeration cost measured here is real; what does not
follow is that a job object was needed. Widening the existing budget was enough.

### Why neither works

The dominant race is not the guard. `taskkill /T` is itself a spawned process,
tens of milliseconds from decision to enumeration. If the child exits inside that
window, there is no parent left to enumerate children from, and the detached
grandchild is unreachable — regardless of what the calling code checked first.

~~That race cannot be won from userland.~~ **Wrong — see Resolution.** There was
no race to win. `taskkill /T` was reaching the tree correctly; the caller stopped
waiting for it. The "window" theorized here is tens of milliseconds, which never
matched a defect rate of one run in three — a discrepancy visible at the time and
not pursued.

## Fix options

**A — Reorder or unguard the kill.** Measured above and rejected: it narrows nothing meaningful, because the race is `taskkill`'s own spawn latency rather than the ordering of the call.

**B — Job object. NOT NEEDED — see Resolution.** Assign the child to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The OS then guarantees every descendant dies with the job, regardless of detachment or exit ordering. This is the mechanism Windows provides for exactly this problem, and it removes the race rather than shrinking it. Cost: a native binding or a helper, since Node does not expose job objects directly.

**C — Record and kill descendants explicitly.** Have the transport track spawned PIDs and kill them individually. Works, but only for descendants we know about — it cannot cover a server that spawns its own helpers, which is precisely the case the test models.

## Recommended next step — DONE, differently

Resolved by widening the teardown budget (see Resolution). The instruction below
was followed for its first half — reproduce with a timing probe — and that is what
found the real cause. Its second half, implement B, was not needed.

The verification bar it sets still stands and was met: 20+ probe runs requiring
zero survivors, not a pass rate.

~~Reproduce with the timing probe~~ (the technique in this document: run the scenario, then poll the descendant PID until exit or a hard cap), confirm the bimodal split still holds, then implement **B**. Verify by running the probe twenty times and requiring zero survivors — a pass rate is not sufficient evidence here, since a third of runs already pass while leaking.

Do **not** relax the test's 2 s assertion as part of the fix. That assertion is the only thing that surfaced this.
