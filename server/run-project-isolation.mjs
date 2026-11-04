// Two canonical host copies, normal project config, independent stdio clients.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runMaterialLifecycle } from './run-material-lifecycle.mjs';
import { configureProjectPorts } from './configure-project-ports.mjs';
import { openOwnedEditorSession } from './owned-editor-session.mjs';
import { MATERIAL_INSTANCE, hostControl } from './material-live-flow.mjs';
import { RC_SECTION } from './project-transport.mjs';

const rounded = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'number' ? Math.round(item * 1e6) / 1e6 : item));
const list = async session => rounded(await session.call('list_material_parameters', { asset_path: MATERIAL_INSTANCE }));
const set = (session, value) => session.call('set_material_parameter', { asset_path: MATERIAL_INSTANCE,
  parameter_name: 'globalscalar', parameter_type: 'scalar', value });
const scalar = snapshot => snapshot.scalar.find(row => row.Name === 'GlobalScalar');
const closeAll = async sessions => {
  const results = await Promise.allSettled(sessions.map(session => session.close()));
  const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
  if (errors.length) throw new AggregateError(errors, 'Owned session cleanup failed');
};
export async function runProjectIsolation({ repoRoot = resolve(import.meta.dirname, '..'), outputRoot, engineRoot }) {
  if (!outputRoot || !engineRoot) throw new Error('Explicit fresh stage and engine required');
  mkdirSync(outputRoot); // A repeat invocation must never reuse a previous result.
  const targetsPath = join(outputRoot, '.uemcp-targets.json');
  const stages = ['A', 'B'].map(label => ({ label, outputRoot: join(outputRoot, label) }));
  const records = [];
  let sessions = [];
  const evidence = join(outputRoot, 'project-isolation-evidence.json');
  const hashes = stage => ['M_Parameters', 'MI_Parameters'].map(name => createHash('sha256').update(
    readFileSync(join(stage.outputRoot, `host/Content/MaterialVerification/${name}.uasset`))).digest('hex'));
  try {
    for (const stage of stages) {
      await runMaterialLifecycle({ repoRoot, outputRoot: stage.outputRoot, engineRoot });
      stage.project = join(stage.outputRoot, 'host/UEMCPFixture.uproject');
      stage.ports = (await configureProjectPorts({ uprojectPath: stage.project, targetsPath })).ports;
    }
    assert.equal(new Set(stages.flatMap(stage => Object.values(stage.ports))).size, 4);
    for (const phase of ['write', 'reload']) {
      for (const stage of stages) sessions.push(await openOwnedEditorSession({ repoRoot, engineRoot, ...stage,
        label: `${stage.label}-${phase}`, peers: sessions }));
      assert.notEqual(sessions[0].pid, sessions[1].pid);
      const before = await Promise.all(sessions.map(list));
      assert(before.every(snapshot => ['scalar', 'vector', 'texture'].reduce((sum, type) => sum + snapshot[type].length, 0) === 12));
      const expected = structuredClone(before);
      if (phase === 'write') {
        const results = await Promise.all(sessions.map((session, i) => set(session, [.41, .82][i])));
        assert(results.every(result => result.verified === true));
        expected.forEach((snapshot, i) => { scalar(snapshot).Value = [.41, .82][i]; });
        assert.deepEqual(await Promise.all(sessions.map(list)), expected);
        const victim = sessions[1], stage = stages[1];
        for (const transport of ['http', 'tcp']) {
          const path = join(stage.outputRoot, 'host/Config', transport === 'tcp' ? 'DefaultUEMCP.ini' : 'DefaultRemoteControl.ini');
          const original = readFileSync(path);
          try {
            writeFileSync(path, transport === 'tcp' ? `[UEMCP]\nTcpPort=${stages[0].ports.tcpPortCustom}\n`
              : `[${RC_SECTION}]\nRemoteControlHttpServerPort=${stages[0].ports.rcPort}\n`);
            await victim.call('attach_project', { uproject_path: victim.project });
            await victim.call('connection_info', { force_reconnect: true });
            await assert.rejects(() => set(victim, .99), /mismatch|ownership|verified|belongs|different project/i);
            // The independent client remains valid while the other is deliberately misconfigured.
            assert.deepEqual(await list(sessions[0]), expected[0]);
          } finally {
            writeFileSync(path, original);
            await victim.call('attach_project', { uproject_path: victim.project });
            await victim.activate();
          }
          assert.deepEqual(await Promise.all(sessions.map(list)), expected);
          records.push({ phase, crosswire: transport, rejected: true, otherProjectUnchanged: true });
        }
        await Promise.all(sessions.map(session => hostControl(session.call, 'save')));
        stages.forEach(stage => { stage.savedHashes = hashes(stage); });
      } else {
        before.forEach((snapshot, i) => assert(Math.abs(scalar(snapshot).Value - [.41, .82][i]) < 1e-6));
        stages.forEach(stage => assert.deepEqual(hashes(stage), stage.savedHashes));
      }
      records.push({ phase, identities: sessions.map(session => session.identity), ports: stages.map(stage => stage.ports),
        snapshots: await Promise.all(sessions.map(list)), hashes: stages.map(hashes) });
      await closeAll(sessions); sessions = [];
    }
    writeFileSync(evidence, JSON.stringify({ passed: true, records }, null, 2));
    return records;
  } catch (error) {
    try { await closeAll(sessions); } catch (cleanup) { error = new AggregateError([error, cleanup], error.message); }
    writeFileSync(evidence, JSON.stringify({ passed: false, error: error.message, stack: error.stack, records }, null, 2));
    throw error;
  }
}
