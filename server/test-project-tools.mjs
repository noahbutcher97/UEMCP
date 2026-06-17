// Project management tool contract tests.
//
// Run: cd server && node test-project-tools.mjs

import { TestRunner } from './test-helpers.mjs';
import {
  ATTACH_PROJECT_INPUT_SHAPE,
  CONNECTION_INFO_INPUT_SHAPE,
  FIND_TOOLS_INPUT_SHAPE,
  LIST_PROJECT_TARGETS_INPUT_SHAPE,
  PROJECT_CONTEXT_OUTPUT_SHAPE,
  PROJECT_ERROR_OUTPUT_SHAPE,
  TOOLSET_RESULT_OUTPUT_SHAPE,
  PROJECT_MANAGEMENT_TOOL_NAMES,
} from './project-tools.mjs';

const t = new TestRunner('Project Management Tool Contracts');

t.assert('project_root' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes project_root');
t.assert('uproject_path' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes uproject_path');
t.assert('target' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes target');
t.assert('target_profile' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes target_profile');
t.assert('from_running_editor' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes from_running_editor');
t.assert('allow_outside_client_roots' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes allow_outside_client_roots');
t.assert('prompt' in ATTACH_PROJECT_INPUT_SHAPE, 'attach_project shape includes prompt');

t.assert('force_reconnect' in CONNECTION_INFO_INPUT_SHAPE, 'connection_info shape includes force_reconnect');
t.assert('query' in FIND_TOOLS_INPUT_SHAPE, 'find_tools shape includes query');
t.assert('max_results' in FIND_TOOLS_INPUT_SHAPE, 'find_tools shape includes max_results');
t.assert('profile' in LIST_PROJECT_TARGETS_INPUT_SHAPE, 'list_project_targets shape includes profile');

t.assert('projectContext' in PROJECT_CONTEXT_OUTPUT_SHAPE, 'project context output exposes projectContext');
t.assert('code' in PROJECT_ERROR_OUTPUT_SHAPE, 'project error output exposes code');
t.assert('toolsets' in TOOLSET_RESULT_OUTPUT_SHAPE, 'toolset result output exposes toolsets');

for (const name of ['list_project_targets', 'attach_project', 'detach_project', 'refresh_project_context']) {
  t.assert(PROJECT_MANAGEMENT_TOOL_NAMES.includes(name), `management names include ${name}`);
}

process.exit(t.summary());
