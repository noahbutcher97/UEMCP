# Owned PIE lifecycle qualification

`owned-pie-lifecycle-offline` is an additive engine-free profile. It exercises a
two-cycle runner through the real `ProjectContext` and `ConnectionManager` using
an injected responder. It does not prove that Unreal started, stopped, or returned
the actor state. All existing profiles and native/consumer obligations remain.
The historical cloud patch and its reported counts are not inputs to this work.

```powershell
cd server
node run-rotation.mjs --test-profile owned-pie-lifecycle-offline --json
npm test
```

The runner verifies initially stopped PIE, typed `PIE_NOT_RUNNING`, requests
viewport PIE, polls for one standalone runtime world, checks `ALREADY_RUNNING`,
checks a known actor, checks `ACTOR_NOT_FOUND` for an independently absent name,
requests stop, and polls stopped state. It repeats the complete cycle twice.
Actor name, full class path, location, rotation, scale and `CustomTimeDilation`
must match the supplied oracle exactly. World package path, preserved UWorld
object name, default instance and standalone net mode are also checked.

The native source contract is `EdgeCaseHandlers.cpp` (PIE handlers and actor
serialization) and `MCPResponseBuilder.cpp` (success/result and typed top-level
error envelopes). Unreal's `World.cpp::DuplicateWorldForPIE` retains the source
UWorld name; `PlayLevel.cpp` prefixes its package through
`ConvertToPIEPackageName`. For `/Game/OwnedPIE/Lifecycle`, instance zero therefore
has `world_name: Lifecycle` and
`world_path: /Game/OwnedPIE/UEDPIE_0_Lifecycle.Lifecycle`.

## Adapter contract

Construct `createOwnedPieTransport` with a dedicated `ConnectionManager`, attached
`ProjectContext`, `verifyOwnedHost`, and `reconcile`. Use a single owner and do not
share this manager with unrelated command dispatch. Project generation and
canonical project identity are captured at construction. Live mutation readiness
is required for every call in this owned lifecycle, including observations.
The owner must establish real editor/transport identity and deploy freshness;
the offline helper's fake handshake is not native proof.

Each call requires an absolute Unix-millisecond `deadlineAt`. All commands bypass
the result cache. The manager's optional synchronous `beforeDispatch` hook runs
after queue waiting; `deadlineAt` reduces the wire budget by queue residence and
prevents an expired queued command from dispatching. Readiness is checked both at
dispatch and after a successful response. Original transport errors survive
readiness loss. Calls on the adapter cannot overlap.

A start/stop timeout does **not** cancel Unreal's queued or running operation.
Transport failures, malformed acknowledgements, post-dispatch readiness loss,
and unknown server errors lock all future calls on this adapter. Only the
source-confirmed pre-mutation errors are treated as rejections: start's
`NO_EDITOR`, `ALREADY_RUNNING`, `INVALID_PIE_MODE`; stop's `NO_EDITOR`.
An ambiguous mutation retains its ProjectContext mutation guard despite late
replies. No late response unlocks the adapter.

Both owner callbacks receive `{deadlineAt, timeoutMs, signal, identity,
generation}`. Verification also receives `oracle`; reconciliation also receives
the original `reason` and `ambiguity`. The callbacks must obey the deadline and
cooperate with the signal. The adapter bounds its local wait, checks elapsed time
after fulfillment, and aborts its signal on expiry. This cannot cancel remote
commands or a callback that ignores the signal.

A deadline failure after verification starts locks the adapter, even if the
verifier ignores cancellation or later settles. Reads, start/stop and another
verification are rejected. A deadline already expired before invocation leaves
an unused adapter open. Verification does not create a mutation guard.
Reconciliation first waits for that verifier to settle, then invokes the owner
callback under the same absolute deadline. Settlement alone is not drainage.
If the wait expires, the adapter remains locked and later settlement cannot
invoke reconciliation; the coordinator must handle remaining work out of band.

`verifyOwnedHost` is read-only. It must hold/validate the coordinator's exclusive
lease, confirm the exact attached project and owned loaded map, validate the
independently authored oracle and absent probe, and confirm one in-process
standalone client with simulation disabled. Return exactly the positive facts:

```js
{ owned: true, mapPath: oracle.mapPath, missingActorAbsent: true, standalone: true }
```

`reconcile` operates out of band under that same exclusive ownership. It must
resolve/drain outstanding transport and GameThread requests, account for pending
`RequestPlaySession` / `RequestEndPlayMap`, and then prove PIE stopped with no
pending lifecycle operation capable of restarting it. A single stopped snapshot
or `stop_pie` returning `was_running:false` is insufficient while start is pending.
Return `{owned:true, stopped:true, pendingOperationsDrained:true}` only with that
evidence. Include native receipts in the coordinator's retained evidence.

Reconciliation is attempted at most once per adapter. Success releases its
retained mutation guard and permanently closes that instance. Failure or timeout
leaves it locked; the coordinator handles any remaining callback/remote work out
of band. A new adapter requires renewed owner verification. Do not automatically
clear the old guard, retry timed-out commands, or reuse the old adapter.

On failure after observing a valid running world, the runner attempts bounded
stop-and-poll cleanup. If that fails, it invokes bounded reconciliation once.
Before startup has been observed, it goes straight to reconciliation because a
no-op stop does not drain pending startup. The original failure remains primary,
with `error.cleanup` and completed `error.events` attached. Worst-case local wait
is the main budget plus two cleanup budgets; an uncooperative callback or remote
operation remains an explicit owner obligation after the local wait expires.

## Native queue handoff

Only the assigned native coordinator may execute this lane. The source worker
does not launch/build/sync the host, load maps, change editor settings, author
assets, or clean native resources. Queue prerequisites:

1. Exclusive coordinator lease for the owned project/editor/transport and exact
   source/deployment receipts. No concurrent host mutation by other workers.
2. An owned saved map already loaded. Supply its exact `/Game/...` package path.
   PIE must initially be stopped, with zero active contexts and default instance
   `-1`. Pending prior starts/stops must already be drained.
3. An independently authored static actor in that map. Record its exact name,
   full class path, location, rotation, scale, and `CustomTimeDilation` in an
   oracle before invoking the runner. Disable movement, physics, gameplay or
   construction behavior that changes these values. Use exactly representable
   transforms where possible. Do not derive expected values from the runtime
   command being tested.
4. A distinct actor name independently confirmed absent from the entire runtime
   map. This is the negative actor probe.
5. One in-process PIE client, net mode `Standalone`, no simulation or extra
   worlds. The runner sends `{mode:'viewport'}`. **Do not use `mode:'standalone'`**:
   the current handler selects `NewProcess`, outside this runtime world lane.
6. Implement the bounded owner callbacks above. If reliable pending-operation
   drainage cannot be established, reconciliation must fail and retain ownership
   for manual coordinator recovery; do not report native qualification passed.

Coordinator integration (library only; no native launch CLI is provided):

```js
import { createOwnedPieTransport } from './server/owned-pie-transport.mjs';
import { runOwnedPieLifecycle } from './server/owned-pie-lifecycle.mjs';

const adapter = createOwnedPieTransport({
  projectContext, connectionManager, verifyOwnedHost, reconcile,
});
const result = await runOwnedPieLifecycle({
  adapter,
  oracle: {
    mapPath, name, class: actorClassPath, location, rotation, scale,
    CustomTimeDilation, missingActorName,
  },
  timeoutMs: 30000, cleanupTimeoutMs: 10000, pollMs: 25,
});
```

Retain source SHA/diff identity, engine version, plugin/deployment identity,
project/map/actor authoring receipts, ownership verification, command/response
transcript with deadlines, both cycle results, and final stopped/drained evidence.
Keep fake responder execution and native execution distinctly labelled.
Classification: **retain: partial**. This does not retire any legacy, consumer,
network PIE, native, stability-sampling, or multiworld test obligation.
