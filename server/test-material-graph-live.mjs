import { runMaterialGraphLive } from './run-material-graph-live.mjs';
import { TestRunner } from './test-helpers.mjs';
const outputRoot = process.env.UEMCP_MATERIAL_GRAPH_ROOT;
const engineRoot = process.env.UEMCP_MATERIAL_GRAPH_ENGINE;
if (!outputRoot || !engineRoot) {
  console.log('⊘ skipped: explicit UEMCP_MATERIAL_GRAPH_ROOT and UEMCP_MATERIAL_GRAPH_ENGINE required');
} else {
  const t = new TestRunner('Material graph owned live');
  const name = 'owned material function graph authoring Undo Redo compile rejection and restart persistence';
  try { await runMaterialGraphLive({ outputRoot, engineRoot }); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.stack); }
  process.exit(t.summary());
}
