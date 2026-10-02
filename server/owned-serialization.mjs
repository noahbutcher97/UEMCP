import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBuffer } from './uasset-parser.mjs';
import { extractBPEdgeTopologySafe } from './offline-blueprint-tools.mjs';

export const fixtureVersions = ['ue5.6-owned-v1'];
export const authoringVersions = ['ue5.3-owned-v1', ...fixtureVersions];
export const assetPath = '/Game/Serialization/BP_OwnedLink';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function packageIdentity(bytes) {
  const s = parseBuffer(bytes).summary;
  return Object.fromEntries(['legacyFileVersion', 'fileVersionUE4', 'fileVersionUE5',
    'fileVersionLicenseeUE', 'packageFlags', 'customVersions'].map(k => [k, s[k]]));
}

// Loaded UE pins may be reconstructed. Match each pin by unique (name,direction)
// within the exact node GUID; never fall back on a node name or approximate edge.
export function semanticTopology(graphs) {
  const result = {};
  for (const [graphName, graph] of Object.entries(graphs).sort()) {
    const nodes = graph.nodes;
    const key = (node, pinId) => {
      const pin = nodes[node]?.pins[pinId];
      assert.ok(pin, `dangling oracle/parser link ${node}/${pinId}`);
      return `${pin.direction}:${pin.name}`;
    };
    result[graphName] = {};
    for (const [id, node] of Object.entries(nodes).sort()) {
      const pins = {};
      for (const [pinId, pin] of Object.entries(node.pins)) {
        const pinKey = key(id, pinId);
        assert.ok(!(pinKey in pins), `ambiguous pin name ${id}/${pinKey}`);
        pins[pinKey] = pin.linked_to.map(link => `${link.node_guid}/${key(link.node_guid, link.pin_id)}`).sort();
      }
      result[graphName][id] = { class_name: node.class_name, pins: Object.fromEntries(Object.entries(pins).sort()) };
    }
  }
  return result;
}

export async function verifyOwnedFixture(directory, expectedVersion) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, expectedVersion);
  assert.equal(manifest.ownership, 'Original UEMCP test graph authored from repository source; no copied content');
  assert.equal(manifest.oracleSemantics, 'independent UE reload; exact node GUID and unique pin name/direction topology');
  assert.ok(manifest.engineBuild.Changelist > 0);
  assert.ok(authoringVersions.includes(expectedVersion), 'Unknown fixture version');
  assert.equal(manifest.engineBuild.MajorVersion, 5);
  assert.equal(manifest.engineBuild.MinorVersion, expectedVersion === 'ue5.3-owned-v1' ? 3 : 6);
  assert.equal(manifest.rights, 'Original repository test content; no additional license grant is asserted by this manifest');
  assert.match(manifest.provenance.invocationId, /^[a-f0-9-]{36}$/);
  assert.match(manifest.provenance.sourceHead, /^[a-f0-9]{40}$/);
  assert.equal(typeof manifest.provenance.sourceDirty, 'boolean');
  for (const key of ['hostManifestSha256', 'sourcePatchSha256', 'engineBuildSha256', 'allowlistSha256']) {
    assert.match(manifest.provenance[key], /^[a-f0-9]{64}$/);
  }
  assert.ok(Object.keys(manifest.sourceHashes).length >= 3);
  for (const digest of Object.values(manifest.sourceHashes)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(manifest.files).sort(), ['Content/Serialization/BP_OwnedLink.uasset', 'oracle.json']);
  for (const [path, info] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(directory, path));
    assert.ok(bytes.length > 0 && bytes.length < 1024 * 1024, `fixture size ${path}`);
    assert.equal(bytes.length, info.size, `size mismatch ${path}`);
    assert.equal(sha256(bytes), info.sha256, `hash mismatch ${path}`);
  }
  const saved = packageIdentity(readFileSync(join(directory, 'Content/Serialization/BP_OwnedLink.uasset')));
  assert.deepEqual(saved, manifest.savedPackage);
  assert.equal(saved.fileVersionUE5 < 1012, expectedVersion === 'ue5.3-owned-v1', 'real saved package property-layout boundary');
  const oracle = JSON.parse(readFileSync(join(directory, 'oracle.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(oracle.schema_version, 'oracle-a-v2');
  assert.equal(oracle.asset_path, assetPath);
  assert.equal(oracle.engine_version, manifest.oracleEngineVersion);
  const expected = semanticTopology(oracle.graphs);
  const nodes = expected.OwnedGraph;
  assert.deepEqual(Object.keys(nodes).sort(), ['00000001ABCDEF1280000000FFFFFFFF', '12345678000000020000000300000004']);
  assert.equal(nodes['00000001ABCDEF1280000000FFFFFFFF'].class_name, 'K2Node_CustomEvent');
  assert.equal(nodes['12345678000000020000000300000004'].class_name, 'K2Node_CallFunction');
  assert.deepEqual(nodes['00000001ABCDEF1280000000FFFFFFFF'].pins['EGPD_Output:then'], ['12345678000000020000000300000004/EGPD_Input:execute']);
  const parsed = await extractBPEdgeTopologySafe(directory, { asset_path: assetPath });
  assert.equal(parsed.stats.malformedNodes, 0);
  assert.equal(parsed.stats.danglingEdges, 0);
  assert.deepEqual(semanticTopology(parsed.graphs), expected, 'offline topology differs from independent UE oracle');
  return { id: manifest.id, savedPackage: saved, stats: parsed.stats };
}
