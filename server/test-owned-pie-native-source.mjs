// Structural source controls only: these do not execute C++ or qualify native PIE.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TestRunner } from './test-helpers.mjs';
const t = new TestRunner('Owned PIE native source contracts');
const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const native = read('../plugin/UEMCP/Source/UEMCP/Private/OwnedPIEControl.cpp');
const registry = read('../plugin/UEMCP/Source/UEMCP/Private/MCPCommandRegistry.cpp');
const edge = read('../plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp');
const moduleSource = read('../plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp');
function body(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 1, i = open + 1;
  for (; i < source.length && depth; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  assert.equal(depth, 0, `Unbalanced ${signature}`);
  return source.slice(open + 1, i - 1);
}
function ordered(source, ...needles) {
  let cursor = -1;
  for (const needle of needles) {
    cursor = source.indexOf(needle, cursor + 1);
    assert.ok(cursor >= 0, `Missing or out of order: ${needle}`);
  }
}
function check(name, fn) {
  try { fn(); t.assert(true, `owned PIE native source: ${name}`); }
  catch (error) { t.assert(false, `owned PIE native source: ${name}`, error.stack); }
}
const admit = body(native, 'bool AdmitOwnedPIECommand(');
const reconcile = body(native, 'void Reconcile(');
const tick = body(native, 'void ObservePostEditorTick(');
const start = body(native, 'bool ConfigureOwnedPIEStart(');
check('ordinary mode bypasses qualification policy and internal registration', () => {
  ordered(admit, 'if (!S.bEnabled) return true;', 'CheckNonce(Params, Out)');
  ordered(body(native, 'void RegisterOwnedPIEHandlers('), 'if (!State().bEnabled) return;', 'Registry.Register(');
  ordered(start, 'if (!State().bEnabled) return true;', 'DuplicateObject<');
  assert.ok(native.includes('FParse::Param(FCommandLine::Get(), TEXT("UEMCPOwnedPIE"))'));
});
check('nonce validation precedes permanent native sealing', () => {
  ordered(admit, 'CheckNonce(Params, Out)', 'FScopeLock Lock(&S.Mutex)', 'Command == TEXT("owned_pie_fence")', 'S.bSealed = true', 'S.SealTick = S.Tick');
});
check('owned mode excludes non-lifecycle mutation surfaces', () => {
  assert.match(admit, /!IsLifecycle\(Command\) && !IsControl\(Command\)/);
  assert.ok(admit.includes('TEXT("OWNED_PIE_COMMAND")'));
  assert.deepEqual([...body(native, 'bool IsLifecycle(').matchAll(/TEXT\("([^"]+)"\)/g)].map(m => m[1]).sort(), ['get_pie_actor_state','get_pie_session_state','start_pie','stop_pie']);
});
check('sealed or unverified commands cannot receive operation tickets', () => {
  ordered(admit, 'if (S.bSealed)', 'if (!S.bVerified)', 'Admission.Ticket = ++S.Accepted', 'S.Outstanding.Add(Admission.Ticket)');
});
check('admission precedes dispatch and completion is owned by actual callback', () => {
  ordered(registry, 'AdmitOwnedPIECommand(CommandType', 'RunOnGameThread([HandlerPtr, ParamsCopy, SharedOut, OwnedAdmission]', 'ON_SCOPE_EXIT { CompleteOwnedPIECallback(OwnedAdmission); };', 'BeginOwnedPIECallback(OwnedAdmission', '(*HandlerPtr)(ParamsCopy, *SharedOut)');
  assert.equal((registry.match(/CompleteOwnedPIECallback\(/g) || []).length, 1);
  assert.equal(body(registry, 'if (!bDispatched)').includes('CompleteOwnedPIECallback'), false);
});
check('late callback rejection retains exactly-once completion accounting', () => {
  ordered(body(native, 'bool BeginOwnedPIECallback('), 'FScopeLock Lock', 'if (State().bSealed)', 'OwnedWorld(World, Out)');
  assert.match(body(native, 'void CompleteOwnedPIECallback('), /Outstanding\.Remove\(Admission\.Ticket\) == 1\) \+\+State\(\)\.Completed/);
});
check('reconciliation waits for outstanding callbacks before engine mutation', () => {
  ordered(reconcile, 'if (!State().bSealed)', 'bOutstanding = State().Outstanding.Num() != 0', 'if (bOutstanding)', 'CancelRequestPlaySession()', 'RequestEndPlayMap()');
});
check('queued cancellation excludes active startup and blind session reset', () => {
  assert.ok(reconcile.includes('Flags.bQueuedStart && !Flags.bSession && !Flags.bWorld && Flags.Contexts == 0'));
  assert.equal(reconcile.includes('OWNED_PIE_STARTUP_UNRESOLVED'), false);
  ordered(reconcile, 'else if (Flags.bWorld)', 'Flags = ReadFlags();', 'State().bReconcileRequested = true', 'BuildSuccessResponse(Out, Snapshot(Flags))');
  assert.equal((native.match(/CancelRequestPlaySession\(/g) || []).length, 1);
  assert.equal(/GEditor->EndPlayMap\(/.test(native), false);
});
check('drain witnesses require distinct post-editor ticks after latest action', () => {
  assert.ok(native.includes('OnPostEditorTick().AddStatic(&ObservePostEditorTick)'));
  for (const clause of ['!S.bSealed','!S.bReconcileRequested','S.Outstanding.Num() != 0','!bZero','S.Tick <= S.SealTick','S.Tick <= S.ReconcileTick','S.Tick > S.FirstZeroTick']) assert.ok(tick.includes(clause), clause);
  assert.match(reconcile, /!State\(\)\.bReconcileRequested \|\| bRequestedAction/);
  assert.ok(reconcile.includes('State().FirstZeroTick = State().DrainedTick = 0'));
});
check('snapshot drain requires completed ledger and all lifecycle flags clear', () => {
  const snapshot = body(native, 'TSharedPtr<FJsonObject> Snapshot(');
  for (const clause of ['S.DrainedTick > S.SealTick','S.DrainedTick > S.ReconcileTick','S.Outstanding.Num() == 0','S.Accepted == S.Completed','Flags.IsZero()']) assert.ok(snapshot.includes(clause), clause);
  const flags = body(native, 'FEngineFlags ReadFlags(');
  for (const query of ['IsPlaySessionRequestQueued()','GetPlayInEditorSessionInfo().IsSet()','ShouldEndPlayMap()','IsSimulateInEditorInProgress()','Context.WorldType == EWorldType::PIE']) assert.ok(flags.includes(query), query);
});
check('owned start duplicates settings and forces one in-process standalone world', () => {
  for (const expression of ['DuplicateObject<ULevelEditorPlaySettings>(GetDefault<ULevelEditorPlaySettings>()','SetPlayNetMode(EPlayNetMode::PIE_Standalone)','SetPlayNumberOfClients(1)','SetRunUnderOneProcess(true)','bLaunchSeparateServer = false','EPlaySessionDestinationType::InProcess','EPlaySessionWorldType::PlayInEditor','Request.bAllowOnlineSubsystem = false','Request.GlobalMapOverride = OwnedMap']) assert.ok(start.includes(expression), expression);
  assert.equal(/GetMutableDefault|SaveConfig/.test(start), false);
  ordered(edge, 'ConfigureOwnedPIEStart(PlayParams, OutResponse)', 'GEditor->RequestPlaySession(PlayParams)');
});
check('native verification returns array transforms compatible with owner oracle', () => {
  const verify = body(native, 'void Verify(');
  for (const key of ['location','rotation','scale']) assert.ok(verify.includes(`SetArrayField(TEXT("${key}")`), key);
  for (const name of ['OwnedLifecycleActor','DefinitelyAbsentOwnedProbe','/Game/OwnedPIE/Lifecycle']) assert.ok(native.includes(name), name);
  assert.ok(verify.includes('SetNumberField(TEXT("InputPriority")'));
  assert.equal(/InputPriority\s*=|SetCanBeDamaged/.test(verify), false);
});
check('shutdown seals only its lane and removes its delegate without process authority', () => {
  ordered(body(native, 'void ShutdownOwnedPIEControl('), 'if (!S.bEnabled) return;', 'S.bSealed = true', 'S.bShuttingDown = true', 'OnPostEditorTick().Remove(S.TickHandle)');
  assert.ok(body(native, 'bool OwnedWorld(').includes('if (State().bShuttingDown)'));
  ordered(moduleSource, 'void FUEMCPModule::ShutdownModule()', 'UEMCP::ShutdownOwnedPIEControl();', 'StopTcpServer();');
  assert.equal(/CreateProc|TerminateProc|RequestExit|KillProcess|StopTcpServer/.test(native), false);
});
check('source staging includes both native control files', () => {
  const files = JSON.parse(read('./fixtures/host-source-files.json')).files;
  for (const file of ['plugin/UEMCP/Source/UEMCP/Private/OwnedPIEControl.cpp','plugin/UEMCP/Source/UEMCP/Public/OwnedPIEControl.h']) assert.equal(files.filter(name => name === file).length, 1);
});
process.exitCode = t.summary();
