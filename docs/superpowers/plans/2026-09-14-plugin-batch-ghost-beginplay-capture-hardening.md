# Plugin batch: ghost BeginPlay and BUG-2 fixes, capture path confinement, capture coverage, runner passthrough — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One plugin deploy cycle that closes backlog BUG-2 (four Blueprint-handler quirks), EN-28 (capture output paths confined to the project), EN-29 (capture coverage the headless suite could not reach), and adds a `--extra-arg` passthrough to the native test runner.

**Architecture:** Node work lands first (runner passthrough, no build). C++ work follows in five tasks, each with its own native test and its own sync-build-test cycle on the sample 5.6 target; shared logic goes into the two existing `Public/` headers (`BlueprintHandlerHelpers.h`, `AssetEditorCapture.h`) so tests can reach it and unity builds stay clean. Docs, version bump and the D-log row close the branch. The primary target receives one deploy at the end, by the orchestrator, inside a peer-granted window.

**Tech Stack:** UE 5.6 C++ (editor module, automation tests behind `WITH_DEV_AUTOMATION_TESTS`), Node 20 ES modules, the repo's `run-native-tests.mjs` headless runner, `run-rotation.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-14-plugin-batch-ghost-beginplay-capture-hardening-design.md` — read it first; every task below argues from it.

## Global Constraints

- Public repo, private targets under NDA: placeholder vocabulary only in tracked files ("the primary target", "the sample target"); the pre-commit and pre-push hooks scan against the per-checkout token file, and the bare word "temp" is blocked (write "scratch").
- No AI attribution in commits. One commit per task; never push from a task.
- C++ helpers used by more than one `Private/*.cpp` live in a `Public/` header; functions under 50 lines where possible; comment intent.
- Every native test creates its fixture in `/Game/__UEMCPTests/<unique leaf>`, registers it with the asset registry, and tears it down on every exit path; nodes are addressed by handler-reported GUIDs; `compile` is explicit on every dispatch.
- Sync before every build (Build.bat compiles the deployed copy); the sample target is the only build target during tasks; stop any build with no compiler process for five minutes and report BLOCKED.
- Wire behaviour changes are the four listed in spec §4.1 and §4.2, the new fields and error code in §4.3 and §4.4, and the relocation of `get_viewport_screenshot`'s relative output paths under `Saved/UEMCP/Captures/`; nothing else on the wire changes.
- `npx eslint .` from `server/` stays silent; `node run-rotation.mjs` from `server/` stays all-PASS (baseline 7,789 assertions across 80 files; Task 1 adds 8).
- Line numbers in this plan are at commit 9ebade8; re-check them before editing.

**The sample deploy cycle** (every C++ task runs it; the dispatch supplies `<SAMPLE_UPROJECT>`, the sample target's `.uproject` path, and `<SCRATCH>`, a scratch directory outside the repo; `<UE_ENGINE_ROOT>` is `C:\Program Files\Epic Games\UE_5.6` unless the dispatch says otherwise):

```powershell
# from D:\DevTools\UEMCP
& .\sync-plugin.bat "<SAMPLE_UPROJECT>" -y
& "<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <SampleProjectName>Editor Win64 Development "-project=<SAMPLE_UPROJECT>" -WaitMutex -FromMsBuild -NoUBA "-Log=<SCRATCH>\ubt.log"
node server\run-native-tests.mjs --uproject "<SAMPLE_UPROJECT>"
```

Expected after each task: `Build` prints `Result: Succeeded`; the runner prints `Native tests: N passed, 0 failed, 0 not run` with N as the task states, and `Labelled skips: 3`. Quote the three lines in the report.

**Deviations from the spec, decided while planning (the spec is otherwise binding):**
- Spec §4.3 names the resolver's second parameter `DefaultLeaf`; it is `DefaultStem` here and feeds the existing timestamped `DefaultCapturePath(Stem)`, so default file names keep their timestamp.
- Spec §5 extends `DisconnectPinEdges`; the real break happens in `DisconnectPin`, so the `link_count` assertion goes there and the `DisconnectPinEdges` comment is corrected.
- Spec §5's `InlinePngCap` asserts `byte_length`; `FinishCapture` sets that field, not the helper, so the helper test asserts the two inline fields and the decoded bytes only.
- Spec §4.4(c) expects `scrolled: false` on an over-range smoke scroll; whether the clamped last row is a property row depends on the panel, so the smoke logs `scrolled` and checks its type and the clamp instead.
- Spec §4.2's rollback for the assignment handler mentions "the variable itself if this call created it"; the handler never creates variables, so the rollback is its two nodes.

---

## File Structure

| File | Responsibility in this plan |
|---|---|
| `server/run-native-tests.mjs` | `--extra-arg` parsing; `applyExtraArgs` override-or-append; passes extras to `buildEditorCommand` (Task 1) |
| `server/test-native-runner.mjs` | +8 assertions for the passthrough (Task 1) |
| `plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h` + `Private/BlueprintHandlerHelpers.cpp` | `EnsureEventNodeEnabled` (Task 2); element-validated vector literal (Task 4) |
| `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp` | ghost enabling at three reuse sites (Tasks 2, 3); `target_pin_info` after the break (Task 4); assignment compile-failure path (Task 5) |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` | new tests `GhostBeginPlayEnabled`, `EventNodeGhostSites`, `AssignmentCompileFailed`; one assertion added to `DisconnectPin` (Tasks 2–5) |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp` | three assertions added to `LiteralDefaults` (Task 4) |
| `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h` + `Private/AssetEditorCapture.cpp` | `ResolveCaptureOutputPath`, `AppendInlinePng`; `FinishCapture` takes a resolved path (Tasks 6, 7) |
| `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp` | early path resolution in two handlers; `scrolled` field (Tasks 6, 7) |
| `plugin/UEMCP/Source/UEMCP/Private/VisualCaptureHandler.cpp` | early path resolution in `get_viewport_screenshot` (Task 6) |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp` | new tests `OutputPathConfinement`, `CaptureUnsupportedHelper`, `InlinePngCap` (Tasks 6, 7) |
| `server/live-smoke-asset-editor-capture.mjs` | inline capture decode; over-range scroll (Task 7) |
| `tools.yaml` | `out_png`/`output_path` descriptions; `enabled_ghost`, `scrolled` notes (Tasks 6, 8) |
| `manifest.json`, `plugin/UEMCP/UEMCP.uplugin`, `CLAUDE.md`, `docs/tracking/backlog.md`, `docs/tracking/risks-and-decisions.md` | version 1.0.19 / 20, counts, backlog moves, D201 (Task 8) |

---

### Task 1: Runner `--extra-arg` passthrough with override semantics

**Files:**
- Modify: `server/run-native-tests.mjs:23-38` (`parseRunnerArgs`), `:84-101` (`buildEditorCommand`), `:118` (usage line), `:130` (`main`'s call)
- Test: `server/test-native-runner.mjs` (after the existing `buildEditorCommand` block at `:53-57`)
- Modify: `CLAUDE.md` — the "Native plugin tests" paragraph (search `Run them with \`run-native-tests.bat`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `parseRunnerArgs(argv).extraArgs: string[]`; `applyExtraArgs(standardArgs: string[], extraArgs: string[]): string[]` (exported); `buildEditorCommand({ ..., extraArgs })` now applies them with override-or-append semantics. Task 8's docs and the orchestrator's primary-target run depend on `--extra-arg`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test-native-runner.mjs` directly after the line `t.assert(cmd.args.includes('-ReportExportPath=C:/tmp/r') && ...headless flags present');`:

```js
// --extra-arg passthrough (spec §4.5). Unreal's FParse::Value returns the FIRST
// -Name= occurrence, so an extra that shares a -Name= prefix with a standard
// argument must replace it in place; anything else appends in order.
const extras = buildEditorCommand({
  engineRoot: 'C:/UE', uprojectPath: 'D:/P/P.uproject', filter: 'UEMCP', reportDir: 'C:/tmp/r',
  extraArgs: ['-ExecCmds=Automation RunTests UEMCP,Automation Quit', '-ddc=InstalledNoZenLocalFallback', '-NoSourceControl'],
});
t.assert(extras.args.filter(a => a.toLowerCase().startsWith('-execcmds=')).length === 1, 'an -ExecCmds= extra leaves exactly one -ExecCmds= in the argument list');
t.assert(extras.args[1] === '-ExecCmds=Automation RunTests UEMCP,Automation Quit', 'the extra -ExecCmds= replaces the standard one in its position');
t.assert(extras.args.slice(-2).join(' ') === '-ddc=InstalledNoZenLocalFallback -NoSourceControl', 'non-matching extras append after the standard flags, in order');
t.assert(applyExtraArgs(['D:/P/P.uproject', '-a=1'], ['-A=2']).join(' ') === 'D:/P/P.uproject -A=2', 'prefix matching is case-insensitive and never touches the uproject argument');
const parsedExtras = parseRunnerArgs(['--extra-arg', '-NoSourceControl', '--extra-arg', '-ddc=X']);
t.assert(parsedExtras.extraArgs.length === 2 && parsedExtras.extraArgs[0] === '-NoSourceControl' && parsedExtras.extraArgs[1] === '-ddc=X', '--extra-arg is repeatable and order-preserving');
t.assert(parseRunnerArgs([]).extraArgs.length === 0, 'no --extra-arg yields an empty list');
let extraErr = null;
try { parseRunnerArgs(['--extra-arg']); } catch (e) { extraErr = e; }
t.assert(extraErr && /--extra-arg/.test(extraErr.message), '--extra-arg without a value throws naming the flag');
t.assert(readFileSync(join(here, 'run-native-tests.mjs'), 'utf8').includes('[--extra-arg <value>]...'), 'the usage line names --extra-arg');
```

Also add `applyExtraArgs` to the import from `./run-native-tests.mjs` at the top of the test file.

- [ ] **Step 2: Run the test file to verify it fails**

Run from `server/`: `node test-native-runner.mjs`
Expected: an import error or assertion failures naming `applyExtraArgs` / `extraArgs` (the export does not exist yet).

- [ ] **Step 3: Implement the parser, the override helper, and the wiring**

In `server/run-native-tests.mjs`:

`parseRunnerArgs` — add `extraArgs: []` to the `out` initialiser and this branch before the `--dry-run` branch:

```js
    else if (a === '--extra-arg') {
      if (i + 1 >= argv.length) throw new Error('--extra-arg needs a value (an argument for UnrealEditor-Cmd)');
      out.extraArgs.push(argv[++i]);
    }
```

Add this exported function directly above `buildEditorCommand`:

```js
/**
 * Merges caller-supplied editor arguments into the standard list. Unreal's
 * FParse::Value takes the FIRST -Name= occurrence, so an extra that shares a
 * -Name= prefix with a standard argument replaces it in place (case-insensitive,
 * never the uproject at index 0); every other extra appends in the order given.
 */
export function applyExtraArgs(standardArgs, extraArgs) {
  const args = [...standardArgs];
  for (const extra of extraArgs) {
    const eq = extra.indexOf('=');
    const prefix = extra.startsWith('-') && eq > 0 ? extra.slice(0, eq + 1).toLowerCase() : null;
    const at = prefix ? args.findIndex((a, i) => i > 0 && a.toLowerCase().startsWith(prefix)) : -1;
    if (at >= 0) args[at] = extra;
    else args.push(extra);
  }
  return args;
}
```

In `buildEditorCommand`, replace the `args: [ ... ]` literal so it reads:

```js
    args: applyExtraArgs([
      uprojectPath,
      `-ExecCmds=Automation RunTests ${filter};Quit`,
      '-TestExit=Automation Test Queue Empty',
      `-ReportExportPath=${reportDir}`,
      '-unattended', '-nopause', '-nosplash', '-nullrhi', '-NoSound', '-nop4', '-log', '-stdout', '-FullStdOutLogOutput',
    ], extraArgs),
```

Usage line (`:118`): append ` [--extra-arg <value>]...` before the closing quote. `main`'s call (`:130`): `buildEditorCommand({ engineRoot, uprojectPath, filter: args.filter, reportDir, extraArgs: args.extraArgs })`.

- [ ] **Step 4: Run the test file and the rotation**

Run from `server/`: `node test-native-runner.mjs` → all PASS, 8 more than before. Then `node run-rotation.mjs` → 7,797 across 80 files, all PASS; `npx eslint .` silent.

- [ ] **Step 5: Document and commit**

In `CLAUDE.md`, in the sentence that begins `Run them with \`run-native-tests.bat [--profile <name>] [--target <alias>]\``, append after `\`--dry-run\` prints the command)`: ` — \`--extra-arg <value>\`, repeatable, forwards an argument to \`UnrealEditor-Cmd\`; an extra of the form \`-Name=value\` replaces the runner's own argument with that prefix (Unreal reads the first occurrence), anything else appends`. Run `cd server && node test-slash-command-anchors.mjs` (CLAUDE.md-reading suite) → PASS.

```bash
git add server/run-native-tests.mjs server/test-native-runner.mjs CLAUDE.md
git commit -m "Add --extra-arg to the native test runner: repeatable, replacing a same-prefix standard argument in place"
```

---

### Task 2: `EnsureEventNodeEnabled`, the timer's ghost reuse, and the reproduction test

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h` (declaration, after `FormatLiteralForPinCategory`)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp` (definition; add `#include "K2Node_Event.h"`)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp:901-935` (`FindOrCreateReceiveBeginPlay`), `:2666-2668` (locals), `:2692` (call), `:2720-2739` (modified mark and result)
- Test: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` (new test, appended at the end of the file inside the existing `#if WITH_DEV_AUTOMATION_TESTS` guard)

**Interfaces:**
- Consumes: `IsAutomaticallyPlacedGhostNode()` and `SetEnabledState(ENodeEnabledState, bool bUserAction)` on `UEdGraphNode` (engine).
- Produces: `bool UEMCP::EnsureEventNodeEnabled(UK2Node_Event* EventNode)` — Task 3 calls it at two more sites. `FindOrCreateReceiveBeginPlay(UBlueprint*, UEdGraph*, bool& bCreated, bool& bOutEnabledGhost, TSharedPtr<FJsonObject>&)`. Response field `enabled_ghost: true` (omitted when false) on `add_blueprint_timer`.

- [ ] **Step 1: Write the failing test**

Append to `UEMCPBlueprintHandlerTests.cpp` before the file's closing `#endif`:

```cpp
// =====================================================================================
// Ghost BeginPlay (BUG-2, bullet 4). A fresh Actor Blueprint on stock settings
// carries an auto-placed, disabled ReceiveBeginPlay. FEdGraphUtilities::CloneGraph
// drops disabled nodes from a non-transient graph when cloning for compilation, so a
// timer wired under the ghost compiled to nothing. The observable is the function
// stub the compiler creates only for an enabled event: after the fix the generated
// class implements ReceiveBeginPlay itself; before it, it does not.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersGhostBeginPlayEnabledTest,
	"UEMCP.BlueprintHandlers.GhostBeginPlayEnabled",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersGhostBeginPlayEnabledTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	UEdGraph* EventGraph = Fixture.Blueprint->UbergraphPages.Num() > 0 ? Fixture.Blueprint->UbergraphPages[0] : nullptr;
	UK2Node_Event* Ghost = nullptr;
	if (EventGraph)
	{
		for (UEdGraphNode* Node : EventGraph->Nodes)
		{
			if (UK2Node_Event* Ev = Cast<UK2Node_Event>(Node); Ev && Ev->EventReference.GetMemberName() == FName(TEXT("ReceiveBeginPlay")))
			{
				Ghost = Ev;
				break;
			}
		}
	}
	if (!EventGraph || !Ghost)
	{
		AddError(TEXT("fixture has no event graph with a default ReceiveBeginPlay node"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	// Preconditions the mechanism depends on: the node is a ghost, and the graph is
	// not transient (CloneGraph only drops disabled nodes from non-transient graphs).
	TestTrue(TEXT("fixture ReceiveBeginPlay is an auto-placed ghost"), Ghost->IsAutomaticallyPlacedGhostNode());
	TestFalse(TEXT("fixture event graph is not RF_Transient"), EventGraph->HasAnyFlags(RF_Transient));
	const FString GhostId = Ghost->NodeGuid.ToString();

	TSharedPtr<FJsonObject> TimerParams = MakeShared<FJsonObject>();
	TimerParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	TimerParams->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPGhostTimer"));
	TimerParams->SetNumberField(TEXT("interval"), 1.0);
	TimerParams->SetBoolField(TEXT("create_callback_graph"), true);
	TimerParams->SetBoolField(TEXT("insert_on_begin_play"), true);
	TimerParams->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> Response = Dispatch(TEXT("add_blueprint_timer"), TimerParams);
	FString Code;
	if (!IsSuccess(Response, Code))
	{
		AddError(FString::Printf(TEXT("add_blueprint_timer failed: %s"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> Result = ResultOf(Response);
	TestEqual(TEXT("the reused node is the ghost"), Result->GetStringField(TEXT("begin_play_node_id")), GhostId);
	TestTrue(TEXT("response reports enabled_ghost"), Result->HasField(TEXT("enabled_ghost")) && Result->GetBoolField(TEXT("enabled_ghost")));
	TestTrue(TEXT("the node is enabled"), Ghost->IsNodeEnabled());
	TestFalse(TEXT("the node is no longer a ghost"), Ghost->IsAutomaticallyPlacedGhostNode());
	TestTrue(TEXT("compiled_ok"), Result->GetBoolField(TEXT("compiled_ok")));

	UClass* Generated = Fixture.Blueprint->GeneratedClass;
	UFunction* Stub = Generated ? Generated->FindFunctionByName(TEXT("ReceiveBeginPlay"), EIncludeSuperFlag::ExcludeSuper) : nullptr;
	TestNotNull(TEXT("the compiled class implements ReceiveBeginPlay (the chain was not dropped)"), Stub);

	// A second reuse of the now-enabled node reports nothing: the field is a fact
	// about this call, not a property of the node.
	TimerParams->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPGhostTimerAgain"));
	const TSharedPtr<FJsonObject> Second = Dispatch(TEXT("add_blueprint_timer"), TimerParams);
	if (IsSuccess(Second, Code))
	{
		TestFalse(TEXT("second dispatch omits enabled_ghost"), ResultOf(Second)->HasField(TEXT("enabled_ghost")));
	}
	else
	{
		AddError(FString::Printf(TEXT("second add_blueprint_timer failed: %s"), *Code));
	}

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Add the helper as a stub that changes nothing, wire it through, and run the red step**

Declare in `BlueprintHandlerHelpers.h` after `FormatLiteralForPinCategory` (add `class UK2Node_Event;` with the other forward declarations at the top):

```cpp
	/**
	 * Enables an auto-placed ghost event node in place. A fresh Actor Blueprint on
	 * stock settings carries a disabled ReceiveBeginPlay that FEdGraphUtilities::
	 * CloneGraph drops at compile time together with everything wired below it, so
	 * reusing it as-is produced dead code with no error. Returns true when the node
	 * was such a ghost and is now enabled; false (and no change) for a null node or
	 * one whose enabled state the user set.
	 */
	bool EnsureEventNodeEnabled(UK2Node_Event* EventNode);
```

Define in `BlueprintHandlerHelpers.cpp` (add `#include "K2Node_Event.h"`), **for the red step only**, as a stub:

```cpp
bool EnsureEventNodeEnabled(UK2Node_Event* EventNode)
{
	return false;
}
```

In `BlueprintHandlers.cpp`, change `FindOrCreateReceiveBeginPlay`'s signature and first branch to:

```cpp
UK2Node_Event* FindOrCreateReceiveBeginPlay(UBlueprint* Blueprint, UEdGraph* EventGraph,
	bool& bCreated, bool& bOutEnabledGhost, TSharedPtr<FJsonObject>& OutResponse)
{
	bCreated = false;
	bOutEnabledGhost = false;
	if (UK2Node_Event* Existing = FindExistingEventNode(EventGraph, TEXT("ReceiveBeginPlay")))
	{
		bOutEnabledGhost = EnsureEventNodeEnabled(Existing);
		return Existing;
	}
```

(the rest of the function is unchanged). In `HandleAddBlueprintTimer`: next to `bool bBeginPlayCreated = false;` add `bool bEnabledGhost = false;`; change the call to `FindOrCreateReceiveBeginPlay(Blueprint, EventGraph, bBeginPlayCreated, bEnabledGhost, OutResponse)`; directly after `FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);` (the one before the compile block) add:

```cpp
	if (bEnabledGhost)
	{
		// Enabling an event changes the class layout (the compiler adds a stub), so a
		// structural mark is the honest one; the compile below picks it up.
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	}
```

and directly after the `begin_play_node_id` block in the result construction add:

```cpp
	if (bEnabledGhost)
	{
		Result->SetBoolField(TEXT("enabled_ghost"), true);
	}
```

Run the sample deploy cycle. Expected: `Result: Succeeded`; the runner reports `35 passed, 0 failed` **minus** this test: `UEMCP.BlueprintHandlers.GhostBeginPlayEnabled` must FAIL on "response reports enabled_ghost", "the node is enabled", "the node is no longer a ghost", and "the compiled class implements ReceiveBeginPlay". Quote the runner's FAIL line and the four error messages in the report.

**If the "compiled class implements ReceiveBeginPlay" assertion does NOT fail with the stub in place, stop and report BLOCKED**: the observable is wrong and the fix cannot be proved by this test. Do not proceed to Step 3.

- [ ] **Step 3: Implement the helper**

Replace the stub in `BlueprintHandlerHelpers.cpp`:

```cpp
bool EnsureEventNodeEnabled(UK2Node_Event* EventNode)
{
	if (!EventNode || !EventNode->IsAutomaticallyPlacedGhostNode())
	{
		return false;
	}
	EventNode->Modify();
	EventNode->SetEnabledState(ENodeEnabledState::Enabled, /*bUserAction=*/true);
	return true;
}
```

- [ ] **Step 4: Run the sample deploy cycle to verify it passes**

Expected: `Native tests: 35 passed, 0 failed, 0 not run`, `Labelled skips: 3`. Quote both the red run (Step 2) and this green run in the report.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -m "Enable the ghost ReceiveBeginPlay in place when add_blueprint_timer reuses it: the compiler dropped the chain"
```

---

### Task 3: The other two event-reuse sites report `enabled_ghost`

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp:1739-1748` (`HandleAddBlueprintEventNode` dedup branch), `:1994-2001` (`HandleOverrideBlueprintParentMember` reuse branch)
- Test: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` (new test appended after `GhostBeginPlayEnabled`)

**Interfaces:**
- Consumes: `EnsureEventNodeEnabled` from Task 2 (call it unqualified, the way the file calls `PinToJson`).
- Produces: `enabled_ghost: true` on `add_blueprint_event_node` and `override_blueprint_parent_member` success results when the reused node was a ghost.

- [ ] **Step 1: Write the failing test**

```cpp
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersEventNodeGhostSitesTest,
	"UEMCP.BlueprintHandlers.EventNodeGhostSites",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersEventNodeGhostSitesTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	FString Code;

	// add_blueprint_event_node dedups against the ghost ReceiveBeginPlay.
	TSharedPtr<FJsonObject> EventParams = MakeShared<FJsonObject>();
	EventParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	EventParams->SetStringField(TEXT("event_name"), TEXT("ReceiveBeginPlay"));
	const TSharedPtr<FJsonObject> EventResponse = Dispatch(TEXT("add_blueprint_event_node"), EventParams);
	if (IsSuccess(EventResponse, Code))
	{
		const TSharedPtr<FJsonObject> Result = ResultOf(EventResponse);
		TestTrue(TEXT("add_blueprint_event_node reports enabled_ghost"), Result->HasField(TEXT("enabled_ghost")) && Result->GetBoolField(TEXT("enabled_ghost")));
		const TSharedPtr<FJsonObject> Again = Dispatch(TEXT("add_blueprint_event_node"), EventParams);
		TestTrue(TEXT("second add_blueprint_event_node succeeds"), IsSuccess(Again, Code));
		TestFalse(TEXT("second add_blueprint_event_node omits enabled_ghost"), ResultOf(Again)->HasField(TEXT("enabled_ghost")));
	}
	else
	{
		AddError(FString::Printf(TEXT("add_blueprint_event_node failed: %s"), *Code));
	}

	// override_blueprint_parent_member reuses the ghost ReceiveTick the same way.
	TSharedPtr<FJsonObject> OverrideParams = MakeShared<FJsonObject>();
	OverrideParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	OverrideParams->SetStringField(TEXT("member_name"), TEXT("ReceiveTick"));
	const TSharedPtr<FJsonObject> OverrideResponse = Dispatch(TEXT("override_blueprint_parent_member"), OverrideParams);
	if (IsSuccess(OverrideResponse, Code))
	{
		const TSharedPtr<FJsonObject> Result = ResultOf(OverrideResponse);
		TestTrue(TEXT("override reports already_present"), Result->GetBoolField(TEXT("already_present")));
		TestTrue(TEXT("override reports enabled_ghost"), Result->HasField(TEXT("enabled_ghost")) && Result->GetBoolField(TEXT("enabled_ghost")));
	}
	else
	{
		AddError(FString::Printf(TEXT("override_blueprint_parent_member failed: %s"), *Code));
	}

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Run the sample deploy cycle to verify it fails**

Expected: 36 tests run; `EventNodeGhostSites` FAILS on both "reports enabled_ghost" assertions (the fields are absent). If `override_blueprint_parent_member` fails with an error code instead, quote it and check the fixture actually carries a ghost `ReceiveTick` (the `TimerFailures` comment at `:1789` lists the three default ghosts); report BLOCKED rather than changing the assertion.

- [ ] **Step 3: Implement both sites**

`HandleAddBlueprintEventNode`, the dedup branch, becomes:

```cpp
			// Dedup: return existing event GUID if one already exists for this name.
			// An auto-placed ghost is enabled first: reused as-is it compiles to nothing.
			if (UK2Node_Event* Existing = FindExistingEventNode(EventGraph, EventName))
			{
				const bool bEnabledGhost = EnsureEventNodeEnabled(Existing);
				if (bEnabledGhost)
				{
					FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
				}
				TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
				Result->SetStringField(TEXT("node_id"), Existing->NodeGuid.ToString());
				Result->SetStringField(TEXT("graph_name"), EventGraph->GetName());
				Result->SetStringField(TEXT("node_class"), Existing->GetClass()->GetName());
				Result->SetArrayField(TEXT("pins"), PinsToJson(Existing));
				if (bEnabledGhost)
				{
					Result->SetBoolField(TEXT("enabled_ghost"), true);
				}
				BuildSuccessResponse(OutResponse, Result);
				return;
			}
```

`HandleOverrideBlueprintParentMember`, the reuse branch, becomes:

```cpp
				if (UK2Node_Event* Existing = FindExistingEventNode(EventGraph, MemberName))
				{
					const bool bEnabledGhost = EnsureEventNodeEnabled(Existing);
					if (bEnabledGhost)
					{
						FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
					}
					TSharedPtr<FJsonObject> Result = NodeResultToJson(Existing, EventGraph);
					Result->SetStringField(TEXT("member_kind"), TEXT("event"));
					Result->SetBoolField(TEXT("already_present"), true);
					if (bEnabledGhost)
					{
						Result->SetBoolField(TEXT("enabled_ghost"), true);
					}
					BuildSuccessResponse(OutResponse, Result);
					return;
				}
```

- [ ] **Step 4: Run the sample deploy cycle to verify it passes**

Expected: `Native tests: 36 passed, 0 failed, 0 not run`, `Labelled skips: 3`.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -m "Enable a reused ghost event in add_blueprint_event_node and override_blueprint_parent_member, reporting enabled_ghost"
```

---

### Task 4: `target_pin_info` after the break; vector literal element validation

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp:3203` (remove the early `TargetPinJson = PinToJson(TargetPin);`), `:3217-3231` (add it after the break)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp:152-170` (`SetSupportedVariableDefault`'s vector branch), `:238-252` (`FormatLiteralForPinCategory`'s vector branch), plus one file-scope static helper
- Test: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp:758-767` (the `DisconnectPin` test's `target_pin_info` block; also update the comment at `:1416`); `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp` (`LiteralDefaults`, after the "vector literal formatting" assertion)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `target_pin_info.link_count` is the post-break value; `FormatLiteralForPinCategory` returns `LITERAL_TYPE_MISMATCH` for a non-numeric vector element, with `OutError` naming `element N`.

- [ ] **Step 1: Write the failing assertions**

In the `DisconnectPin` test, inside the `if (BreakResult->TryGetObjectField(TEXT("target_pin_info"), ...))` block after the "target_pin_info direction" assertion:

```cpp
		// After a real targeted break the target pin has no links left, and the
		// response must say so in both pin blocks (BUG-2, bullet 1).
		TestEqual(TEXT("target_pin_info link_count is the post-break value"),
			(int32)(*TargetPinInfo)->GetNumberField(TEXT("link_count")), 0);
```

In `LiteralDefaults`, after `TestEqual(TEXT("vector literal formatting"), ...)`:

```cpp
	TArray<TSharedPtr<FJsonValue>> Mixed;
	Mixed.Add(JsonNumber(1.0));
	Mixed.Add(JsonString(TEXT("a")));
	Mixed.Add(JsonNumber(3.0));
	TestFalse(TEXT("vector literal rejects a non-numeric element"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, MakeShared<FJsonValueArray>(Mixed), Default, Error, Code));
	TestEqual(TEXT("vector element mismatch code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));
	TestTrue(TEXT("vector element mismatch names the element"), Error.Contains(TEXT("element 1")));
```

Update the comment at `UEMCPBlueprintHandlerTests.cpp:1416` (which says the test deliberately asserts only name and direction on `target_pin_info`) to: `// link_count on target_pin_info is asserted in DisconnectPin, where a real break happens; this dry run only checks identity.`

- [ ] **Step 2: Run the sample deploy cycle to verify it fails**

Expected: `DisconnectPin` FAILS on "target_pin_info link_count is the post-break value" (reports 1); `LiteralDefaults` FAILS on "vector literal rejects a non-numeric element" (it formats `0.000000` and returns true).

- [ ] **Step 3: Implement**

`BlueprintHandlers.cpp`: delete the line `TargetPinJson = PinToJson(TargetPin);` inside the target-resolution block (`:3203`), and change the break block to:

```cpp
	int32 LinksBroken = 0;
	if (!bDryRun && LinksMatched > 0)
	{
		if (TargetPin)
		{
			const int32 Before = Pin->LinkedTo.Num();
			Pin->BreakLinkTo(TargetPin);
			LinksBroken = FMath::Max(0, Before - Pin->LinkedTo.Num());
		}
		else
		{
			Pin->BreakAllPinLinks(true);
			LinksBroken = LinksMatched;
		}
	}
	// Both pin blocks describe the graph after the break (or after nothing, on a dry
	// run), so their link counts agree.
	if (TargetPin)
	{
		TargetPinJson = PinToJson(TargetPin);
	}
```

`BlueprintHandlerHelpers.cpp`: add at file scope, above `SetSupportedVariableDefault`:

```cpp
/** Reads [x, y, z] as three numbers; on failure OutBadIndex names the first offender. */
static bool ReadVectorComponents(const TArray<TSharedPtr<FJsonValue>>& Arr, double& X, double& Y, double& Z, int32& OutBadIndex)
{
	double* Slots[3] = { &X, &Y, &Z };
	for (int32 Index = 0; Index < 3; ++Index)
	{
		if (Index >= Arr.Num() || !Arr[Index].IsValid() || !Arr[Index]->TryGetNumber(*Slots[Index]))
		{
			OutBadIndex = Index;
			return false;
		}
	}
	return true;
}
```

In `SetSupportedVariableDefault`'s vector branch replace the `double X = 0.0; ... if (!Arr[0].IsValid() || ...)` block with:

```cpp
			double X = 0.0;
			double Y = 0.0;
			double Z = 0.0;
			int32 BadIndex = 0;
			if (!ReadVectorComponents(Arr, X, Y, Z, BadIndex))
			{
				OutErrorMessage = FString::Printf(TEXT("Vector default for variable '%s' must contain only numbers"),
					*Property->GetName());
				return false;
			}
```

In `FormatLiteralForPinCategory`'s vector branch replace the `OutDefaultValue = FString::Printf(... (*Arr)[0]->AsNumber() ...)` statement with:

```cpp
			double X = 0.0;
			double Y = 0.0;
			double Z = 0.0;
			int32 BadIndex = 0;
			if (!ReadVectorComponents(*Arr, X, Y, Z, BadIndex))
			{
				OutError = FString::Printf(TEXT("Vector variable assignment requires [x, y, z] numeric literal; element %d is not a number"), BadIndex);
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"), X, Y, Z);
			return true;
```

- [ ] **Step 4: Run the sample deploy cycle to verify it passes**

Expected: `Native tests: 36 passed, 0 failed, 0 not run`, `Labelled skips: 3`. Also run `cd server && node test-anon-namespace-audit.mjs` → PASS (the new helper is `static`, not an anonymous-namespace duplicate).

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp
git commit -m "Report target_pin_info after the break and reject non-numeric vector literal elements"
```

---

### Task 5: `add_blueprint_variable_assignment` fails the call when its compile fails

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp:2540-2546` (compile block), `:2576-2581` (result tail)
- Test: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` (new test appended after `EventNodeGhostSites`)

**Interfaces:**
- Consumes: `BuildBlueprintCompileDiagnosticResult(UBlueprint*, const FString&)` and `RemoveCreatedAssignmentNodes(UBlueprint*, UEdGraphNode*, UEdGraphNode*)`, both already in the file. The handler never creates the variable (it returns `VARIABLE_NOT_FOUND` otherwise), so the rollback is the two nodes only — the spec's "the variable itself if this call created it" has no case.
- Produces: `COMPILE_FAILED` with the result as detail, `compiled === false` and `requires_compile === true` on that path; `compiled_ok` and `compile` fields on every compiled result.

- [ ] **Step 1: Write the failing test**

`AddFixtureVariable(UBlueprint*, const FString&, FName Category, FName SubCategory = NAME_None)` at `UEMCPBlueprintHandlerTests.cpp:~100` wraps `FBlueprintEditorUtils::AddMemberVariable`; the `AddVariableAssignment` test at `:325` calls it the same way.

```cpp
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersAssignmentCompileFailedTest,
	"UEMCP.BlueprintHandlers.AssignmentCompileFailed",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersAssignmentCompileFailedTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	AddFixtureVariable(Fixture.Blueprint, TEXT("Score"), UEdGraphSchema_K2::PC_Int);
	UEdGraph* EventGraph = Fixture.Blueprint->UbergraphPages.Num() > 0 ? Fixture.Blueprint->UbergraphPages[0] : nullptr;
	UK2Node_Event* ExistingBeginPlay = nullptr;
	if (EventGraph)
	{
		for (UEdGraphNode* Node : EventGraph->Nodes)
		{
			if (UK2Node_Event* Ev = Cast<UK2Node_Event>(Node); Ev && Ev->EventReference.GetMemberName() == FName(TEXT("ReceiveBeginPlay")))
			{
				ExistingBeginPlay = Ev;
				break;
			}
		}
	}
	if (!EventGraph || !ExistingBeginPlay)
	{
		AddError(TEXT("fixture has no event graph with a default ReceiveBeginPlay node"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// Plant an unresolvable call under BeginPlay, exactly as TimerFailures does:
	// ValidateNodeDuringCompilation reports it as an error, so any compile fails.
	UK2Node_CallFunction* BrokenCallNode = NewObject<UK2Node_CallFunction>(EventGraph);
	BrokenCallNode->FunctionReference.SetExternalMember(
		FName(TEXT("UEMCPFunctionThatDoesNotExist")), UKismetSystemLibrary::StaticClass());
	EventGraph->AddNode(BrokenCallNode);
	BrokenCallNode->CreateNewGuid();
	BrokenCallNode->PostPlacedNewNode();
	BrokenCallNode->AllocateDefaultPins();
	UEdGraphPin* BrokenExecPin = BrokenCallNode->CreatePin(EGPD_Input, UEdGraphSchema_K2::PC_Exec, UEdGraphSchema_K2::PN_Execute);
	UEdGraphPin* ExistingThenPin = FindFixturePin(ExistingBeginPlay, {TEXT("then")}, EGPD_Output);
	if (!BrokenExecPin || !ExistingThenPin)
	{
		AddError(TEXT("could not wire the planted node into the BeginPlay exec chain"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	ExistingThenPin->MakeLinkTo(BrokenExecPin);

	auto CountSetNodes = [EventGraph]()
	{
		int32 Count = 0;
		for (UEdGraphNode* Node : EventGraph->Nodes)
		{
			if (Cast<UK2Node_VariableSet>(Node)) { ++Count; }
		}
		return Count;
	};
	const int32 SetNodesBefore = CountSetNodes();

	TSharedPtr<FJsonObject> Assignment = MakeShared<FJsonObject>();
	Assignment->SetStringField(TEXT("kind"), TEXT("literal"));
	Assignment->SetNumberField(TEXT("value"), 5);
	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Params->SetStringField(TEXT("target_variable"), TEXT("Score"));
	Params->SetObjectField(TEXT("assignment"), Assignment);
	Params->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> Response = Dispatch(TEXT("add_blueprint_variable_assignment"), Params);
	TestEqual(TEXT("compile failure code"), ErrorCodeOf(Response), FString(TEXT("COMPILE_FAILED")));
	const TSharedPtr<FJsonObject>* Detail = nullptr;
	if (Response.IsValid() && Response->TryGetObjectField(TEXT("detail"), Detail) && Detail)
	{
		TestFalse(TEXT("detail reports compiled false"), (*Detail)->GetBoolField(TEXT("compiled")));
		TestTrue(TEXT("detail keeps requires_compile true"), (*Detail)->GetBoolField(TEXT("requires_compile")));
		TestFalse(TEXT("detail reports compiled_ok false"), (*Detail)->GetBoolField(TEXT("compiled_ok")));
	}
	else
	{
		AddError(TEXT("COMPILE_FAILED carried no detail object"));
	}
	TestEqual(TEXT("the authored set node was rolled back"), CountSetNodes(), SetNodesBefore);

	// Without compile the same call succeeds and says a compile is still owed.
	Params->SetBoolField(TEXT("compile"), false);
	const TSharedPtr<FJsonObject> NoCompile = Dispatch(TEXT("add_blueprint_variable_assignment"), Params);
	FString Code;
	if (IsSuccess(NoCompile, Code))
	{
		TestTrue(TEXT("requires_compile without compile"), ResultOf(NoCompile)->GetBoolField(TEXT("requires_compile")));
		TestFalse(TEXT("compiled false without compile"), ResultOf(NoCompile)->GetBoolField(TEXT("compiled")));
	}
	else
	{
		AddError(FString::Printf(TEXT("assignment without compile failed: %s"), *Code));
	}

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Run the sample deploy cycle to verify it fails**

Expected: 37 tests; `AssignmentCompileFailed` FAILS on "compile failure code" (the handler returns success today) and on "the authored set node was rolled back".

- [ ] **Step 3: Implement**

Replace the compile block (`:2540-2546`) with:

```cpp
			bool bCompile = false;
			Params->TryGetBoolField(TEXT("compile"), bCompile);
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			TSharedPtr<FJsonObject> CompileResult;
			bool bCompiledOk = false;
			if (bCompile)
			{
				CompileResult = BuildBlueprintCompileDiagnosticResult(Blueprint, Blueprint->GetName());
				CompileResult->TryGetBoolField(TEXT("compiled_ok"), bCompiledOk);
			}
```

Replace the result tail (the two `SetBoolField` lines and `BuildSuccessResponse`) with:

```cpp
			Result->SetBoolField(TEXT("requires_compile"), !bCompile || !bCompiledOk);
			Result->SetBoolField(TEXT("compiled"), bCompile && bCompiledOk);
			if (CompileResult.IsValid())
			{
				Result->SetBoolField(TEXT("compiled_ok"), bCompiledOk);
				Result->SetObjectField(TEXT("compile"), CompileResult);
			}
			if (bCompile && !bCompiledOk)
			{
				// Same contract as add_blueprint_timer: a call whose compile failed
				// leaves nothing behind and says so, instead of reporting success.
				RemoveCreatedAssignmentNodes(Blueprint, SetNode, GetNode);
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Blueprint compile failed after adding an assignment to %s"), *TargetVarName),
					TEXT("COMPILE_FAILED"),
					Result);
				return;
			}
			BuildSuccessResponse(OutResponse, Result);
```

The `Nodes`, `Pins` and `Links` arrays are built before this tail from live nodes, so they stay valid in the detail object after the rollback.

- [ ] **Step 4: Run the sample deploy cycle to verify it passes**

Expected: `Native tests: 37 passed, 0 failed, 0 not run`, `Labelled skips: 3`. The existing `AddVariableAssignment`, `AssignmentVariableKind` and `AssignmentExecFrom` tests must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -m "Fail add_blueprint_variable_assignment with COMPILE_FAILED and roll back its nodes when the compile fails"
```

---

### Task 6: `ResolveCaptureOutputPath` confines all three capture tools

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h` (declaration after `DefaultCapturePath`; `FinishCapture`'s signature and comment)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp:210-235` (`FinishCapture`), plus the new function
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp` (`HandleCaptureAssetEditor` around `:60-125`; `HandleCapturePieViewport` around `:250-305`)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/VisualCaptureHandler.cpp:173-175` and `:234-256`
- Modify: `tools.yaml` — `out_png` on the entries `capture_asset_editor` (`:1644`) and `capture_pie_viewport` (`:1688`), `output_path` on `get_viewport_screenshot` (`:1595`)
- Test: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp` (new test appended before the closing `#endif`)

**Interfaces:**
- Consumes: `DefaultCapturePath(const FString& Stem)` (existing).
- Produces: `bool UEMCP::ResolveCaptureOutputPath(const FString& Requested, const FString& DefaultStem, FString& OutAbsolutePath, FString& OutError)`; `bool UEMCP::FinishCapture(const TArray64<uint8>& Png, const FIntPoint& Size, const FString& OutputPath, bool bInline, const TSharedPtr<FJsonObject>& Result, FString& OutErrorMessage)` (takes the resolved absolute path); error code `CAPTURE_PATH_OUTSIDE_PROJECT` on all three tools. Task 7 edits `FinishCapture`'s inline block; keep the new signature.

- [ ] **Step 1: Write the failing test**

```cpp
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureOutputPathTest,
	"UEMCP.AssetEditorCapture.OutputPathConfinement",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureOutputPathTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FString Abs;
	FString Err;
	TestTrue(TEXT("empty request resolves"), UEMCP::ResolveCaptureOutputPath(TEXT(""), TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("empty request lands under Saved/UEMCP/Captures"), Abs.Contains(TEXT("/UEMCP/Captures/")) && Abs.EndsWith(TEXT(".png")));
	TestTrue(TEXT("relative request resolves"), UEMCP::ResolveCaptureOutputPath(TEXT("review/shot"), TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("relative request lands under Captures and gains .png"), Abs.EndsWith(TEXT("/UEMCP/Captures/review/shot.png")));
	TestFalse(TEXT("an escaping relative request is rejected"), UEMCP::ResolveCaptureOutputPath(TEXT("../../../../escape"), TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("the rejection names the path"), Err.Contains(TEXT("escape")));
	const FString EngineSide = FPaths::ConvertRelativePathToFull(FPaths::EngineDir()) / TEXT("outside.png");
	TestFalse(TEXT("an absolute path outside the project is rejected"), UEMCP::ResolveCaptureOutputPath(EngineSide, TEXT("Stem"), Abs, Err));
	const FString Inside = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir()) / TEXT("UEMCP/ok.PNG");
	TestTrue(TEXT("an absolute path inside Saved is accepted"), UEMCP::ResolveCaptureOutputPath(Inside, TEXT("Stem"), Abs, Err));
	TestTrue(TEXT("an upper-case .PNG is kept as given"), Abs.EndsWith(TEXT("ok.PNG")));

	// Handlers check the path before any editor or viewport lookup, so the
	// rejection is reachable headless and wins over ASSET_NOT_FOUND, PIE_NOT_RUNNING
	// and NO_VIEWPORT.
	TSharedPtr<FJsonObject> Escaping = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	Escaping->SetStringField(TEXT("out_png"), TEXT("../../../../escape"));
	TestEqual(TEXT("capture_asset_editor refuses an escaping out_png first"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), Escaping)), FString(TEXT("CAPTURE_PATH_OUTSIDE_PROJECT")));
	TSharedPtr<FJsonObject> PieEscaping = MakeShared<FJsonObject>();
	PieEscaping->SetStringField(TEXT("out_png"), TEXT("../../../../escape"));
	TestEqual(TEXT("capture_pie_viewport refuses an escaping out_png first"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), PieEscaping)), FString(TEXT("CAPTURE_PATH_OUTSIDE_PROJECT")));
	TSharedPtr<FJsonObject> ViewportEscaping = MakeShared<FJsonObject>();
	ViewportEscaping->SetStringField(TEXT("output_path"), TEXT("../../../../escape"));
	TestEqual(TEXT("get_viewport_screenshot refuses an escaping output_path first"),
		CodeOf(Dispatch(TEXT("get_viewport_screenshot"), ViewportEscaping)), FString(TEXT("CAPTURE_PATH_OUTSIDE_PROJECT")));
	return true;
}
```

- [ ] **Step 2: Add the declaration, then run the sample deploy cycle to verify the test fails**

Add to `AssetEditorCapture.h` after `DefaultCapturePath`:

```cpp
	/**
	 * Resolves a requested capture path to an absolute .png inside the project.
	 * Empty: Saved/UEMCP/Captures/<DefaultStem>_<timestamp>.png. Relative: under
	 * Saved/UEMCP/Captures/. Absolute: as given. The result is normalised and
	 * must lie under FPaths::ProjectDir(); anything else fails with OutError and
	 * the handler reports CAPTURE_PATH_OUTSIDE_PROJECT. ".png" is appended when
	 * the name lacks it (case-insensitive), so ".PNG" is kept.
	 */
	bool ResolveCaptureOutputPath(const FString& Requested, const FString& DefaultStem, FString& OutAbsolutePath, FString& OutError);
```

and a first definition in `AssetEditorCapture.cpp` that only returns the old behaviour (`OutAbsolutePath = Requested.IsEmpty() ? DefaultCapturePath(DefaultStem) : Requested; return true;`) so the test compiles. Run the cycle: `OutputPathConfinement` FAILS on the rejection assertions and the three handler assertions.

- [ ] **Step 3: Implement the resolver and route all three tools through it**

`AssetEditorCapture.cpp`, replace the placeholder definition:

```cpp
	bool ResolveCaptureOutputPath(const FString& Requested, const FString& DefaultStem, FString& OutAbsolutePath, FString& OutError)
	{
		FString Candidate;
		if (Requested.IsEmpty())
		{
			Candidate = DefaultCapturePath(DefaultStem);
		}
		else if (FPaths::IsRelative(Requested))
		{
			Candidate = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEMCP"), TEXT("Captures"), Requested);
		}
		else
		{
			Candidate = Requested;
		}
		if (!Candidate.EndsWith(TEXT(".png")))
		{
			Candidate += TEXT(".png");
		}
		FString Full = FPaths::ConvertRelativePathToFull(Candidate);
		FPaths::NormalizeFilename(Full);
		FPaths::CollapseRelativeDirectories(Full);

		FString ProjectRoot = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
		FPaths::NormalizeDirectoryName(ProjectRoot);
		if (!ProjectRoot.EndsWith(TEXT("/")))
		{
			ProjectRoot += TEXT("/");
		}
		if (!Full.StartsWith(ProjectRoot, ESearchCase::IgnoreCase))
		{
			OutError = FString::Printf(TEXT("Capture output path '%s' resolves outside the project directory '%s'"), *Full, *ProjectRoot);
			return false;
		}
		OutAbsolutePath = Full;
		return true;
	}
```

`FinishCapture` becomes (signature in the header updated to match; its comment now says "OutputPath is already resolved by ResolveCaptureOutputPath"):

```cpp
	bool FinishCapture(
		const TArray64<uint8>& Png,
		const FIntPoint& Size,
		const FString& OutputPath,
		bool bInline,
		const TSharedPtr<FJsonObject>& Result,
		FString& OutErrorMessage)
	{
		const FString OutputDir = FPaths::GetPath(OutputPath);
		if (!OutputDir.IsEmpty())
		{
			IFileManager::Get().MakeDirectory(*OutputDir, true);
		}
		if (!FFileHelper::SaveArrayToFile(Png, *OutputPath))
		{
			OutErrorMessage = FString::Printf(TEXT("Failed to write PNG to '%s'"), *OutputPath);
			return false;
		}
		// ... the existing width/height/byte_length/mime/png_path/inline block, unchanged ...
```

`HandleCaptureAssetEditor`: move the `bInline` / `RequestedPath` reads to directly after the `asset_path` read (before `ResolveAssetEditorTarget`), then add:

```cpp
			// A caller-supplied path is checked before any editor lookup so an
			// escaping path is refused even when nothing is open.
			FString OutputPath;
			FString PathError;
			if (!RequestedPath.IsEmpty() && !ResolveCaptureOutputPath(RequestedPath, TEXT(""), OutputPath, PathError))
			{
				BuildErrorResponse(OutResponse, PathError, TEXT("CAPTURE_PATH_OUTSIDE_PROJECT"));
				return;
			}
```

and where the stem is computed, replace the `FinishCapture(Png, Size, RequestedPath, Stem, bInline, Result, ErrorMessage)` call with:

```cpp
			if (OutputPath.IsEmpty())
			{
				OutputPath = DefaultCapturePath(Stem);
			}
			if (!FinishCapture(Png, Size, OutputPath, bInline, Result, ErrorMessage))
```

`HandleCapturePieViewport`: move the `bInline` / `RequestedPath` reads to the top of the handler (before the PIE checks) and resolve immediately:

```cpp
			FString OutputPath;
			FString PathError;
			if (!ResolveCaptureOutputPath(RequestedPath, TEXT("PIE"), OutputPath, PathError))
			{
				BuildErrorResponse(OutResponse, PathError, TEXT("CAPTURE_PATH_OUTSIDE_PROJECT"));
				return;
			}
```

and call `FinishCapture(Png, Size, OutputPath, bInline, Result, ErrorMessage)`.

`VisualCaptureHandler.cpp` (`get_viewport_screenshot`): directly after `SafeParams->TryGetStringField(TEXT("output_path"), OutputFilePath);` add (add `#include "AssetEditorCapture.h"` at the top):

```cpp
			if (!OutputFilePath.IsEmpty())
			{
				FString PathError;
				FString Resolved;
				if (!UEMCP::ResolveCaptureOutputPath(OutputFilePath, TEXT("Viewport"), Resolved, PathError))
				{
					BuildErrorResponse(OutResponse, PathError, TEXT("CAPTURE_PATH_OUTSIDE_PROJECT"));
					return;
				}
				OutputFilePath = Resolved;
			}
```

and delete the `.png` append and `IsRelative` block inside `if (!OutputFilePath.IsEmpty())` further down (keep the `MakeDirectory`, `SaveArrayToFile`, and `file_path` lines).

`tools.yaml`: set the three descriptions to `"Output path: absolute inside the project, or relative to Saved/UEMCP/Captures/ (.png appended if missing). Paths that resolve outside the project are refused with CAPTURE_PATH_OUTSIDE_PROJECT. Default Saved/UEMCP/Captures/<...>_<timestamp>.png"` keeping each entry's existing default leaf text.

- [ ] **Step 4: Run the sample deploy cycle and the Node checks**

Expected: `Native tests: 38 passed, 0 failed, 0 not run`, `Labelled skips: 3`. From `server/`: `node test-tool-metadata.mjs` and `node test-visual-capture-source.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp plugin/UEMCP/Source/UEMCP/Private/VisualCaptureHandler.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp tools.yaml
git commit -m "Confine capture output paths to the project through one shared resolver, checked before any editor lookup"
```

---

### Task 7: Capture coverage: inline helper, headless unsupported, `scrolled`, smoke additions

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h` (declaration; response-shape comment gains `scrolled`)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp` (`FinishCapture`'s inline block → `AppendInlinePng`)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp` (`HandleDetailsPanelScroll`, the result block; the `CaptureUnsupportedHeadless` comment pointer is in the test file)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp` (two new tests; one comment on `CaptureUnsupportedHeadless`)
- Modify: `server/live-smoke-asset-editor-capture.mjs:103-109` and `:136`
- Modify: `tools.yaml` `details_panel_scroll` description (`:1671`)

**Interfaces:**
- Consumes: `FinishCapture` with Task 6's signature; `CaptureWidgetToPng` (existing).
- Produces: `void UEMCP::AppendInlinePng(const TSharedRef<FJsonObject>& Result, const TArray64<uint8>& Png, int64 MaxBase64Bytes)`; `scrolled: bool` on `details_panel_scroll`.

- [ ] **Step 1: Write the failing tests**

```cpp
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureInlinePngCapTest,
	"UEMCP.AssetEditorCapture.InlinePngCap",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureInlinePngCapTest::RunTest(const FString& Parameters)
{
	TArray64<uint8> Buffer;
	Buffer.SetNumUninitialized(32);
	for (int32 Index = 0; Index < 32; ++Index)
	{
		Buffer[Index] = static_cast<uint8>(Index * 7);
	}
	// 32 bytes encode to 44 base64 characters: a cap of 16 is over, 64 is under.
	TSharedRef<FJsonObject> Over = MakeShared<FJsonObject>();
	UEMCP::AppendInlinePng(Over, Buffer, 16);
	TestEqual(TEXT("over the cap reports inline_omitted"), Over->GetStringField(TEXT("inline_omitted")), FString(TEXT("too_large")));
	TestFalse(TEXT("over the cap carries no png_base64"), Over->HasField(TEXT("png_base64")));

	TSharedRef<FJsonObject> Under = MakeShared<FJsonObject>();
	UEMCP::AppendInlinePng(Under, Buffer, 64);
	TestFalse(TEXT("under the cap carries no inline_omitted"), Under->HasField(TEXT("inline_omitted")));
	TArray<uint8> Decoded;
	TestTrue(TEXT("png_base64 decodes"), FBase64::Decode(Under->GetStringField(TEXT("png_base64")), Decoded));
	TestEqual(TEXT("decoded length matches"), Decoded.Num(), 32);
	TestTrue(TEXT("decoded bytes match"), Decoded.Num() == 32 && FMemory::Memcmp(Decoded.GetData(), Buffer.GetData(), 32) == 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureUnsupportedHelperTest,
	"UEMCP.AssetEditorCapture.CaptureUnsupportedHelper",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureUnsupportedHelperTest::RunTest(const FString& Parameters)
{
	if (FApp::CanEverRender())
	{
		AddInfo(TEXT("skipped: a renderer is present, so CAPTURE_UNSUPPORTED is not the expected outcome"));
		return true;
	}
	TArray64<uint8> Png;
	FIntPoint Size(0, 0);
	FString Code;
	FString Message;
	TestFalse(TEXT("CaptureWidgetToPng refuses without a renderer"),
		UEMCP::CaptureWidgetToPng(SNullWidget::NullWidget, Png, Size, Code, Message));
	TestEqual(TEXT("the helper reports CAPTURE_UNSUPPORTED"), Code, FString(TEXT("CAPTURE_UNSUPPORTED")));
	TestEqual(TEXT("no bytes are produced"), (int64)Png.Num(), (int64)0);
	return true;
}
```

Add `#include "Widgets/SNullWidget.h"` and `#include "Misc/Base64.h"` to the test file's includes. In `CaptureUnsupportedHeadless`'s labelled-skip branch, add the comment `// The helper-level path is asserted by CaptureUnsupportedHelper; this handler path stays a labelled skip headless.`

- [ ] **Step 2: Run the sample deploy cycle to verify it fails**

Expected: compile error on `AppendInlinePng` (undeclared). Add the declaration to `AssetEditorCapture.h` after `FinishCapture`:

```cpp
	/**
	 * Attaches png_base64, or inline_omitted = "too_large" when the encoded
	 * length would exceed MaxBase64Bytes. Split out so the over-cap branch can be
	 * tested with a fabricated buffer instead of a 6 MiB capture.
	 */
	void AppendInlinePng(const TSharedRef<FJsonObject>& Result, const TArray64<uint8>& Png, int64 MaxBase64Bytes);
```

and a definition that does nothing; rerun: `InlinePngCap` FAILS on both branches; `CaptureUnsupportedHelper` PASSES already (it tests existing behaviour) — note that in the report; it is a regression pin, not a red-green pair.

- [ ] **Step 3: Implement**

`AssetEditorCapture.cpp`:

```cpp
	void AppendInlinePng(const TSharedRef<FJsonObject>& Result, const TArray64<uint8>& Png, int64 MaxBase64Bytes)
	{
		const int64 Base64Length = ((static_cast<int64>(Png.Num()) + 2) / 3) * 4;
		if (Base64Length > MaxBase64Bytes)
		{
			Result->SetStringField(TEXT("inline_omitted"), TEXT("too_large"));
			return;
		}
		Result->SetStringField(TEXT("png_base64"), FBase64::Encode(Png.GetData(), static_cast<uint32>(Png.Num())));
	}
```

In `FinishCapture`, replace the `if (bInline) { ... }` block with `if (bInline) { AppendInlinePng(Result.ToSharedRef(), Png, InlineBase64MaxBytes); }`.

`HandleDetailsPanelScroll`: after `Result->SetNumberField(TEXT("max_row_offset"), MaxRowOffset);` add `Result->SetBoolField(TEXT("scrolled"), bFoundRow);`. In the header's response-shape comment change `details_panel_scroll       { row_offset, requested_row_offset, max_row_offset }` to include `, scrolled`. `tools.yaml` `details_panel_scroll` description: append ` scrolled is false when no property row exists at or after the clamped offset (row_offset then reports the clamp).`

`server/live-smoke-asset-editor-capture.mjs`: after `reportCapture('capture-details', detailsCapture);` add:

```js
    // EN-29 (b): the inline arm has never run outside this smoke. Decode it and
    // hold it to byte_length.
    const inlineCapture = await call('capture_asset_editor',
      { asset_path: assetPath, tab_id: detailsTabId, inline: true });
    reportCapture('capture-details-inline', inlineCapture);
    if (inlineCapture.inline_omitted) {
      console.log(`[inline] omitted: ${inlineCapture.inline_omitted} (${inlineCapture.byte_length} bytes)`);
    } else {
      const decoded = Buffer.from(inlineCapture.png_base64 || '', 'base64');
      if (decoded.length !== inlineCapture.byte_length) {
        throw new Error(`inline PNG decoded to ${decoded.length} bytes but byte_length says ${inlineCapture.byte_length}`);
      }
      console.log(`[inline] png_base64 decodes to ${decoded.length} bytes, matching byte_length`);
    }
    // EN-29 (c): an over-range scroll clamps and says whether it landed on a
    // property row. Whether the last row is a property row depends on the panel,
    // so scrolled is logged and type-checked rather than asserted false.
    const overRange = await call('details_panel_scroll',
      { asset_path: assetPath, tab_id: detailsTabId, row_offset: 100000 });
    console.log(`[details] over-range scroll: scrolled=${overRange.scrolled} row_offset=${overRange.row_offset} max=${overRange.max_row_offset}`);
    if (typeof overRange.scrolled !== 'boolean') throw new Error('details_panel_scroll response carries no scrolled boolean');
    if (overRange.row_offset > overRange.max_row_offset) throw new Error('over-range scroll reported a row beyond max_row_offset');
```

and change the PASS line to `PASS — 4 PNGs written with non-zero size`.

- [ ] **Step 4: Run the sample deploy cycle and the Node checks**

Expected: `Native tests: 40 passed, 0 failed, 0 not run`, `Labelled skips: 3` (the new helper test skips only when a renderer is present, which it is not under the runner). From `server/`: `npx eslint .` silent; `node test-tool-metadata.mjs` PASS. Do not run the live smoke; the orchestrator runs it with a GUI editor.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp server/live-smoke-asset-editor-capture.mjs tools.yaml
git commit -m "Close the capture coverage gaps: inline cap helper, headless CAPTURE_UNSUPPORTED at the helper, scrolled flag, smoke checks"
```

---

### Task 8: Version bump, docs, backlog, D-log

**Files:**
- Modify: `manifest.json` (`version` 1.0.18 → 1.0.19), `plugin/UEMCP/UEMCP.uplugin` (`Version` 19 → 20, `VersionName` 1.0.19)
- Modify: `CLAUDE.md` — the "Visual capture" bullet (search `Captures always write under`), the "Native plugin tests" paragraph (search `34 UE automation tests`)
- Modify: `tools.yaml` — descriptions of the entries whose `wire_type` is `add_blueprint_timer`, `add_blueprint_event_node`, `override_blueprint_parent_member`
- Modify: `docs/tracking/backlog.md` — BUG-2 (`:181`), EN-28 (`:57`), EN-29 (`:62`), the `### Shipped` list (`:79`), the `### Fixed` list (`:188`)
- Modify: `docs/tracking/risks-and-decisions.md` — append row D201 after D200 (CRLF file)

**Interfaces:** consumes the outcomes of Tasks 1–7 as recorded in their commits.

- [ ] **Step 1: Bump the plugin version in lockstep**

`manifest.json`: `"version": "1.0.19"`. `UEMCP.uplugin`: `"Version": 20`, `"VersionName": "1.0.19"`. Run `cd server && node test-plugin-manifest.mjs` → PASS (lockstep check).

- [ ] **Step 2: CLAUDE.md**

Native-test paragraph: `34 UE automation tests` → `40 UE automation tests`; after `every headless-reachable error path of the five asset-editor capture handlers other than \`CAPTURE_UNSUPPORTED\`, which the headless suite cannot reach (its test declines before the capture; see backlog EN-29)` change to `every headless-reachable error path of the five asset-editor capture handlers, with \`CAPTURE_UNSUPPORTED\` asserted at the helper level (\`CaptureWidgetToPng\` on the null widget) because the handler path declines before capturing headless`. Visual-capture bullet: after `Captures always write under \`Saved/UEMCP/Captures/\`;` insert `a relative path is joined there and an absolute one must stay inside the project directory, else \`CAPTURE_PATH_OUTSIDE_PROJECT\` (one shared resolver serves all three capture tools);`. Run `cd server && node test-slash-command-anchors.mjs` → PASS.

- [ ] **Step 3: tools.yaml descriptions**

Append to the `add_blueprint_timer` entry's description: ` When the reused ReceiveBeginPlay was the editor's auto-placed disabled ghost, it is enabled in place and the response carries enabled_ghost: true.` Append to `add_blueprint_event_node`'s: ` A reused auto-placed ghost event is enabled in place (enabled_ghost: true).` Append to `override_blueprint_parent_member`'s: ` A reused auto-placed ghost event is enabled in place (enabled_ghost: true).` Run `cd server && node test-tool-metadata.mjs` → PASS.

- [ ] **Step 4: Backlog**

Replace the BUG-2 entry body with one line under `### Fixed`: `- BUG-2 — Four pre-existing quirks surfaced by the WS5a handler tests — fixed 2026-09 (D201): ghost ReceiveBeginPlay enabled in place with enabled_ghost; target_pin_info built after the break; vector literal elements validated (LITERAL_TYPE_MISMATCH); add_blueprint_variable_assignment returns COMPILE_FAILED and rolls back`. Delete the EN-28 and EN-29 bodies and add to `### Shipped (see the D-log)`: `- EN-28 — Confine capture output paths to the project directory — shipped 2026-09 (D201)` and `- EN-29 — Capture tools: close the headless-unreachable coverage — shipped 2026-09 (D201)`.

- [ ] **Step 5: D-log row D201**

Append after the D200 row, on one line, CRLF, using the same cell shape as D200:

`| D201 | **Ghost BeginPlay enabled in place; capture paths confined; capture coverage closed; runner passthrough 2026-09-14** — closes BUG-2, EN-28, EN-29. Mechanism, from engine source: during compilation the ubergraph merge (KismetCompiler.cpp, CloneAndMergeGraphIn with bIsCompiling) clones each source graph with bCloningForCompile, and FEdGraphUtilities::CloneGraph drops every disabled node of a non-transient graph; an event node has no pass-through pin, so the chain under the auto-placed disabled ReceiveBeginPlay is severed and PruneIsolatedNodes discards it — a timer inserted on the ghost compiled to nothing with no error. Fix shape: enable in place (SetEnabledState(Enabled, bUserAction=true), which also clears ghost status since IsAutomaticallyPlacedGhostNode is derived) through one helper at the three reuse sites, reported as enabled_ghost: true; chosen over the editor's remove-and-respawn because it keeps node GUIDs and positions. Proof: the compiler creates a ReceiveBeginPlay stub function only for an enabled event, and the new native test fails on that stub before the fix and passes after. Other BUG-2 fixes: target_pin_info built after the break; vector literal elements validated through one shared reader; add_blueprint_variable_assignment reads compiled_ok, rolls back its two nodes and returns COMPILE_FAILED like the timer (it never creates the variable, so nothing else to roll back). EN-28: ResolveCaptureOutputPath serves all three capture tools, checked before any editor lookup so headless tests reach CAPTURE_PATH_OUTSIDE_PROJECT; relative paths now join Saved/UEMCP/Captures/ for get_viewport_screenshot too (previously Saved/). EN-29: AppendInlinePng tested over and under the cap with a fabricated buffer; CAPTURE_UNSUPPORTED asserted at the helper on the null widget; details_panel_scroll reports scrolled. Runner: --extra-arg with replace-in-place for a same -Name= prefix because FParse::Value takes the first occurrence. Native suite 34 → 40; rotation +8. Plugin 1.0.19 / Version 20. |`

- [ ] **Step 6: Verify and commit**

From `server/`: `node run-rotation.mjs` → 7,797 across 80 files, all PASS. `git diff --stat` shows `risks-and-decisions.md | 1 +`. Scan the staged diff for codenames (the pre-commit hook does; also scan the commit message).

```bash
git add manifest.json plugin/UEMCP/UEMCP.uplugin CLAUDE.md tools.yaml docs/tracking/backlog.md docs/tracking/risks-and-decisions.md
git commit -m "Record D201 and bump the plugin to 1.0.19: ghost BeginPlay, capture path confinement, capture coverage, runner passthrough"
```

Note for the orchestrator: the version bump means the next `sync-plugin.bat` busts `Binaries/` and `Intermediate/` on every target; the final sample-target cycle after this task is a full plugin rebuild (about 20 s with `-NoUBA` on this machine), and its runner result must read `40 passed, 0 failed, 0 not run`.

---

## After the last task (orchestrator, not a dispatch)

1. Whole-branch review, one fix wave, scoped re-review.
2. Live smoke with a GUI editor on the sample target: `server/live-smoke-asset-editor-capture.mjs` must PASS with the inline decode and over-range lines printed; record the output in the worker report.
3. Merge to main; sync, build and test the sample target on the merge commit (40/0/0, 3 skips).
4. Request a deploy window from the primary target's owner by relay; on GO: process recheck, backup of the deployed tree, sync, build, `node server/run-native-tests.mjs --uproject <PRIMARY> --extra-arg "-ExecCmds=Automation RunTests UEMCP,Automation Quit" --extra-arg -ddc=InstalledNoZenLocalFallback --extra-arg -NoSourceControl` (40/0/0, 3 skips), verify-deploy SYNC on both targets, completion notice with exact commands, selectors, exit codes and log paths.
5. `git push origin main` through the pre-push gate; delete the branch; close the SDD workspace.
