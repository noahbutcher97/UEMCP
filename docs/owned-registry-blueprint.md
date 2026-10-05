# Owned registry and Blueprint relationships

From `server/`, run the combined required profile:

```sh
npm test -- --test-profile owned-registry-blueprint
node run-rotation.mjs --test-profile owned-registry-blueprint --json
```

This profile requires exactly 46 named cases: 24 in `test-owned-blueprint-data.mjs`,
14 in `test-owned-asset-registry.mjs`, and eight in
`test-owned-blueprint-inspect.mjs`. Individual required profiles are
`owned-blueprint-data`, `owned-asset-registry`, and `owned-blueprint-inspect`.
The default rotation discovers all three test files automatically.

The combined profile binds the existing UE5.6 package, manifest, independent UE
oracle and recorded authoring source. The data-only profile requires the three
corpus inputs; registry and inspection also require authoring source. Missing
inputs, missing suites, omitted cases, skipped cases and unsuccessful cases fail
qualification even if a suite reports a passing summary. Execution evidence binds
raw input hashes, source files, Git HEAD and local changes. No expectations are
regenerated during tests.

The suites cover distinct behavior:

- Data queries exclude a verified positive exec edge, return truthful empty data
  results and depth-limit metadata, accept raw public GUIDs with canonical echoes,
  and report exact missing-graph/node and parameter errors.
- Registry queries scan a real package, filter its primary class and authored tag,
  distinguish filtered-empty from an absent directory, preserve totals through
  pagination exhaustion, and reject invalid mount/traversal paths.
- Inspection resolves the generated class and its Object parent, links the CDO
  to the generated class, preserves distinct graph/function owners, and exposes
  the saved asset flags. Expectations are backed by independently audited raw
  package relationships and hash-bound authoring source.

The data suite is partial coverage toward INV-158/168. It cannot detect an
implementation that always returns correctly shaped empty data results. Positive
data sinks, populated pin/GUID/depth relationships, fan-out, multi-hop/cycles and
actual depth truncation need richer real authored content and an independent
oracle. No positive links are fabricated in this corpus.

The registry has one package with primary class Blueprint: secondary BPGC records
are not separate scan matches. This does not qualify consumer primary-BPGC
assumptions, multi-file scan caps, populated multi-page results or performance.
Inspection's Object parent does not qualify consumer GAS-parent relationships,
CDO defaults, maps, legacy packages or native/runtime behavior. Registry and
inspection ledger IDs are unspecified; none are inferred here.

All original synthetic, consumer and legacy tests remain retained. These profiles
make no whole-row equivalence, retirement or overall coverage-percentage claim.
