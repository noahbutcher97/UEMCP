# Owned Blueprint discovery and inspection (T09b)

Run from `server/`, with no project attachment or installed Unreal Engine:

```sh
node test-owned-blueprint-query.mjs
```

The suite has 41 required named cases. Missing or invalid corpus data fails before
queries run; it never becomes a skipped consumer probe. The default rotation
discovers `test-*.mjs`, so it also picks up this suite automatically.
**Explicit required-profile integration is deferred** until the parallel desktop
native Blueprint slice is published. This change adds no profile, execution
manifest integration, runner modifications, or ledger updates.

## Evidence and acceptance

This is partial coverage toward INV-112/160/270, not completion of those
invariants. All queries call the public `executeOfflineTool` dispatcher with the
explicit immutable `server/fixtures/serialization/ue5.6-owned-v1` root. The existing
verifier first checks corpus provenance, hashes, saved package identity, and
agreement with the independent UE reload oracle.

The suite checks:

- Exact graph, node and entry-point discovery for `OwnedGraph`, `OwnedPrint` and
  `OwnedEvent`, including class, GUID, authored member, position and target.
- Class, member, target and combined filters, unmatched/conflicting filters,
  member case sensitivity, ordered pages, exhaustion, totals and truncation,
  and filtering before pagination.
- Inspection by authored name and discovered numeric ID for both nodes, plus
  entry-point ID handoff; pin availability, all oracle pin names/directions and
  exact link endpoints in both directions.
- The authored `InString` literal `UEMCP owned serialization fixture`. The UE
  oracle does not record defaults: this expectation is independently grounded
  in `AuthorSerializationFixtureCommandlet.cpp`, whose content must match the
  recorded authoring source hash after normalizing checkout CRLF to LF. Both
  newline forms are tested; an actual source edit is rejected. The original
  manifest and immutable package/oracle byte hashes remain unchanged.
- Unknown graph/node rejection and negative controls for missing discovery,
  wrong GUID/total, dropped/renamed/reversed pins, dropped/wrong link endpoints,
  changed literal, edited authoring source, missing corpus, changed oracle bytes
  and invalid provenance.

Negative controls require an intact positive baseline first. Response mutations
use clones; corpus mutations use temporary copies, cleaned in `finally`. Normal
execution neither regenerates expectations nor changes the checked-in corpus.
Oracle pin/link ordering is ignored; identities, multiplicity and endpoints are
compared exactly. Pin IDs qualify this immutable save/oracle pair only: a future
UE resave or pin reconstruction needs separate review. Numeric export IDs are
obtained through discovery instead of being pinned to incidental table offsets.
The spatial GUID conversion used in expectations is local to the test and does
not call the production conversion helper.

## Explicit qualification limits

**Graph-type classification is excluded.** The authoring commandlet uses
`AddUbergraphPage` for `OwnedGraph`, while the current offline discovery heuristic
reports `function`. Assertions deliberately omit `graph_type` and
`outer_graph_type`; they do not bless this label or claim correct ubergraph
classification. Production behavior is unchanged.

One UE 5.6 package with two nodes and one execution connection cannot qualify
branching, cycles, self-loops, data-flow traversal, comments/containment,
AnimBlueprints, arbitrary graph families, GUID-as-input lookup, genuine old-engine
packages, or general consumer compatibility. Existing synthetic, consumer and
legacy compatibility witnesses remain necessary and unchanged. This engine-free
suite is not native handler or runtime qualification and runs no Unreal process.

The two-file boundary is `server/test-owned-blueprint-query.mjs` and this document.
Native Blueprint profile/manifest/runner regressions and their documentation
remain owned by the desktop task. Shared profile evidence must be added in a
later coordinated change before claiming a required-profile migration gate.
