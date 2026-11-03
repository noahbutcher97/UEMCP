import { runMaterialLive } from './run-material-live.mjs';
import { TestRunner } from './test-helpers.mjs';
const outputRoot = process.env.UEMCP_MATERIAL_LIVE_ROOT;
const engineRoot = process.env.UEMCP_MATERIAL_LIVE_ENGINE;
if (!outputRoot || !engineRoot) {
  console.log('⊘ skipped: explicit UEMCP_MATERIAL_LIVE_ROOT and UEMCP_MATERIAL_LIVE_ENGINE required');
  process.exit(0);
}
const t = new TestRunner('Material MCP HTTP engine');
try {
  const records = await runMaterialLive({ outputRoot, engineRoot });
  t.assert(records.length === 2 && records.every(row => row.cases.length === 9), 'owned MCP HTTP material writes Undo Redo and restart persistence');
} catch (error) { t.assert(false, 'owned MCP HTTP material writes Undo Redo and restart persistence', error.stack); }
process.exit(t.summary());
