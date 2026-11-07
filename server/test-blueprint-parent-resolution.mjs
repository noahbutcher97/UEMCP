// Offline regression: actual Node argument pass-through plus a narrow C++
// source boundary guard. This does not execute or simulate UClass resolution.
// UEMCP.BlueprintHandlers.CreateBlueprintParents asserts native parent identity.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeBlueprintsWriteTool } from './blueprints-write-tcp-tools.mjs';
import { REPO_ROOT, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Blueprint Parent Resolution');
const calls = [];
const reply = { status: 'error', code: 'INVALID_PARENT_CLASS', error: 'refused' };
const connection = {
  async send(...args) {
    calls.push(args);
    return reply;
  },
};

for (const parent of [
  'FixtureGameMode', '/Script/FixtureProject.FixtureGameMode',
  'Actor', 'Pawn', 'Character', 'AActor', 'APawn', 'ACharacter',
  '/Script/Engine.Character', 'UEMCPTestParentActor',
  '/Script/UEMCP.UEMCPTestParentActor', 'MissingParent',
  '/Script/CoreUObject.Object', '/Game/Parents/BP_Parent.BP_Parent_C',
]) {
  const result = await executeBlueprintsWriteTool('create_blueprint', {
    name: 'BP_ParentResolutionProbe', parent_class: parent,
  }, connection);
  const [layer, command, params, options] = calls.at(-1);
  t.assert(layer === 'tcp-55558' && command === 'create_blueprint', `${parent}: correct route`);
  t.assert(params.parent_class === parent, `${parent}: identifier reaches native boundary unchanged`);
  t.assert(options.skipCache === true, `${parent}: creation bypasses read cache`);
  t.assert(result === reply, `${parent}: native refusal is preserved, not defaulted to Actor`);
}
await executeBlueprintsWriteTool('create_blueprint', { name: 'BP_DefaultParent' }, connection);
t.assert(!Object.hasOwn(calls.at(-1)[2], 'parent_class'), 'omitted parent retains native default semantics');

const source = readFileSync(join(REPO_ROOT, 'plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp'), 'utf8');
const body = source.slice(source.indexOf('void HandleCreateBlueprint('), source.indexOf('void HandleAddComponentToBlueprint('));
// Guard the actual source of the reported defect: destructive prefixing before
// lookup. Native automation, not these source assertions, proves class semantics.
t.assert(!/\bClassName\s*=\s*TEXT\("A"\)\s*\+\s*ClassName/.test(body),
  'parent resolution does not replace the supplied identifier with an A-prefixed spelling');
t.assert(/Candidates\.Add\(ParentName\)/.test(body), 'original identifier is an explicit resolution candidate');
t.assert(body.indexOf('Candidates.Add(ParentName)') < body.indexOf('Candidates.Add(ParentName.Mid(1))')
  && body.includes('ParentName.Mid(1)'), 'original candidate precedes optional legacy alias');
t.assert(body.includes('ParentName.StartsWith(TEXT("/Script/"))'), 'native object paths are distinguished from unsupported content paths');
t.assert(body.includes('UEMCP::ResolveClass(Candidate, AActor::StaticClass())'), 'all candidates retain the Actor base constraint');
t.assert(body.includes('TEXT("INVALID_PARENT_CLASS")'), 'unresolved and wrong-base parents remain explicit refusals');
t.assert(!body.includes('/Script/Game.'), 'reported attempts do not invent the game module name');

process.exit(t.summary());
