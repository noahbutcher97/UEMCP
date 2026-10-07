// Portable source contracts and required-report controls. Never builds or starts Unreal.
import { readFileSync } from 'node:fs';
import { TestRunner } from './test-helpers.mjs';
import { parseAutomationReport, reportExitCode, reportProblems } from './native-test-report.mjs';

const t = new TestRunner('World fixture native source (offline)');
const nativeRoot = '../plugin/UEMCP/Source/UEMCP/Private/Tests/';
const source = readFileSync(new URL(`${nativeRoot}UEMCPWorldMapFixtureTests.proposal.cpp`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const preflight = readFileSync(new URL(`${nativeRoot}SummaryAllocationPreflight.proposal.h`, import.meta.url), 'utf8');
const reader = readFileSync(new URL(`${nativeRoot}WorldPackageReader.proposal.h`, import.meta.url), 'utf8');
const names = ['UEMCP.WorldMapFixture.AuthorMap', 'UEMCP.WorldMapFixture.ReloadAndReadOracle'];
const gate = '#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION == 6';
const gateAt = source.indexOf(gate);
const otherwise = source.indexOf('\n#else\n', gateAt);
const gateEnd = source.indexOf('\n#endif\n', otherwise);
const shared = source.slice(0, gateAt);
const supported = source.slice(gateAt + gate.length, otherwise);
const unsupported = source.slice(otherwise, gateEnd);
const registrations = source.slice(gateEnd + '\n#endif\n'.length);
t.assert(gateAt > 0 && otherwise > gateAt && gateEnd > otherwise, 'World source has a closed exact UE 5.6 compile boundary');
t.assert(shared.includes('#include "Runtime/Launch/Resources/Version.h"'), 'World engine macros come from the engine version header before the compile boundary');
t.assert(source.includes('#if WITH_DEV_AUTOMATION_TESTS') && source.trimEnd().endsWith('#endif'), 'World registration remains inside the development automation guard');
for (const header of ['WorldPackageReader.proposal.h', 'Engine/World.h', 'Engine/LevelActorContainer.h', 'AI/NavigationSystemConfig.h']) {
  t.assert(supported.includes(`#include "${header}"`) && !shared.includes(`#include "${header}"`) && !unsupported.includes(`#include "${header}"`), `World UE 5.6-only include stays guarded: ${header}`);
}
t.assert(/static_assert\(VER_UE4_AUTOMATIC_VERSION == 522 &&\s*int32\(EUnrealEngineObjectUE5Version::AUTOMATIC_VERSION\) == 1017/.test(preflight), 'World preflight retains its exact reviewed layout assertion');
t.assert(unsupported.includes('Test.AddError(TEXT("Unsupported World fixture engine: only the reviewed UE 5.6 package layout is supported"))') && unsupported.includes('return false;') && !unsupported.includes('return true;'), 'World unsupported engine is an explicit failure, never a successful skip');
for (const phase of ['Author', 'Reload']) {
  t.assert(unsupported.includes(`static bool ${phase}(FAutomationTestBase& Test) { return UnsupportedEngine(Test); }`), `World ${phase} has an unsupported-engine failure entry point`);
}
for (const name of names) {
  t.assert([...registrations.matchAll(/IMPLEMENT_COMPLEX_AUTOMATION_TEST\([^,]+, "([^"]+)"/g)].filter(match => match[1] === name).length === 1, `World exact case remains registered outside the engine boundary: ${name}`);
}
t.assert(!source.includes('IMPLEMENT_SIMPLE_AUTOMATION_TEST'), 'World broad unconditional simple-test discovery is removed');
t.assert((registrations.match(/OutTestCommands\.Add\(FString\(\)\)/g) ?? []).length === 2, 'World complex cases use empty commands to preserve exact full report names');
t.assert((registrations.match(/if \(UEMCP::WorldMapFixturePreparation::HasExplicitTestRequest\(GetBeautifiedTestName\(\)\)\)/g) ?? []).length === 2, 'World both enumerations require their own exact explicit request');
t.assert(shared.includes('FParse::Value(FCommandLine::Get(), TEXT("ExecCmds="), ExecCommands, false)'), 'World absent startup command fails admission before any fixture work');
t.assert(shared.includes('ExecCommands.Split(TEXT(";"), &FirstCommand, &RemainingCommands)') && shared.includes('const TCHAR* Command = *FirstCommand;'), 'World only the first startup command can admit a case');
t.assert(shared.includes('FParse::Command(&Command, TEXT("Automation"))') && shared.includes('FParse::Command(&Command, TEXT("RunTests"))') && shared.includes('FParse::Command(&Command, TEXT("RunTest"))'), 'World admission requires the supported automation run command, including its engine alias');
t.assert(shared.includes('FString(Command).ParseIntoArray(Names, TEXT("+"), true)') && shared.includes('const FString ExactName = Name.TrimStartAndEnd();'), 'World admission examines individual trimmed engine filter tokens');
t.assert(shared.includes('ExactName.Equals(TestName, ESearchCase::IgnoreCase)') && shared.includes('ExactName.Equals(TEXT("^") + TestName + TEXT("$"), ESearchCase::IgnoreCase)'), 'World admits full plain or paired-anchor names, rather than substring prefixes');
t.assert(!/\.Contains\(|\.StartsWith\(|TEXT\("RunAll"\)|TEXT\("Group:"\)/.test(shared), 'World default, substring, group and RunAll selectors cannot broaden admission');
t.assert(!/UEMCPWorldPhase=|UEMCPWorldRun=|Hex32\(|ENGINE_MINOR_VERSION|FEngineVersion/.test(shared), 'World invalid authority flags and unsupported versions cannot silently hide exact requests during discovery');
const open = supported.slice(supported.indexOf('static bool Open('), supported.indexOf('struct FReadGuard'));
for (const field of ['UEMCPWorldRun=', 'UEMCPWorldPhase=', 'UEMCPWorldStage=', 'UEMCPWorldAttempt=']) {
  t.assert(open.includes(`TEXT("${field}")`), `World supervisor reads its explicit ${field} field`);
}
for (const condition of ['!Hex32(R.Id)', '!Hex32(R.Stage)', '!Hex32(R.Attempt)', 'GivenPhase!=Phase', 'FEngineVersion::Current().GetMajor()!=5', 'FEngineVersion::Current().GetMinor()!=6']) {
  t.assert(open.includes(condition), `World missing or invalid supervisor field remains rejected: ${condition}`);
}
for (const flag of ['NullRHI', 'NoSound', 'Unattended']) {
  t.assert(open.includes(`!FParse::Param(FCommandLine::Get(),TEXT("${flag}"))`), `World missing required ${flag} flag remains rejected`);
}
t.assert(supported.includes('Value.Len()!=32') && supported.includes('!FChar::IsHexDigit(C) || C!=FChar::ToLower(C)'), 'World supervisor IDs retain bounded lower-case hexadecimal validation');
for (const field of ['schema', 'run_id', 'stage_id', 'attempt_id', 'phase', 'project_dir']) {
  t.assert(open.includes(`TryGetStringField(TEXT("${field}")`), `World missing or mismatched authority JSON ${field} remains checked`);
}
t.assert(open.includes('marker alone is not supervisor launch authority') && open.includes('Missing/mismatched owned World authority') && !open.includes('return true; // skipped'), 'World enumeration admission never replaces supervisor authority');
t.assert(supported.includes('AuthorAttempt==R.Attempt') && supported.includes('FindPackage(nullptr,*R.Package)') && supported.includes('File.Sha1!=Sha1') && supported.includes('File.Bytes.Num()!=Size'), 'World reload still requires a distinct attempt, fresh package and author byte identity');

// These assert native control registration; only a native run executes the byte mutations.
t.assert(reader.includes('Ar.Cursor()!=Dependency') && reader.includes('Registry object data must end at dependency offset'), 'World reader rejects a registry gap as well as an overrun');
t.assert(supported.includes('Dependency>=Baseline.Budget.SectionEnd(RegistryAt)') && supported.includes('GetNumberField(TEXT("end")))!=Dependency'), 'World registry mutation requires a contiguous baseline with room for an in-section gap');
t.assert(supported.includes('I64(GapBytes,RegistryAt,Dependency+1)') && supported.includes('GapReader.Read(GapBytes,R.Package)') && supported.includes('GapReader.Error,FString(TEXT("Registry object data must end at dependency offset"))'), 'World forward boundary mutation must fail at the exact registry boundary');
t.assert(supported.includes('I64(B,RegistryAt,Dependency-1)') && supported.includes('if(RegistryObjects>1)') && supported.includes('I32(B,RegistryAt+8,RegistryObjects-1)'), 'World controls include backward boundary and eligible positive underreported counts');

// Exercise the actual report validator: absence, skip or false success cannot
// replace either explicitly required case, even alongside unrelated success.
for (const name of names) {
  for (const [label, entry] of [
    ['unsupported engine', { state: 'Fail', entries: [{ event: { type: 'Error', message: 'Unsupported World fixture engine' } }] }],
    ['missing authority', { state: 'Fail', entries: [{ event: { type: 'Error', message: 'Missing/mismatched owned World authority' } }] }],
    ['invalid phase or ID', { state: 'Fail', entries: [{ event: { type: 'Error', message: 'Explicit owned World phase and bounded headless flags required' } }] }],
    ['success carrying unsupported error', { state: 'Success', entries: [{ event: { type: 'Error', message: 'Unsupported World fixture engine' } }] }],
    ['labelled skip', { state: 'Success', entries: [{ event: { type: 'Info', message: 'skipped: unsupported engine' } }] }],
  ]) {
    const report = parseAutomationReport({ tests: [{ fullTestPath: name, ...entry }] });
    t.assert(reportExitCode(report, { expectedNames: [name] }) === 1, `World required ${name} cannot pass with ${label}`);
  }
  const missing = parseAutomationReport({ tests: [{ fullTestPath: 'UEMCP.TransformParser.Valid', state: 'Success' }] });
  t.assert(reportProblems(missing, { expectedNames: [name] }).includes(`missing required test: ${name}`), `World absent ${name} is not masked by unrelated success`);
  const empty = parseAutomationReport({ tests: [] });
  t.assert(reportExitCode(empty, { expectedNames: [name] }) === 4, `World empty discovery is not success for required ${name}`);
}
const complete = parseAutomationReport({ tests: names.map(fullTestPath => ({ fullTestPath, state: 'Success' })) });
t.assert(reportExitCode(complete, { expectedNames: names }) === 0, 'World report contract accepts both exact completed names without suffixes');
process.exitCode = t.summary() ? 1 : 0;
