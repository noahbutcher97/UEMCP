import assert from 'node:assert/strict';
import { normalEditorArgs } from './owned-editor-session.mjs';
import { TestRunner } from './test-helpers.mjs';
const t = new TestRunner('Normal owned editor launch');
const args = normalEditorArgs({ project: 'owned.uproject', runtime: { args: ['-UserDir=owned'] }, port: 43210, tcpPort: 43211, log: 'owned.log' });
try {
  assert(!args.some(arg => /UEMCPTcpPort|RemoteControlHttpServerPort/.test(arg)));
  assert(args.includes('-RenderOffscreen') && args.includes('-UEMCPMaterialLive'));
  assert(args.some(arg => arg.includes('bAllowAnyRemoteFunctionCall=False')));
  t.assert(true, 'normal owned launch reads both ports from project config');
} catch (error) { t.assert(false, 'normal owned launch reads both ports from project config', error.stack); }
process.exit(t.summary());
