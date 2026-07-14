import { readFileSync } from 'node:fs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('AnimGraph topology validation');
const validationModule = await import('./anim-graph-topology-validation.mjs').catch(() => null);
const helpersModule = await import('./test-helpers.mjs');
const validate = validationModule?.validateAnimGraphPinTopology;
const createFixture = helpersModule.createAnimGraphTopologyFixture;

runner.assert(typeof validate === 'function',
  'exports reusable validateAnimGraphPinTopology helper');
runner.assert(typeof createFixture === 'function',
  'exports reusable AnimGraph topology fixture');

if (typeof validate === 'function' && typeof createFixture === 'function') {
  const valid = createFixture();
  const summary = validate(valid, { requireNonEmpty: true });
  runner.assert(summary.graph_count === 1 && summary.node_count === 1 && summary.pin_count === 4,
    'valid topology returns recomputed graph, node, and pin counts');
  runner.assert(summary.edge_count === 1 && summary.link_entry_count === 1,
    'valid topology returns recomputed link and edge counts');
  runner.assert(summary.complete === true && summary.truncated === false,
    'valid topology preserves completeness flags');
  runner.assert(summary.bytes > 0 && summary.dropped.dangling_link_count === 0,
    'validation summary records payload bytes and dropped counters');

  const explainedIncomplete = createFixture();
  explainedIncomplete.complete = false;
  explainedIncomplete.dropped.dangling_link_count = 1;
  explainedIncomplete.dropped.dangling_links = 1;
  const incompleteSummary = validate(explainedIncomplete);
  runner.assert(incompleteSummary.complete === false,
    'explained complete=false topology remains valid');

  const unexplainedIncomplete = createFixture();
  unexplainedIncomplete.complete = false;
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(unexplainedIncomplete)),
    /complete.*loss counters/i,
    'complete=false requires a nonzero serialization-loss counter',
  );

  const hiddenLoss = createFixture();
  hiddenLoss.dropped.dangling_parent_pin_count = 1;
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(hiddenLoss)),
    /complete.*loss counters/i,
    'complete=true rejects hidden serialization losses',
  );

  const hiddenNodeOwnershipLoss = createFixture();
  hiddenNodeOwnershipLoss.dropped.mismatched_node_graph_count = 1;
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(hiddenNodeOwnershipLoss)),
    /complete.*loss counters/i,
    'complete=true rejects mismatched node ownership',
  );

  const unresolvedEndpoint = createFixture();
  unresolvedEndpoint.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.linked_to[0].pin_id = 'ffffffffffffffffffffffffffffffff';
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(unresolvedEndpoint)),
    /endpoint does not resolve/i,
    'linked_to endpoints must resolve to serialized pins',
  );

  const unresolvedParent = createFixture();
  unresolvedParent.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.parent_pin_id = 'ffffffffffffffffffffffffffffffff';
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(unresolvedParent)),
    /parent.*(?:does not resolve|mismatch)/i,
    'split-pin parents must resolve within the owning node',
  );

  const asymmetricParent = createFixture();
  asymmetricParent.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.dddddddddddddddddddddddddddddddd.subpin_ids = [];
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(asymmetricParent)),
    /parent.*does not reference/i,
    'split-pin child references must be reciprocated by the parent',
  );

  const aliasDrift = createFixture();
  aliasDrift.dropped.null_nodes = 1;
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(aliasDrift)),
    /alias.*null_nodes/i,
    'documented dropped aliases must match canonical counters',
  );

  const hiddenDefaults = createFixture();
  hiddenDefaults.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.defaults = { default_value: 'unexpected' };
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(hiddenDefaults, { expectedIncludesPinDefaults: false })),
    /defaults.*includes_pin_defaults/i,
    'includes_pin_defaults=false rejects hidden per-pin defaults',
  );

  const missingDefaults = createFixture();
  missingDefaults.includes_pin_defaults = true;
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(missingDefaults, { expectedIncludesPinDefaults: true })),
    /defaults.*includes_pin_defaults/i,
    'includes_pin_defaults=true requires defaults on every serialized pin',
  );

  const defaultTopology = createFixture({ includePinDefaults: true });
  const defaultSummary = validate(defaultTopology, { expectedIncludesPinDefaults: true });
  runner.assert(defaultSummary.includes_pin_defaults === true,
    'fixture and validator exercise include_pin_defaults=true');

  const incompleteDefaults = createFixture({ includePinDefaults: true });
  delete incompleteDefaults.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.defaults.default_text_value;
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(incompleteDefaults)),
    /defaults.*default_text_value/i,
    'pin defaults require every documented safe field',
  );

  const invalidDirection = createFixture();
  invalidDirection.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.direction = 'sideways';
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(invalidDirection)),
    /direction.*EGPD/i,
    'pin direction must use a documented Unreal enum string',
  );

  const emptyPinType = createFixture();
  emptyPinType.graphs.AnimGraph.nodes.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    .pins.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pin_type = {};
  await runner.assertRejects(
    () => Promise.resolve().then(() => validate(emptyPinType)),
    /pin_type.*category/i,
    'pin type summary requires category, subcategory, and container',
  );
}

const liveSmokeSource = readFileSync(new URL('./live-smoke-animation-readback.mjs', import.meta.url), 'utf8');
runner.assert(liveSmokeSource.includes("from './anim-graph-topology-validation.mjs'"),
  'live animation smoke imports the shared topology validator');
runner.assert(!liveSmokeSource.includes('const GUID_RE') &&
  !liveSmokeSource.includes('const canonicalEdgeKey'),
'live animation smoke does not carry a second topology validator');

process.exit(runner.summary());
