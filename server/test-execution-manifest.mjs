import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
import { loadTestProfile, collectSourceState, collectFixtureIdentity, validateExecution, parseCaseEvidence, sha256, REPOSITORY_ROOT } from './execution-manifest.mjs';

const runner = new TestRunner('Execution manifest contract');
const root = createCanonicalScratchRoot('uemcp-execution-');
try {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init');
  writeFileSync(join(root, 'fixture.bin'), Buffer.from([13, 10, 0, 255]));
  git('add', 'fixture.bin');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const sourceState = collectSourceState(root);
  const profile = { name: 'control', manifestDigest: 'manifest', fixturePaths: ['fixture.bin'], suites: [{ name: 'suite', cases: ['outer', 'nested'] }] };
  const fixtureIdentity = collectFixtureIdentity(root, profile.fixturePaths);
  const evidence = { schemaVersion: 1, profile: profile.name, manifestDigest: profile.manifestDigest, sourceState, fixtureIdentity, suites: [{ name: 'suite', state: 'passed', cases: [{ name: 'outer', state: 'passed' }, { name: 'nested', state: 'passed' }] }] };
  runner.assert(validateExecution(evidence, profile, sourceState).length === 0, 'complete exact evidence passes');
  for (const [name, mutate] of [
    ['missing suite', value => { value.suites = []; }],
    ['duplicate suite', value => { value.suites.push(value.suites[0]); }],
    ['extra suite', value => { value.suites.push({ name: 'extra' }); }],
    ['zero cases', value => { value.suites[0].cases = []; }],
    ['nested missing while outer passes', value => { value.suites[0].cases.pop(); }],
    ['duplicate witness', value => { value.suites[0].cases[1] = value.suites[0].cases[0]; }],
    ['skipped witness', value => { value.suites[0].cases[1].state = 'skipped'; }],
    ['failed witness', value => { value.suites[0].cases[1].state = 'failed'; }],
    ['skipped suite', value => { value.suites[0].state = 'skipped'; }],
    ['wrong profile', value => { value.profile = 'other'; }],
    ['wrong manifest', value => { value.manifestDigest = 'other'; }],
    ['wrong source', value => { value.sourceState.head = 'other'; }],
    ['wrong fixture hash', value => { value.fixtureIdentity.files[0].sha256 = 'other'; }],
    ['self-consistent substituted fixture hash', value => {
      value.fixtureIdentity.files[0].sha256 = 'a'.repeat(64);
      value.fixtureIdentity.digest = sha256(JSON.stringify(value.fixtureIdentity.files));
    }],
  ]) {
    const value = structuredClone(evidence);
    mutate(value);
    runner.assert(validateExecution(value, profile, sourceState).length > 0, `rejects ${name}`);
  }
  for (const [label, files] of [['missing', []], ['duplicate', [...sourceState.files, ...sourceState.files]]]) {
    const value = structuredClone(evidence);
    value.sourceState.files = files;
    const { digest: unusedDigest, ...rawSource } = value.sourceState;
    value.sourceState.digest = sha256(JSON.stringify(rawSource));
    runner.assert(validateExecution(value, profile, value.sourceState).some(error => error.startsWith('Fixture does not match source identity:')), `rejects ${label} fixture in self-consistent source inventory`);
  }
  writeFileSync(join(root, 'fixture.bin'), Buffer.from([10, 0, 255]));
  const changed = collectSourceState(root);
  runner.assert(changed.dirty && changed.head === sourceState.head && changed.digest !== sourceState.digest && changed.patchSha256 !== sourceState.patchSha256, 'dirty raw bytes and patch bind source identity');
  runner.assert(validateExecution(evidence, profile, changed).includes('Wrong source state'), 'rejects evidence from different local source state');
  runner.assert(collectFixtureIdentity(root, profile.fixturePaths).digest !== fixtureIdentity.digest, 'binary CRLF change alters fixture identity');
  writeFileSync(join(root, 'new.txt'), 'new untracked source');
  runner.assert(collectSourceState(root).digest !== changed.digest, 'untracked source addition alters identity');
  runner.assert(parseCaseEvidence('noise\nUEMCP_CASE {"name":"case","state":"passed"}\n').length === 1, 'structured case evidence ignores chatter');
  runner.assert(loadTestProfile('node-foundation').suites.length === 2, 'foundation remains a bounded explicit profile');
  runner.assert(loadTestProfile('native-smoke').runner === 'native', 'native smoke profile is separately selected');
  const transportNames = ['ReceiveClassifier', 'ReceiveDeadlines', 'ReadOneRequestStopping', 'RequestReadResultMapping', 'FixtureSchema', 'SharedFixtures', 'DecoderBoundaries'].map(name => `UEMCP.Transport.${name}`);
  const transportResource = 'plugin/UEMCP/Resources/Tests/tcp-transport-cases.json';
  let transport;
  try { transport = loadTestProfile('native-transport'); } catch { /* Assert missing profile without suppressing remaining controls. */ }
  runner.assert(transport?.runner === 'native' && JSON.stringify(transport.suites) === JSON.stringify([{ name: 'native', cases: transportNames }]) && JSON.stringify(transport.fixturePaths) === JSON.stringify([transportResource]), 'native transport requires the exact seven cases and deployed transport resource');
  const transportSource = readFileSync(new URL('../plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp', import.meta.url), 'utf8');
  const registrations = [...transportSource.matchAll(/"(UEMCP\.Transport\.[A-Za-z]+)"/g)].map(match => match[1]);
  runner.assert(JSON.stringify(registrations) === JSON.stringify(transportNames), 'native transport expectations match existing C++ full-name registrations');
  if (transport) {
    const transportSourceState = collectSourceState(REPOSITORY_ROOT);
    const transportEvidence = {
      schemaVersion: 1, profile: transport.name, manifestDigest: transport.manifestDigest,
      sourceState: transportSourceState, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, transport.fixturePaths),
      suites: [{ name: 'native', state: 'passed', cases: transportNames.map(name => ({ name, state: 'passed' })) }],
    };
    runner.assert(validateExecution(transportEvidence, transport, transportSourceState).length === 0, 'transport evidence binds the complete raw resource and seven cases');
    // Mutate only an in-memory evidence copy; never modify repository resources.
    const tampered = structuredClone(transportEvidence);
    const resourceBytes = readFileSync(new URL(`../${transportResource}`, import.meta.url));
    tampered.fixtureIdentity.files[0].sha256 = sha256(Buffer.concat([resourceBytes, Buffer.from('\r\n')]));
    tampered.fixtureIdentity.digest = sha256(JSON.stringify(tampered.fixtureIdentity.files));
    runner.assert(validateExecution(tampered, transport, transportSourceState).some(error => error.startsWith('Fixture does not match source identity:')), 'transport rejects a self-consistent tampered resource against original source bytes');
    await runner.assertRejects(() => Promise.resolve(collectFixtureIdentity(root, transport.fixturePaths)), /ENOENT/, 'transport missing resource is a hard failure');
  }
  const blueprintNames = [
    'UEMCP.BlueprintHelpers.PinTypeToJson',
    'UEMCP.BlueprintHelpers.VariableDefaults',
    'UEMCP.BlueprintHelpers.LiteralDefaults',
    'UEMCP.BlueprintHandlers.AddVariableAssignment',
    'UEMCP.BlueprintHandlers.AddTimer',
    'UEMCP.BlueprintHandlers.DisconnectPin',
    'UEMCP.BlueprintHandlers.AssignmentVariableKind',
    'UEMCP.BlueprintHandlers.AssignmentExecFrom',
    'UEMCP.BlueprintHandlers.DisconnectPinEdges',
    'UEMCP.BlueprintHandlers.CompilePaths',
    'UEMCP.BlueprintHandlers.TimerFailures',
    'UEMCP.BlueprintHandlers.GhostBeginPlayEnabled',
    'UEMCP.BlueprintHandlers.EventNodeGhostSites',
    'UEMCP.BlueprintHandlers.AssignmentCompileFailed',
  ];
  let blueprint;
  try { blueprint = loadTestProfile('native-blueprint'); } catch { /* Keep the missing-profile regression explicit. */ }
  runner.assert(blueprint?.runner === 'native' && JSON.stringify(blueprint.suites) === JSON.stringify([{ name: 'native', cases: blueprintNames }]) && JSON.stringify(blueprint.fixturePaths) === '[]' && JSON.stringify(blueprint.capabilities) === JSON.stringify(['engine', 'nullrhi']), 'native blueprint requires the exact fourteen cases without saved fixture inputs');
  const blueprintRegistrations = ['UEMCPBlueprintHelperTests.cpp', 'UEMCPBlueprintHandlerTests.cpp'].flatMap(file => {
    const source = readFileSync(new URL(`../plugin/UEMCP/Source/UEMCP/Private/Tests/${file}`, import.meta.url), 'utf8');
    return [...source.matchAll(/IMPLEMENT_SIMPLE_AUTOMATION_TEST\s*\(\s*\w+\s*,\s*"(UEMCP\.Blueprint(?:Helpers|Handlers)\.[A-Za-z]+)"/g)].map(match => match[1]);
  });
  runner.assert(JSON.stringify(blueprintRegistrations) === JSON.stringify(blueprintNames), 'native blueprint expectations match three helper and eleven handler C++ registrations');
  if (blueprint) {
    const blueprintSource = collectSourceState(REPOSITORY_ROOT);
    const blueprintEvidence = {
      schemaVersion: 1, profile: blueprint.name, manifestDigest: blueprint.manifestDigest,
      sourceState: blueprintSource, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, blueprint.fixturePaths),
      suites: [{ name: 'native', state: 'passed', cases: blueprintNames.map(name => ({ name, state: 'passed' })) }],
    };
    runner.assert(validateExecution(blueprintEvidence, blueprint, blueprintSource).length === 0, 'native blueprint exact evidence binds source without claiming saved assets');
    const wrongSource = structuredClone(blueprintEvidence);
    wrongSource.sourceState.head = '0'.repeat(40);
    const { digest: unusedBlueprintDigest, ...rawBlueprintSource } = wrongSource.sourceState;
    wrongSource.sourceState.digest = sha256(JSON.stringify(rawBlueprintSource));
    runner.assert(validateExecution(wrongSource, blueprint, blueprintSource).includes('Wrong source state'), 'native blueprint rejects self-consistent evidence for a different source revision');
  }
  const owned = loadTestProfile('owned-serialization');
  runner.assert(owned.suites.length === 1 && owned.suites[0].cases.length === 4 && owned.fixturePaths.length === 3 && owned.fixturePaths.every(path => path.includes('/ue5.6-owned-v1/')), 'owned serialization requires four modern witnesses and all three modern corpus files');
  await runner.assertRejects(() => Promise.resolve(collectFixtureIdentity(root, owned.fixturePaths)), /ENOENT/, 'missing owned corpus is a hard prerequisite failure');
  const ownedExec = loadTestProfile('owned-blueprint-exec');
  runner.assert(ownedExec.runner === 'node' && ownedExec.suites.length === 1 && ownedExec.suites[0].name === 'test-owned-blueprint-exec.mjs' && ownedExec.suites[0].cases.length === 22 && JSON.stringify(ownedExec.fixturePaths) === JSON.stringify(owned.fixturePaths), 'owned exec requires its separate 22-case suite and immutable corpus identity');
  const execSource = collectSourceState(REPOSITORY_ROOT);
  const execEvidence = {
    schemaVersion: 1, profile: ownedExec.name, manifestDigest: ownedExec.manifestDigest,
    sourceState: execSource, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, ownedExec.fixturePaths),
    suites: [{ name: 'test-owned-blueprint-exec.mjs', state: 'passed', cases: ownedExec.suites[0].cases.map(name => ({ name, state: 'passed' })) }],
  };
  runner.assert(validateExecution(execEvidence, ownedExec, execSource).length === 0, 'owned exec complete evidence binds all named cases and fixture bytes');
  for (const [label, mutate] of [
    ['missing case', value => { value.suites[0].cases.pop(); }],
    ['duplicate case replacing required case', value => { value.suites[0].cases[1] = value.suites[0].cases[0]; }],
    ['skipped case', value => { value.suites[0].cases[0].state = 'skipped'; }],
  ]) {
    const changedExec = structuredClone(execEvidence);
    mutate(changedExec);
    runner.assert(validateExecution(changedExec, ownedExec, execSource).some(error => error.startsWith('Missing, duplicate or unsuccessful case:')), 'owned exec rejects ' + label + ' despite passing suite');
  }
  await runner.assertRejects(() => Promise.resolve(collectFixtureIdentity(root, ownedExec.fixturePaths)), /ENOENT/, 'owned exec missing corpus cannot satisfy profile prerequisites');
  const queryNames = [
    'owned query: exact graph discovery excluding graph classification',
    'owned query: exact node discovery',
    'owned query: call class',
    'owned query: event class',
    'owned query: call member',
    'owned query: event member',
    'owned query: target path',
    'owned query: target suffix',
    'owned query: combined filters',
    'owned query: conflicting filters',
    'owned query: unknown class',
    'owned query: unknown member',
    'owned query: unknown target',
    'owned query: case-sensitive member',
    'owned query: page offset 0',
    'owned query: page offset 1',
    'owned query: page offset 2',
    'owned query: filtering precedes pagination',
    'owned query: exact entry point discovery',
    'owned query: inspect OwnedPrint by name',
    'owned query: inspect OwnedPrint by discovered ID',
    'owned query: inspect OwnedEvent by name',
    'owned query: inspect OwnedEvent by discovered ID',
    'owned query: source-bound authored literal',
    'owned query: authoring source accepts LF and CRLF checkouts',
    'owned query controls: rejects edited authoring source',
    'owned query: unknown graph rejected',
    'owned query: unknown node rejected',
    'owned query controls: rejects dropped discovery node',
    'owned query controls: rejects wrong discovery GUID',
    'owned query controls: rejects wrong pagination total',
    'owned query controls: rejects dropped pin',
    'owned query controls: rejects renamed pin',
    'owned query controls: rejects reversed pin direction',
    'owned query controls: rejects dropped link',
    'owned query controls: rejects wrong linked node',
    'owned query controls: rejects wrong linked pin',
    'owned query controls: rejects changed literal',
    'owned query controls: rejects missing corpus',
    'owned query controls: rejects changed oracle hash',
    'owned query controls: rejects changed provenance',
    'owned query: all twelve pins use exec or data vocabulary',
    'owned query: all twelve pins reject null object defaults',
    'owned query controls: rejects invalid pin kind on every pin',
    'owned query controls: rejects missing pin kind on every pin',
    'owned query controls: rejects null object default on every pin',
  ];
  const queryInputs = [
    'server/fixtures/serialization/ue5.6-owned-v1/manifest.json',
    'server/fixtures/serialization/ue5.6-owned-v1/oracle.json',
    'server/fixtures/serialization/ue5.6-owned-v1/Content/Serialization/BP_OwnedLink.uasset',
    'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp',
  ];
  let queryProfile;
  try { queryProfile = loadTestProfile('owned-blueprint-query'); } catch { /* Keep missing-profile failure explicit. */ }
  runner.assert(queryProfile?.runner === 'node' && JSON.stringify(queryProfile.capabilities) === JSON.stringify(['engine-free', 'owned-serialization']) && JSON.stringify(queryProfile.suites) === JSON.stringify([{ name: 'test-owned-blueprint-query.mjs', cases: queryNames }]) && JSON.stringify(queryProfile.fixturePaths) === JSON.stringify(queryInputs), 'owned query profile pins all 46 independent case identities and four required inputs');
  if (queryProfile) {
    const queryEvidence = {
      schemaVersion: 1, profile: queryProfile.name, manifestDigest: queryProfile.manifestDigest,
      sourceState: execSource, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, queryInputs),
      suites: [{ name: 'test-owned-blueprint-query.mjs', state: 'passed', cases: queryNames.map(name => ({ name, state: 'passed' })) }],
    };
    runner.assert(validateExecution(queryEvidence, queryProfile, execSource).length === 0, 'owned query complete evidence binds corpus and authoring source bytes');
    for (const name of queryNames) {
      const missing = { ...queryEvidence, suites: [{ ...queryEvidence.suites[0], cases: queryEvidence.suites[0].cases.filter(item => item.name !== name) }] };
      runner.assert(validateExecution(missing, queryProfile, execSource).some(error => error.includes(`/${name}`)), `owned query profile rejects omission of ${name}`);
    }
    for (const [label, cases] of [
      ['duplicate', [queryEvidence.suites[0].cases[0], ...queryEvidence.suites[0].cases]],
      ['skipped', [{ ...queryEvidence.suites[0].cases[0], state: 'skipped' }, ...queryEvidence.suites[0].cases.slice(1)]],
      ['unknown', [{ name: 'owned query: undeclared case', state: 'passed' }, ...queryEvidence.suites[0].cases]],
    ]) {
      runner.assert(validateExecution({ ...queryEvidence, suites: [{ ...queryEvidence.suites[0], cases }] }, queryProfile, execSource).length > 0, `owned query profile rejects ${label} case despite passed suite`);
    }
    for (const path of queryInputs) {
      const files = queryEvidence.fixtureIdentity.files.filter(file => file.path !== path);
      runner.assert(validateExecution({ ...queryEvidence, fixtureIdentity: { files, digest: sha256(JSON.stringify(files)) } }, queryProfile, execSource).includes('Wrong fixture identity'), `owned query profile rejects missing required input ${path}`);
      const tampered = queryEvidence.fixtureIdentity.files.map(file => file.path === path ? { ...file, sha256: 'a'.repeat(64) } : file);
      runner.assert(validateExecution({ ...queryEvidence, fixtureIdentity: { files: tampered, digest: sha256(JSON.stringify(tampered)) } }, queryProfile, execSource).includes(`Fixture does not match source identity: ${path}`), `owned query profile rejects tampered required input ${path}`);
    }
    await runner.assertRejects(() => Promise.resolve(collectFixtureIdentity(root, queryInputs)), /ENOENT/, 'owned query missing inputs fail prerequisite collection');
    const wrongQuerySource = { ...execSource, head: '0'.repeat(40) };
    const { digest: unusedQueryDigest, ...rawQuerySource } = wrongQuerySource;
    wrongQuerySource.digest = sha256(JSON.stringify(rawQuerySource));
    runner.assert(validateExecution({ ...queryEvidence, sourceState: wrongQuerySource }, queryProfile, execSource).includes('Wrong source state'), 'owned query profile rejects self-consistent evidence for a different source');
  }
  const schemaPath = join(root, 'profile-schema.json');
  for (const capabilities of ['engine-free', ['engine-free', 'engine-free'], [null]]) {
    writeFileSync(schemaPath, JSON.stringify({ schemaVersion: 1, profiles: { invalid: { ...owned, capabilities } } }));
    await runner.assertRejects(() => Promise.resolve(loadTestProfile('invalid', { manifestPath: schemaPath })), /capabilities/, `rejects malformed capabilities ${JSON.stringify(capabilities)}`);
  }
  await runner.assertRejects(() => Promise.resolve(loadTestProfile('not-a-profile')), /Unknown/, 'unknown profile is refused');
  // Exercise the actual runner in an owned tiny checkout, without invoking the
  // complete consumer rotation or letting ambient project state choose cases.
  const server = join(root, 'server');
  mkdirSync(join(server, 'fixtures'), { recursive: true });
  for (const name of ['run-rotation.mjs', 'execution-manifest.mjs', 'rotation-timeouts.mjs', 'rotation-failure-details.mjs', 'rotation-oracle-freshness.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(server, name));
  }
  writeFileSync(join(server, 'fixtures/test-profiles.json'), JSON.stringify({ schemaVersion: 1, profiles: { control: { runner: 'node', fixturePaths: [], suites: [{ name: 'test-control.mjs', cases: ['outer', 'nested'] }] } } }));
  const run = () => spawnSync(process.execPath, ['run-rotation.mjs', '--test-profile', 'control', '--json'], { cwd: server, encoding: 'utf8', timeout: 30000 });
  const script = names => names.map(name => `console.log(${JSON.stringify(`UEMCP_CASE ${JSON.stringify({ name, state: 'passed' })}`)});`).join('\n') + `\nconsole.log('Passed: ${names.length}\\nFailed: 0\\nTotal: ${names.length}');`;
  for (const [label, content, expectedStatus] of [
    ['complete cases', script(['outer', 'nested']), 0],
    ['nested omission despite passing summary', script(['outer']), 1],
    ['duplicate case despite passing summary', script(['outer', 'outer']), 1],
    ['zero summary', script([]), 1],
    ['environment skip', "console.error('UNREAL_PROJECT_ROOT not set');", 1],
    ['nonzero exit after valid summary', `${script(['outer', 'nested'])}\nprocess.exit(1);`, 1],
  ]) {
    writeFileSync(join(server, 'test-control.mjs'), content);
    const result = run();
    runner.assert(result.status === expectedStatus, `rotation CLI ${label} exits ${expectedStatus}`, result.stderr);
  }
  unlinkSync(join(server, 'test-control.mjs'));
  runner.assert(run().status === 1, 'rotation CLI missing required suite fails');
} finally {
  cleanupCanonicalScratchRoot(root, 'uemcp-execution-');
}
process.exit(runner.summary());
