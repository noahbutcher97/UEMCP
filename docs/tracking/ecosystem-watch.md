# Organization, research and ecosystem upkeep (U12)

Added 2026-11-07. This is a recurring maintenance unit, not a blocking phase for
all feature work. The active slice owner performs the small relevant check;
the release owner handles the broader checkpoint. No scheduled automation has
been installed by this plan.

## Three bounded audits

| Audit | Cadence / trigger | Output and completion gate |
|---|---|---|
| Organization (AUD-1) | Close each work slice; broader check before release or after a batch of merges | Reconcile roadmap IDs, shipped tools and completion links; check docs routing, stale plans, duplicate helpers, test ownership, dirty files, unique commits and retained linked checkouts and output roots. Record each finding as fix, explicit retention or one owned backlog item. Preserve unique work before cleanup; never delete merely because a plan looks old. |
| Research freshness (AUD-2) | Before implementing a researched design; monthly while development is active; immediately after relevant engine/MCP changes | Check decision-driving claims against the installed engine and primary upstream sources. Record version/date/revision, what was actually inspected and what remains an assumption. Mark obsolete conclusions superseded with rationale, without rewriting historical receipts. Close with adopt, experiment, defer or reject decisions. |
| Ecosystem review (AUD-3) | Monthly while active; before a new capability or transport design | Review a bounded shortlist's commits/releases, relevant issues/tests and official engine changes since the previous checkpoint. Produce at most three actionable findings tied to U1-U11, or record no relevant change. A project README is discovery evidence, not proof of correctness or recent maintenance. |

Start with 30-60 minutes for a monthly review; promote a deeper investigation
only when it could change a concrete product/developer decision. Lightweight
task cleanup and source rechecks happen within normal delivery. A review does
not automatically authorize upgrading dependencies, enabling plugins, replacing
transport, copying third-party code or expanding the roadmap.

## Initial source watchlist

Discovery checked 2026-11-07. Primary documentation/repository pages were read;
peer implementations were not compiled or exercised. Latest commit dates and
release revisions have not yet been captured, so these are candidates to monitor,
not a verified ranking of currently active or reliable projects.

| Source | Observed surface / what to investigate | UEMCP relevance |
|---|---|---|
| [Epic Unreal MCP](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor) | Official experimental in-editor HTTP MCP and toolset registry; documentation describes serialized game-thread calls and dynamic discovery. Check installed toolsets before adding a duplicate feature. | U1/U2/U5/U10/U11: native integration opportunities and evolving contracts. |
| [db-lyon/ue-mcp](https://github.com/db-lyon/ue-mcp) | README describes native-tool wrapping, multi-editor workflows, rollback flows and an editor client. Audit one relevant route's implementation and tests rather than adopting breadth claims. | U2/U5/U10: discovery, workflow recovery and onboarding comparisons. |
| [Natfii/ue5-mcp-bridge](https://github.com/Natfii/ue5-mcp-bridge) | README lists AnimBP state/transition operations, pin inspection and compile diagnostics through a separate backend. Trace both wrapper and backend before crediting an authoring guarantee. | U4/U5: operation granularity, validation and useful next animation slices. |
| [voodoofox/unreal-mcp](https://github.com/voodoofox/unreal-mcp) | README describes C++ graph operations, a Python inspection route and a sample project. Compare failure reporting and fixtures; animation listings here are primarily inspection. | U3/U7/U9: reusable testing and inspection ideas; no assumed AnimGraph authoring parity. |
| [UECortex](https://github.com/ashd-007/UECortex) and [GeneralBlueprint](https://github.com/cc8887/GeneralBlueprint) | Discovery candidates for native MCP and animation/graph authoring approaches. Detailed handler/test/license comparison remains pending. | U4/U5/U11: shortlist for targeted follow-up, not adoption decisions. |

Local engine inspection also found the experimental ToolsetRegistry and
AnimationAssistantToolset sources. Finding files does not establish that they
are enabled, exposed in a session, or equivalent to U5's proposed Slot edit.

## Evidence to capture for each useful finding

Capture the repository/source URL; checked date; exact commit/release and engine
version where available; license if considering reuse; relevant handler and
tests; advertised versus source-inspected versus executed behavior; user benefit;
UEMCP overlap; adoption cost; and the decision with a refresh trigger.

For graph tools specifically compare node/pin identity, schema validation,
implicit link replacement, transaction coverage, compile-failure reporting,
save/restart proof and unexpected cross-asset mutation. For infrastructure,
compare project identity, concurrency, timeout outcomes, tool discovery cost,
output bounds and repeatable tests. Popularity and tool count are not acceptance
criteria. Prefer reusing engine APIs or interoperating when that meets our
contract; preserve notices and review licenses before any source reuse.

Keep durable decisions and the current watchlist here. Put local bulky receipts
and one-off research artifacts in the existing ignored research/audit locations,
with a concise shareable conclusion in tracked docs. Do not create a second
backlog or leave an unbounded collection of temporary checkouts.
