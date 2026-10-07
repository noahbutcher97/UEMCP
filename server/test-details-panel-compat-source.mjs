// Source-only regression controls. This does not compile or run Unreal C++.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRunner, REPO_ROOT } from './test-helpers.mjs';

const t = new TestRunner('details panel engine compatibility source');
const plugin = join(REPO_ROOT, 'plugin/UEMCP/Source/UEMCP');
const source = readFileSync(join(plugin, 'Private/AssetEditorCaptureHandler.cpp'), 'utf8').replaceAll('\r\n', '\n');
const compat = readFileSync(join(plugin, 'Public/UEMCPCompat.h'), 'utf8').replaceAll('\r\n', '\n');
const gate = 'UEMCP_UE_5_4_OR_LATER';
const names = ['HandleDetailsPanelExpandAll', 'HandleDetailsPanelScroll'];
const bodies = text => names.map((name, i) => {
  const start = text.indexOf(`void ${name}(`);
  const end = text.indexOf(`void ${i === 0 ? names[1] : 'HandleCapturePieViewport'}(`, start);
  if (start < 0 || end < start) throw new Error(`Missing handler boundary: ${name}`);
  return text.slice(start, end);
});

// Interpret only the two reviewed compatibility branches, not arbitrary C++.
// Refuse unexpected directives so these checks cannot silently model a new gate.
function selectBranch(text, modern) {
  let active = true;
  let branch = null;
  const output = [];
  for (const line of text.split('\n')) {
    if (line === `#if ${gate}`) {
      if (branch !== null) throw new Error('Nested compatibility gate');
      branch = 'if'; active = modern;
    } else if (line === '#else') {
      if (branch !== 'if') throw new Error('Unexpected else');
      branch = 'else'; active = !modern;
    } else if (line === '#endif') {
      if (branch !== 'else') throw new Error('Missing legacy alternative');
      branch = null; active = true;
    } else {
      if (/^\s*#\s*(if|elif|else|endif)\b/.test(line)) throw new Error('Unreviewed preprocessor condition');
      if (active) output.push(line);
    }
  }
  if (branch !== null) throw new Error('Unclosed compatibility gate');
  return output.join('\n');
}
function legacySafe(text) {
  try {
    return bodies(selectBranch(text, false)).every(body =>
      body.includes('TEXT("CAPTURE_UNSUPPORTED")') && body.includes('BuildErrorResponse(OutResponse,')
      && !body.includes('View->') && !body.includes('BuildSuccessResponse('));
  } catch { return false; }
}

t.assert(source.includes('#include "UEMCPCompat.h"'), 'handler imports the centralized compatibility policy');
t.assert(!/UE_VERSION_OLDER_THAN|#if\s+ENGINE_/.test(source), 'handler introduces no raw engine-version policy');
const boundary = compat.match(/#define UEMCP_UE_5_4_OR_LATER \(!UE_VERSION_OLDER_THAN\((\d+), (\d+), (\d+)\)\)/);
t.assert(boundary?.slice(1).join('.') === '5.4.0', 'central gate excludes verified UE5.3 without changing later branches');
t.assert(compat.includes('untested 5.4/5.5 engines'), 'gate does not claim the uninspected API introduction version');
t.assert((source.match(/#if UEMCP_UE_5_4_OR_LATER/g) ?? []).length === 2, 'exactly two details operations have compatibility gates');
for (const [version, modern] of [['5.3', false], ['5.6', true], ['5.7', true], ['5.8', true]]) {
  const [major, minor] = version.split('.').map(Number);
  const selected = boundary && (major > Number(boundary[1]) || (major === Number(boundary[1]) && minor >= Number(boundary[2])));
  t.assert(selected === modern, `source gate selects the intended ${version} branch`);
  const view = selectBranch(source, selected);
  t.assert((view.match(/View->ScrollPropertyIntoView\(/g) ?? []).length === (modern ? 2 : 0), `${version} source selection contains ${modern ? 'both original' : 'no unavailable'} scroll calls`);
}
t.assert(legacySafe(source), 'legacy handlers refuse without view mutation or a success envelope');
for (const [index, body] of bodies(source).entries()) {
  const label = names[index];
  const gateAt = body.indexOf(`#if ${gate}`);
  t.assert(body.indexOf('ReadDetailsParams(') >= 0 && body.indexOf('ReadDetailsParams(') < gateAt && body.indexOf('ResolveDetailsView(') >= 0 && body.indexOf('ResolveDetailsView(') < gateAt, `${label} preserves parameter and target validation before capability refusal`);
  t.assert(body.indexOf('BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode)') >= 0 && body.indexOf('BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode)') < gateAt, `${label} preserves the original target error code`);
  const old = selectBranch(body, false);
  t.assert(!/View->|BuildSuccessResponse|SetBoolField\(TEXT\("(?:expanded|scrolled)"\)/.test(old), `${label} legacy branch cannot mutate the view or report work done`);
  const mutation = body.replace(`#if ${gate}`, '').replace('#else', '').replace('#endif', '');
  t.assert(!legacySafe(source.replace(body, mutation)), `${label} control rejects a removed compile guard`);
  t.assert(!legacySafe(source.replace(body, body.replace('TEXT("CAPTURE_UNSUPPORTED")', 'TEXT("SUCCESS")'))), `${label} control rejects a missing typed refusal`);
  t.assert(!legacySafe(source.replace(body, body.replace(`#if ${gate}`, `View->ForceRefresh();\n#if ${gate}`))), `${label} control rejects mutation before the compile guard`);
  t.assert(!legacySafe(source.replace(body, body.replace('#else', '#else\nBuildSuccessResponse(OutResponse, Result);'))), `${label} control rejects legacy false success`);
}
const [expand, scroll] = bodies(selectBranch(source, true));
t.assert(expand.includes('View->ShowAllAdvancedProperties()') && expand.includes('View->ForceRefresh()') && expand.includes('View->ScrollPropertyIntoView(Path, /*bExpandProperty*/ true)'), 'modern expand-all retains advanced visibility, refresh and target expansion');
t.assert(scroll.includes('FPropertyPath LandedPath;') && scroll.includes('LandedPath = Row.Value;') && scroll.includes('View->ScrollPropertyIntoView(LandedPath, /*bExpandProperty*/ false)'), 'modern scroll retains copied row path and non-expanding call');
t.assert(scroll.includes('FMath::Clamp(RowOffset, 0, MaxRowOffset)') && scroll.includes('Result->SetBoolField(TEXT("scrolled"), bFoundRow)'), 'modern scroll retains clamping and the actual row-found result');
t.assert(bodies(source)[1].indexOf('RowOffset < 0') < bodies(source)[1].indexOf(`#if ${gate}`), 'negative row offset remains a parameter error on both branches');
t.assert(!/View->(?:HighlightProperty|SetRootExpansionStates)/.test(source), 'neither branch uses highlighting or a private expansion API as a substitute');
process.exit(t.summary() === 0 ? 0 : 1);
