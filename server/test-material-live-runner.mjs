import assert from 'node:assert/strict';
import { materialLiveEditorArgs, readMcpJson, verifyLiveIdentity, materialMcpEnvelope } from './run-material-live.mjs';
import { TestRunner } from './test-helpers.mjs';
const t = new TestRunner('Material live runner contract');
const args = materialLiveEditorArgs({ project: 'D:/Owned/UEMCPFixture.uproject', runtime: { args: ['-UserDir=D:/Owned/User'] }, port: 43210, tcpPort: 43211, log: 'D:/Owned/live.log' });
t.assert(args.includes('-UEMCPTcpPort=43211') && args.includes('-UEMCPMaterialLive'), 'owned editor uses a dedicated TCP listener for the ownership handshake');
t.assert(args.some(arg => arg.includes('DefaultBindAddress=127.0.0.1')), 'owned HTTP listener binds loopback');
t.assert(args.some(arg => arg.includes('RemoteControlHttpServerPort=43210') && arg.includes('bAllowAnyRemoteFunctionCall=False')), 'dedicated RC port keeps unrestricted execution disabled');
t.assert(args.includes('-RenderOffscreen') && !args.includes('-nullrhi'), 'HTTP editor renders offscreen because NullRHI disables Remote Control');
t.assert(args.includes('-UserDir=D:/Owned/User'), 'owned runtime paths reach editor launch');
for (const [label, response] of [ ['MCP error', { isError: true, content: [{ type: 'text', text: 'write rejected' }] }], ['malformed JSON', { content: [{ type: 'text', text: '{' }] }], ['missing result', {}] ]) {
  try { assert.throws(() => readMcpJson(response)); t.assert(true, `${label} cannot certify a successful tool call`); }
  catch (error) { t.assert(false, label, error.stack); }
}
t.assert(readMcpJson({ content: [{ type: 'text', text: '{"verified":true}' }] }).verified === true, 'real MCP text results decode');
for (const [label, identity] of [['wrong PID', { pid: 43, project: 'D:/Owned/UEMCPFixture.uproject' }], ['wrong project', { pid: 42, project: 'D:/Other/Other.uproject' }]]) {
  try { assert.throws(() => verifyLiveIdentity(identity, 'D:/Owned/UEMCPFixture.uproject', 42)); t.assert(true, `${label} cannot authorize live mutations`); }
  catch (error) { t.assert(false, label, error.stack); }
}
for (const settings of [{ allowAny: true, pythonEnabled: false }, { allowAny: false, pythonEnabled: true }]) {
  try { assert.throws(() => verifyLiveIdentity({ pid: 42, project: 'D:/Owned/UEMCPFixture.uproject', ...settings }, 'D:/Owned/UEMCPFixture.uproject', 42), /permissions/); t.assert(true, 'unrestricted execution settings cannot authorize the run'); }
  catch (error) { t.assert(false, 'permission assertion', error.stack); }
}
for (const dispatcher of ['call_tool', 'call_mutating_tool']) {
  const request = materialMcpEnvelope('set_material_parameter', { value: .7 }, { ok: true, tool: 'set_material_parameter', dispatcher });
  t.assert(request.name === dispatcher && request.arguments.tool === 'set_material_parameter' && request.arguments.arguments.value === .7, 'MCP request uses the server-described dispatcher and original arguments');
}
for (const descriptor of [{ ok: true, tool: 'wrong', dispatcher: 'call_tool' }, { ok: true, tool: 'set_material_parameter', dispatcher: 'unexpected' }]) {
  try { assert.throws(() => materialMcpEnvelope('set_material_parameter', {}, descriptor)); t.assert(true, 'invalid MCP description cannot redirect the request'); }
  catch (error) { t.assert(false, 'MCP description assertion', error.stack); }
}
process.exit(t.summary());
