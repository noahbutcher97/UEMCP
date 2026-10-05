import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const assetParserSuites = [
    {
      "name": "test-owned-asset-info.mjs",
      "cases": [
        "owned asset-info: authored identity and manifest metadata",
        "owned asset-info: warm dispatcher preserves metadata",
        "owned asset-info: unchanged bytes reuse the cached payload",
        "owned asset-info: dirty index reparses unchanged bytes",
        "owned asset-info: newer mtime reparses equal-size bytes",
        "owned asset-info: equal-mtime size change cannot serve a stale payload",
        "owned asset-info: dirty index detects same-size same-mtime corruption",
        "owned asset-info: cached asset deletion reports missing asset",
        "owned asset-info: identical asset names in different roots have separate caches",
        "owned asset-info: unknown asset rejects without a cache entry",
        "owned asset-info: missing asset parameter rejects before cache population",
        "owned asset-info controls: rejects incorrect path",
        "owned asset-info controls: rejects incorrect packageName",
        "owned asset-info controls: rejects incorrect objectPath",
        "owned asset-info controls: rejects incorrect objectClassName",
        "owned asset-info controls: rejects incorrect tags",
        "owned asset-info controls: rejects incorrect sizeBytes",
        "owned asset-info controls: rejects incorrect sizeKB",
        "owned asset-info controls: rejects incorrect fileVersionUE5",
        "owned asset-info controls: rejects incorrect diskPath",
        "owned asset-info controls: edited authoring source is rejected",
        "owned asset-info: corpus remains byte-identical after all cases"
      ]
    },
    {
      "name": "test-owned-package-parser.mjs",
      "cases": [
        "owned parser: saved summary descriptors and name-table boundary",
        "owned parser: saved import stride and class references",
        "owned parser: all saved export tuples and 112-byte stride",
        "owned parser: Blueprint and generated-class registry records end at dependency data",
        "owned parser: saved package with corrupted magic rejects",
        "owned parser: summary accepts exact saved boundary and rejects one-byte truncation",
        "owned parser: names accepts exact saved boundary and rejects one-byte truncation",
        "owned parser: imports accepts exact saved boundary and rejects one-byte truncation",
        "owned parser: exports accepts exact saved boundary and rejects one-byte truncation",
        "owned parser: registry accepts exact saved boundary and rejects one-byte truncation",
        "owned parser: wrong export version desynchronizes the saved second record",
        "owned parser: injected serialSize overflow marks only its export and preserves later records",
        "owned parser: injected serialOffset overflow marks only its export and preserves later records",
        "owned parser: injected scriptSerializationStartOffset overflow marks only its export and preserves later records",
        "owned parser: injected scriptSerializationEndOffset overflow marks only its export and preserves later records",
        "owned parser: source buffer and on-disk package remain byte-identical"
      ]
    }
  ];
  const assetParserInputs = [...queryInputs];
  for (const [profileName, suites, inputs] of [
    ['owned-asset-info', [assetParserSuites[0]], assetParserInputs],
    ['owned-package-parser', [assetParserSuites[1]], assetParserInputs.slice(0, 3)],
    ['owned-asset-parser', assetParserSuites, assetParserInputs],
  ]) {
    const profile = loadTestProfile(profileName);
    runner.assert(profile.runner === 'node'
      && JSON.stringify(profile.capabilities) === JSON.stringify(['engine-free', 'owned-serialization'])
      && JSON.stringify(profile.suites) === JSON.stringify(suites)
      && JSON.stringify(profile.fixturePaths) === JSON.stringify(inputs), `${profileName} pins exact suites, cases and inputs`);
    const value = {
      schemaVersion: 1, profile: profileName, manifestDigest: profile.manifestDigest,
      sourceState: execSource, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, inputs),
      suites: suites.map(suite => ({ name: suite.name, state: 'passed', cases: suite.cases.map(name => ({ name, state: 'passed' })) })),
    };
    runner.assert(validateExecution(value, profile, execSource).length === 0, `${profileName} accepts complete bound evidence`);
    for (const suite of suites) {
      const missingSuite = { ...value, suites: value.suites.filter(item => item.name !== suite.name) };
      runner.assert(validateExecution(missingSuite, profile, execSource).includes(`Missing or duplicate suite: ${suite.name}`), `${profileName} rejects omitted ${suite.name}`);
      for (const name of suite.cases) {
        const missingCase = { ...value, suites: value.suites.map(item => item.name !== suite.name ? item : { ...item, cases: item.cases.filter(row => row.name !== name) }) };
        runner.assert(validateExecution(missingCase, profile, execSource).includes(`Missing, duplicate or unsuccessful case: ${suite.name}/${name}`), `${profileName} rejects omitted ${name}`);
      }
    }
    for (const path of inputs) {
      const files = value.fixtureIdentity.files.filter(file => file.path !== path);
      runner.assert(validateExecution({ ...value, fixtureIdentity: { files, digest: sha256(JSON.stringify(files)) } }, profile, execSource).includes('Wrong fixture identity'), `${profileName} rejects omitted input ${path}`);
    }
  }
  const registryBlueprintSuites = [
    {
      "name": "test-owned-blueprint-data.mjs",
      "cases": [
        "owned data: known positive exec edge is excluded from data sinks",
        "owned data: terminal call has no outgoing data sinks",
        "owned data: empty traversal at requested depth -1 reports cap 1",
        "owned data: empty traversal at requested depth 0 reports cap 1",
        "owned data: empty traversal at requested depth 1 reports cap 1",
        "owned data: empty traversal at requested depth 500 reports cap 500",
        "owned data: empty traversal at requested depth 501 reports cap 500",
        "owned data: raw entry-point GUID feeds data query and echoes oracle canonical identity",
        "owned data: raw inspected call GUID echoes its distinct oracle canonical identity",
        "owned data: unknown graph returns exact unavailable envelope",
        "owned data: unknown node returns exact unavailable envelope",
        "owned data: missing asset_path is rejected after valid baseline",
        "owned data: missing graph_name is rejected after valid baseline",
        "owned data: missing start_node_id is rejected after valid baseline",
        "owned data: controls reject exec edge leaked with consistent count",
        "owned data: controls reject invented sink despite zero count",
        "owned data: controls reject nonzero count despite empty sinks",
        "owned data: controls reject raw rather than canonical echo",
        "owned data: controls reject wrong asset identity",
        "owned data: controls reject wrong graph identity",
        "owned data: controls reject incorrect depth cap",
        "owned data: controls reject false reached depth",
        "owned data: controls reject false truncation",
        "owned data: controls reject unavailable success-shaped response"
      ]
    },
    {
      "name": "test-owned-asset-registry.mjs",
      "cases": [
        "owned registry: /Game scans the expected root and finds the authored package",
        "owned registry: /Game/ scans the expected root and finds the authored package",
        "owned registry: /Game/Serialization scans the expected root and finds the authored package",
        "owned registry: full and short primary class filters retain the real match",
        "owned registry: unknown, wrong full path and secondary class do not match",
        "owned registry: tag presence and independently authored exact value retain the match",
        "owned registry: absent or inherited tag keys and wrong values reject a scanned package",
        "owned registry: first page and exhausted offset retain the filtered total",
        "owned registry: combined filters determine total before exhausted pagination",
        "owned registry: absent directory scans zero files rather than reporting a filtered match",
        "owned registry: invalid mount and escaping traversal paths reject after a valid scan",
        "owned registry: positive comparator rejects dropped identity, filters and scan metadata",
        "owned registry: empty comparator rejects a leaked match and confused scan or pagination counts",
        "owned registry: corpus remains verified after all registry queries"
      ]
    },
    {
      "name": "test-owned-blueprint-inspect.mjs",
      "cases": [
        "owned inspect: generated-class selection resolves the authored Object parent",
        "owned inspect: CDO resolves its positive package index to the local generated class",
        "owned inspect: graph and compiled functions retain distinct Blueprint and generated-class owners",
        "owned inspect: only Blueprint and generated class have the saved asset flag",
        "owned inspect: controls reject missing or inconsistent generated-class and parent selection",
        "owned inspect: controls reject unresolved or misdirected CDO class identity",
        "owned inspect: controls reject collapsed or swapped graph and function ownership",
        "owned inspect: controls reject an inverted asset flag on every saved export"
      ]
    }
  ];
  const registryBlueprintInputs = [...queryInputs];
  for (const [name, suites, inputs] of [
    ['owned-blueprint-data', [registryBlueprintSuites[0]], registryBlueprintInputs.slice(0, 3)],
    ['owned-asset-registry', [registryBlueprintSuites[1]], registryBlueprintInputs],
    ['owned-blueprint-inspect', [registryBlueprintSuites[2]], registryBlueprintInputs],
    ['owned-registry-blueprint', registryBlueprintSuites, registryBlueprintInputs],
  ]) {
    const profile = loadTestProfile(name);
    runner.assert(profile.runner === 'node'
      && JSON.stringify(profile.capabilities) === JSON.stringify(['engine-free', 'owned-serialization'])
      && JSON.stringify(profile.suites) === JSON.stringify(suites)
      && JSON.stringify(profile.fixturePaths) === JSON.stringify(inputs), `${name} pins exact suites, cases and inputs`);
    const value = {
      schemaVersion: 1, profile: name, manifestDigest: profile.manifestDigest,
      sourceState: execSource, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, inputs),
      suites: suites.map(suite => ({ name: suite.name, state: 'passed', cases: suite.cases.map(caseName => ({ name: caseName, state: 'passed' })) })),
    };
    runner.assert(validateExecution(value, profile, execSource).length === 0, `${name} accepts complete bound evidence`);
    for (const suite of suites) {
      const missingSuite = { ...value, suites: value.suites.filter(item => item.name !== suite.name) };
      runner.assert(validateExecution(missingSuite, profile, execSource).includes(`Missing or duplicate suite: ${suite.name}`), `${name} rejects omitted ${suite.name}`);
      for (const caseName of suite.cases) {
        const missingCase = { ...value, suites: value.suites.map(item => item.name !== suite.name ? item : { ...item, cases: item.cases.filter(row => row.name !== caseName) }) };
        runner.assert(validateExecution(missingCase, profile, execSource).includes(`Missing, duplicate or unsuccessful case: ${suite.name}/${caseName}`), `${name} rejects omitted ${caseName}`);
      }
      for (const state of ['skipped', 'failed']) {
        const changed = structuredClone(value);
        changed.suites.find(item => item.name === suite.name).cases[0].state = state;
        runner.assert(validateExecution(changed, profile, execSource).some(error => error.startsWith('Missing, duplicate or unsuccessful case:')), `${name} rejects ${state} case in ${suite.name} despite passed suite`);
      }
    }
    for (const path of inputs) {
      const files = value.fixtureIdentity.files.filter(file => file.path !== path);
      runner.assert(validateExecution({ ...value, fixtureIdentity: { files, digest: sha256(JSON.stringify(files)) } }, profile, execSource).includes('Wrong fixture identity'), `${name} rejects omitted input ${path}`);
    }
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

  // Runner protocol controls only, in this owned scratch checkout. These tiny
  // emitters do not claim to execute the actual asset-info or parser assertions.
  const combinedProfile = loadTestProfile('owned-asset-parser');
  writeFileSync(join(server, 'fixtures/test-profiles.json'), JSON.stringify({
    schemaVersion: 1, profiles: { 'owned-asset-parser': combinedProfile },
  }));
  for (const path of assetParserInputs) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), target);
  }
  for (const suite of assetParserSuites) writeFileSync(join(server, suite.name), script(suite.cases));
  const runCombinedControl = () => spawnSync(process.execPath,
    ['run-rotation.mjs', '--test-profile', 'owned-asset-parser', '--json'],
    { cwd: server, encoding: 'utf8', timeout: 30000 });
  runner.assert(runCombinedControl().status === 0, 'combined profile CLI control accepts complete case protocol');
  for (const path of [...assetParserInputs, ...assetParserSuites.map(suite => `server/${suite.name}`)]) {
    const target = join(root, path);
    renameSync(target, `${target}.withheld`);
    try {
      runner.assert(runCombinedControl().status === 1, `combined profile CLI rejects missing file ${path}`);
    } finally { renameSync(`${target}.withheld`, target); }
  }
  for (const suite of assetParserSuites) {
    writeFileSync(join(server, suite.name), script(suite.cases.slice(1)));
    try {
      const result = runCombinedControl();
      const report = JSON.parse(result.stdout);
      runner.assert(result.status === 1 && report.executionErrors.some(error => error.includes(`/${suite.cases[0]}`)),
        `combined profile CLI rejects case omission despite passing ${suite.name} summary`);
    } finally { writeFileSync(join(server, suite.name), script(suite.cases)); }
  }

  // Protocol-only emitters in the same owned scratch checkout. Real 46-case
  // semantic acceptance is established by running the registered suites themselves.
  const registryBlueprintProfile = loadTestProfile('owned-registry-blueprint');
  writeFileSync(join(server, 'fixtures/test-profiles.json'), JSON.stringify({
    schemaVersion: 1, profiles: { 'owned-registry-blueprint': registryBlueprintProfile },
  }));
  for (const suite of registryBlueprintSuites) writeFileSync(join(server, suite.name), script(suite.cases));
  const runRegistryBlueprintControl = () => spawnSync(process.execPath,
    ['run-rotation.mjs', '--test-profile', 'owned-registry-blueprint', '--json'],
    { cwd: server, encoding: 'utf8', timeout: 30000 });
  runner.assert(runRegistryBlueprintControl().status === 0, 'registry Blueprint profile CLI accepts complete case protocol');
  for (const path of [...registryBlueprintInputs, ...registryBlueprintSuites.map(suite => `server/${suite.name}`)]) {
    const target = join(root, path);
    renameSync(target, `${target}.withheld`);
    try {
      runner.assert(runRegistryBlueprintControl().status === 1, `registry Blueprint profile CLI rejects missing file ${path}`);
    } finally { renameSync(`${target}.withheld`, target); }
  }
  for (const suite of registryBlueprintSuites) {
    writeFileSync(join(server, suite.name), script(suite.cases.slice(1)));
    try {
      const result = runRegistryBlueprintControl();
      const report = JSON.parse(result.stdout);
      runner.assert(result.status === 1 && report.executionErrors.some(error => error.includes(`/${suite.cases[0]}`)),
        `registry Blueprint profile CLI rejects case omission despite passing ${suite.name} summary`);
    } finally { writeFileSync(join(server, suite.name), script(suite.cases)); }
  }
} finally {
  cleanupCanonicalScratchRoot(root, 'uemcp-execution-');
}
process.exit(runner.summary());
