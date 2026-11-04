import { runProjectIsolation } from './run-project-isolation.mjs';
import { TestRunner } from './test-helpers.mjs';
const outputRoot = process.env.UEMCP_ISOLATION_ROOT;
const engineRoot = process.env.UEMCP_ISOLATION_ENGINE;
if (!outputRoot || !engineRoot) {
  console.log('⊘ skipped: explicit UEMCP_ISOLATION_ROOT and UEMCP_ISOLATION_ENGINE required');
  process.exit(0);
}
const t = new TestRunner('Project transport isolation engine');
try {
  const records = await runProjectIsolation({ outputRoot, engineRoot });
  t.assert(records.length === 4, 'two normal clients isolate editor writes crosswires and restart persistence');
} catch (error) { t.assert(false, 'two normal clients isolate editor writes crosswires and restart persistence', error.stack); }
process.exit(t.summary());
