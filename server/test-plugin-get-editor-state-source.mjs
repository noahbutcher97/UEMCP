// Static source checks for plugin get_editor_state project identity payload.
//
// Run: cd server && node test-plugin-get-editor-state-source.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Plugin GetEditorState Source Checks');
const source = readFileSync(join('..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'EdgeCaseHandlers.cpp'), 'utf8');

for (const include of [
  '#include "Interfaces/IPluginManager.h"',
  '#include "Misc/App.h"',
  '#include "Misc/FileHelper.h"',
  '#include "Misc/Paths.h"',
  '#include "Serialization/JsonReader.h"',
  '#include "Serialization/JsonSerializer.h"',
]) {
  t.assert(source.includes(include), `EdgeCaseHandlers.cpp includes ${include}`);
}

for (const field of [
  'project_root',
  'uproject_path',
  'project_name',
  'plugin_version',
  'plugin_version_name',
  'deploy_marker_present',
  'deploy_marker_schema_version',
  'deploy_marker_manifest_version',
  'deploy_marker_uplugin_version',
]) {
  t.assert(source.includes(`TEXT("${field}")`), `get_editor_state emits ${field}`);
}

for (const api of [
  'FPaths::GetProjectFilePath()',
  'FPaths::ProjectDir()',
  'FApp::GetProjectName()',
  'IPluginManager::Get().FindPlugin(TEXT("UEMCP"))',
  'FFileHelper::LoadFileToString',
  'FJsonSerializer::Deserialize',
]) {
  t.assert(source.includes(api), `get_editor_state uses ${api}`);
}

process.exit(t.summary());
