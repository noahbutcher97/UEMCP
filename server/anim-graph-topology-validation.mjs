const GUID_RE = /^[0-9a-f]{32}$/i;
const PIN_DIRECTIONS = new Set(['EGPD_Input', 'EGPD_Output', 'EGPD_Unknown']);
const PIN_CONTAINERS = new Set(['None', 'Array', 'Set', 'Map', 'Unknown']);

const REQUIRED_DROPPED_FIELDS = [
  'null_graph_count',
  'null_referenced_graph_count',
  'null_node_count',
  'null_node_graph_count',
  'mismatched_node_graph_count',
  'null_pin_count',
  'null_pin_owner_count',
  'mismatched_pin_owner_count',
  'dangling_parent_pin_count',
  'dangling_subpin_count',
  'null_linked_pin_count',
  'null_linked_owner_count',
  'dangling_link_count',
  'orphan_pin_count',
  'duplicate_graph_key_count',
  'duplicate_node_key_count',
  'duplicate_pin_key_count',
  'invalid_node_guid_count',
  'invalid_pin_guid_count',
];

const DROPPED_ALIASES = {
  null_nodes: 'null_node_count',
  null_pins: 'null_pin_count',
  null_linked_pins: 'null_linked_pin_count',
  dangling_links: 'dangling_link_count',
  orphaned_pins: 'orphan_pin_count',
  duplicate_graph_keys: 'duplicate_graph_key_count',
  duplicate_node_guids: 'duplicate_node_key_count',
  duplicate_pin_ids: 'duplicate_pin_key_count',
};

export const ANIM_GRAPH_TOPOLOGY_LOSS_FIELDS = Object.freeze([
  'null_graph_count',
  'null_referenced_graph_count',
  'null_node_count',
  'null_node_graph_count',
  'mismatched_node_graph_count',
  'null_pin_count',
  'null_pin_owner_count',
  'mismatched_pin_owner_count',
  'dangling_parent_pin_count',
  'dangling_subpin_count',
  'null_linked_pin_count',
  'null_linked_owner_count',
  'dangling_link_count',
  'duplicate_node_key_count',
  'duplicate_pin_key_count',
  'invalid_node_guid_count',
  'invalid_pin_guid_count',
]);

function fail(message) {
  throw new Error(`AnimGraph pin topology validation failed: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(label, value) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireField(record, field, label) {
  if (!(field in record)) fail(`${label} is missing ${field}`);
  return record[field];
}

function requireCount(label, value) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function requireGuid(label, value, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !GUID_RE.test(value)) {
    fail(`${label} must be a 32-character digits GUID${nullable ? ' or null' : ''}`);
  }
  return value;
}

function endpointKey(graphKey, nodeGuid, pinId) {
  return JSON.stringify([graphKey, nodeGuid, pinId]);
}

function canonicalEdgeKey(a, b) {
  return JSON.stringify(a <= b ? [a, b] : [b, a]);
}

export function validateAnimGraphPinTopology(topology, {
  requireComplete = false,
  requireNonEmpty = false,
  allowTruncated = false,
  expectedIncludesPinDefaults,
} = {}) {
  requireRecord('pin_topology', topology);
  if (topology.schema_version !== 'anim-uedgraph-pin-topology-v1') {
    fail(`unexpected schema_version ${String(topology.schema_version)}`);
  }
  if (topology.id_format !== 'digits') fail(`unexpected id_format ${String(topology.id_format)}`);
  if (typeof topology.complete !== 'boolean') fail('complete must be boolean');
  if (typeof topology.truncated !== 'boolean') fail('truncated must be boolean');
  if (topology.truncated && !allowTruncated) fail('truncated=true is not supported by this validator call');
  if (topology.truncated && topology.complete) fail('complete cannot be true when truncated is true');
  if (typeof topology.includes_pin_defaults !== 'boolean') fail('includes_pin_defaults must be boolean');
  if (expectedIncludesPinDefaults !== undefined &&
      topology.includes_pin_defaults !== expectedIncludesPinDefaults) {
    fail(`includes_pin_defaults must be ${expectedIncludesPinDefaults}`);
  }

  for (const field of ['graph_count', 'node_count', 'pin_count', 'link_entry_count', 'edge_count']) {
    requireCount(`pin_topology.${field}`, requireField(topology, field, 'pin_topology'));
  }

  const dropped = requireRecord('pin_topology.dropped', topology.dropped);
  for (const field of REQUIRED_DROPPED_FIELDS) {
    requireCount(`pin_topology.dropped.${field}`, requireField(dropped, field, 'pin_topology.dropped'));
  }
  for (const [alias, canonical] of Object.entries(DROPPED_ALIASES)) {
    const aliasValue = requireCount(
      `pin_topology.dropped.${alias}`,
      requireField(dropped, alias, 'pin_topology.dropped'),
    );
    if (aliasValue !== dropped[canonical]) {
      fail(`dropped alias ${alias} must equal ${canonical}`);
    }
  }

  const graphs = requireRecord('pin_topology.graphs', topology.graphs);
  const graphEntries = Object.entries(graphs);
  if (requireNonEmpty && graphEntries.length === 0) fail('graphs must not be empty');
  if (topology.graph_count !== graphEntries.length) fail('graph_count does not match graphs map');

  let serializedNodeCount = 0;
  let serializedPinCount = 0;
  let serializedLinkEntryCount = 0;
  const endpointKeys = new Set();
  const pinEntries = [];

  for (const [graphKey, graphValue] of graphEntries) {
    const graph = requireRecord(`graph ${graphKey}`, graphValue);
    for (const field of [
      'graph_key', 'graph_guid', 'name', 'path', 'class_name', 'schema_class',
      'graph_type', 'sources', 'node_count', 'nodes',
    ]) {
      requireField(graph, field, `graph ${graphKey}`);
    }
    if (graph.graph_key !== graphKey) fail(`graph map key mismatch for ${graphKey}`);
    requireGuid(`graph ${graphKey} graph_guid`, graph.graph_guid, { nullable: true });
    for (const field of ['name', 'path', 'class_name', 'graph_type']) {
      if (typeof graph[field] !== 'string') fail(`graph ${graphKey} ${field} must be a string`);
    }
    if (graph.schema_class !== null && typeof graph.schema_class !== 'string') {
      fail(`graph ${graphKey} schema_class must be a string or null`);
    }
    if (!Array.isArray(graph.sources) || graph.sources.some((source) => typeof source !== 'string')) {
      fail(`graph ${graphKey} sources must be an array of strings`);
    }

    const nodes = requireRecord(`graph ${graphKey} nodes`, graph.nodes);
    const nodeEntries = Object.entries(nodes);
    requireCount(`graph ${graphKey} node_count`, graph.node_count);
    if (graph.node_count !== nodeEntries.length) fail(`graph ${graphKey} node_count does not match nodes map`);
    serializedNodeCount += nodeEntries.length;

    for (const [nodeKey, nodeValue] of nodeEntries) {
      const node = requireRecord(`node ${nodeKey}`, nodeValue);
      for (const field of ['graph_key', 'node_guid', 'class_name', 'title', 'x', 'y', 'pin_count', 'pins']) {
        requireField(node, field, `node ${nodeKey}`);
      }
      if (node.node_guid !== nodeKey) fail(`node map key mismatch for ${nodeKey}`);
      requireGuid(`node ${nodeKey} node_guid`, node.node_guid);
      if (node.graph_key !== graphKey) fail(`node ${nodeKey} graph_key does not match ${graphKey}`);
      if (typeof node.class_name !== 'string' || typeof node.title !== 'string') {
        fail(`node ${nodeKey} class_name and title must be strings`);
      }
      if (typeof node.x !== 'number' || !Number.isFinite(node.x) ||
          typeof node.y !== 'number' || !Number.isFinite(node.y)) {
        fail(`node ${nodeKey} x and y must be finite numbers`);
      }

      const pins = requireRecord(`node ${nodeKey} pins`, node.pins);
      const nodePinEntries = Object.entries(pins);
      requireCount(`node ${nodeKey} pin_count`, node.pin_count);
      if (node.pin_count !== nodePinEntries.length) fail(`node ${nodeKey} pin_count does not match pins map`);
      serializedPinCount += nodePinEntries.length;

      for (const [pinKey, pinValue] of nodePinEntries) {
        const pin = requireRecord(`pin ${pinKey}`, pinValue);
        for (const field of [
          'pin_id', 'name', 'direction', 'pin_category', 'pin_subcategory', 'pin_type',
          'is_subpin', 'parent_pin_id', 'subpin_ids', 'orphaned', 'linked_to', 'link_count',
        ]) {
          requireField(pin, field, `pin ${pinKey}`);
        }
        if (pin.pin_id !== pinKey) fail(`pin map key mismatch for ${pinKey}`);
        requireGuid(`pin ${pinKey} pin_id`, pin.pin_id);
        for (const field of ['name', 'direction', 'pin_category', 'pin_subcategory']) {
          if (typeof pin[field] !== 'string') fail(`pin ${pinKey} ${field} must be a string`);
        }
        if (!PIN_DIRECTIONS.has(pin.direction)) {
          fail(`pin ${pinKey} direction must be EGPD_Input, EGPD_Output, or EGPD_Unknown`);
        }
        const pinType = requireRecord(`pin ${pinKey} pin_type`, pin.pin_type);
        for (const field of ['category', 'subcategory', 'container']) {
          if (typeof pinType[field] !== 'string') fail(`pin ${pinKey} pin_type.${field} must be a string`);
        }
        if (!PIN_CONTAINERS.has(pinType.container)) {
          fail(`pin ${pinKey} pin_type.container is not recognized`);
        }
        if (typeof pin.is_subpin !== 'boolean') fail(`pin ${pinKey} is_subpin must be boolean`);
        if (typeof pin.orphaned !== 'boolean') fail(`pin ${pinKey} orphaned must be boolean`);
        requireGuid(`pin ${pinKey} parent_pin_id`, pin.parent_pin_id, { nullable: true });
        if (pin.is_subpin !== (pin.parent_pin_id !== null)) {
          fail(`pin ${pinKey} is_subpin does not match parent_pin_id`);
        }
        if (!Array.isArray(pin.subpin_ids)) fail(`pin ${pinKey} subpin_ids must be an array`);
        for (const subpinId of pin.subpin_ids) requireGuid(`pin ${pinKey} subpin_id`, subpinId);
        if (!Array.isArray(pin.linked_to)) fail(`pin ${pinKey} linked_to must be an array`);
        requireCount(`pin ${pinKey} link_count`, pin.link_count);
        if (pin.link_count !== pin.linked_to.length) fail(`pin ${pinKey} link_count does not match linked_to`);
        const hasDefaults = Object.prototype.hasOwnProperty.call(pin, 'defaults');
        if (hasDefaults !== topology.includes_pin_defaults) {
          fail(`pin ${pinKey} defaults do not match includes_pin_defaults=${topology.includes_pin_defaults}`);
        }
        if (hasDefaults) {
          const defaults = requireRecord(`pin ${pinKey} defaults`, pin.defaults);
          for (const field of ['default_value', 'autogenerated_default_value', 'default_text_value']) {
            if (typeof defaults[field] !== 'string') {
              fail(`pin ${pinKey} defaults.${field} must be a string`);
            }
          }
          if (defaults.default_object !== null && typeof defaults.default_object !== 'string') {
            fail(`pin ${pinKey} defaults.default_object must be a string or null`);
          }
        }

        const sourceEndpoint = endpointKey(graphKey, node.node_guid, pin.pin_id);
        endpointKeys.add(sourceEndpoint);
        serializedLinkEntryCount += pin.linked_to.length;
        pinEntries.push({ graphKey, node, pins, pin, sourceEndpoint });
      }
    }
  }

  const edges = new Set();
  for (const { graphKey, node, pins, pin, sourceEndpoint } of pinEntries) {
    if (pin.parent_pin_id !== null) {
      const parent = pins[pin.parent_pin_id];
      if (!parent) fail(`pin ${pin.pin_id} parent_pin_id does not resolve in node ${node.node_guid}`);
      if (!parent.subpin_ids.includes(pin.pin_id)) {
        fail(`pin ${pin.pin_id} parent ${pin.parent_pin_id} does not reference the child`);
      }
    }
    for (const subpinId of pin.subpin_ids) {
      const child = pins[subpinId];
      if (!child) fail(`pin ${pin.pin_id} subpin ${subpinId} does not resolve in node ${node.node_guid}`);
      if (child.parent_pin_id !== pin.pin_id) fail(`pin ${pin.pin_id} subpin ${subpinId} parent mismatch`);
    }
    for (const endpointValue of pin.linked_to) {
      const endpoint = requireRecord(`pin ${pin.pin_id} linked_to endpoint`, endpointValue);
      if (typeof endpoint.graph_key !== 'string' || endpoint.graph_key.length === 0) {
        fail(`pin ${pin.pin_id} linked_to endpoint graph_key must be non-empty`);
      }
      requireGuid(`pin ${pin.pin_id} linked_to node_guid`, endpoint.node_guid);
      requireGuid(`pin ${pin.pin_id} linked_to pin_id`, endpoint.pin_id);
      const targetEndpoint = endpointKey(endpoint.graph_key, endpoint.node_guid, endpoint.pin_id);
      if (!endpointKeys.has(targetEndpoint)) fail(`linked_to endpoint does not resolve: ${targetEndpoint}`);
      edges.add(canonicalEdgeKey(sourceEndpoint, targetEndpoint));
    }
    if (node.graph_key !== graphKey) fail(`node ${node.node_guid} graph_key changed during validation`);
  }

  if (topology.node_count !== serializedNodeCount || topology.pin_count !== serializedPinCount) {
    fail('aggregate node_count or pin_count does not match serialized maps');
  }
  if (topology.link_entry_count !== serializedLinkEntryCount) {
    fail('link_entry_count does not match serialized linked_to entries');
  }
  if (topology.edge_count !== edges.size) fail('edge_count does not match canonical serialized edges');

  const hasLoss = ANIM_GRAPH_TOPOLOGY_LOSS_FIELDS.some((field) => dropped[field] > 0);
  if (topology.complete === hasLoss) {
    fail(`complete=${topology.complete} does not match serialization loss counters`);
  }
  if (requireComplete && !topology.complete) {
    fail(`complete=true is required; dropped=${JSON.stringify(dropped)}`);
  }

  return {
    schema_version: topology.schema_version,
    id_format: topology.id_format,
    graph_count: graphEntries.length,
    node_count: serializedNodeCount,
    pin_count: serializedPinCount,
    link_entry_count: serializedLinkEntryCount,
    edge_count: edges.size,
    complete: topology.complete,
    truncated: topology.truncated,
    includes_pin_defaults: topology.includes_pin_defaults,
    dropped: { ...dropped },
    bytes: Buffer.byteLength(JSON.stringify(topology), 'utf8'),
  };
}
