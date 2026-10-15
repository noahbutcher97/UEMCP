import { runMaterialLifecycle } from './run-material-lifecycle.mjs';
import { TestRunner } from './test-helpers.mjs';

const outputRoot = process.env.UEMCP_MATERIAL_LIFECYCLE_ROOT;
const engineRoot = process.env.UEMCP_MATERIAL_LIFECYCLE_ENGINE;
if (!outputRoot || !engineRoot) {
  console.log('⊘ skipped: explicit UEMCP_MATERIAL_LIFECYCLE_ROOT and UEMCP_MATERIAL_LIFECYCLE_ENGINE required');
  process.exit(0);
}
const t = new TestRunner('Owned material lifecycle engine');
try {
  const records = await runMaterialLifecycle({ outputRoot, engineRoot });
  t.assert(records.length === 2, 'owned host writes Undo saves and reloads all nine material parameters');
} catch (error) {
  t.assert(false, 'owned host writes Undo saves and reloads all nine material parameters', error.stack);
}
t.summary();
process.exitCode = t.failed ? 1 : 0;
