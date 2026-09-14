# Native Handler Coverage Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the coverage gaps the WS5a whole-branch review inventoried in `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp` by adding five handler-level automation tests to the existing `Private/Tests/UEMCPBlueprintHandlerTests.cpp`, taking the native suite from 22 tests to 27.

**Architecture:** WS5a gave three handlers — `add_blueprint_variable_assignment`, `add_blueprint_timer`, `disconnect_blueprint_pin` — their first automated checks through `FMCPCommandRegistry::Get().Dispatch(...)` against an unsaved in-memory Blueprint under `/Game/__UEMCPTests/`. It covered the main success path and the cheapest rejections of each. This plan covers what it left: the assignment handler's `variable` kind and its `exec_from` block, the disconnect handler's ambiguity / `target_direction` / dry-run reporting edges, the `compile: true` leg of all three, and the timer handler's `NO_GRAPH` branch plus its `COMPILE_FAILED` rollback. Every new test reuses the WS5a fixture and helper namespace `UEMCP::Blueprint::Tests` in the same file; three of them arrange state by dispatching a *different* handler through the same registry (`add_blueprint_function_node`, `add_blueprint_event_node`, `add_blueprint_timer`) rather than reaching into the editor API, so the arrangement is itself shipped behaviour.

**Tech Stack:** UE 5.6 C++ editor module; `IMPLEMENT_SIMPLE_AUTOMATION_TEST` with `EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter` behind `#if WITH_DEV_AUTOMATION_TESTS`; `FKismetEditorUtilities`, `FBlueprintEditorUtils`, `UEdGraphSchema_K2`, `FAssetRegistryModule`; `node server/run-native-tests.mjs` (headless `UnrealEditor-Cmd`) for the proof; `sync-plugin.bat` + `Build.bat` + `verify-deploy.mjs` for the deploy cycle.

**Spec:** `docs/superpowers/plans/2026-09-13-health-audit-ws5a-blueprint-handler-tests.md` — the plan this extends; read its header, Global Constraints and Task 2 before starting. The requirement list this plan argues from is the review inventory, reproduced verbatim in **§Coverage inventory** below so the spec travels with the plan.

---

## Coverage inventory

The WS5a whole-branch review left these uncovered. Each row names the task that closes it, or the reason it is dropped.

| # | Item | Disposition |
|---|---|---|
| 1 | `add_blueprint_variable_assignment` with `kind: variable` end to end: get-node creation, the `links[value]` row, the `source_value` pin row, and its own `VARIABLE_NOT_FOUND` for a missing source variable | Task 1 |
| 2 | `exec_from` on the assignment handler: `MISSING_PARAMS`, `NODE_NOT_FOUND`, and the `links[exec]` row on success | Task 2 |
| 3 | `PinToJson` fields not yet pinned: `pin_id`, `link_count`, `default_object` where a pin has one | `pin_id` + `link_count` in Tasks 1, 2 and 3; `default_object` in Task 2 |
| 4 | `disconnect_blueprint_pin`: `PIN_AMBIGUOUS` | Task 3 |
| 5 | `disconnect_blueprint_pin`: `target_direction` parsing, `INVALID_DIRECTION` on the target side | Task 3 |
| 6 | `disconnect_blueprint_pin`: `would_require_compile` / `pin_info` on the dry-run response | Task 3 |
| 7 | The `compile: true` paths on all three handlers: `compiled == true` and the compile-related fields on success | Task 4 |
| 8 | `COMPILE_FAILED` | Task 5 (timer handler, via a deliberately uncompilable Blueprint) |
| 9 | `add_blueprint_timer`: `NO_GRAPH` | Task 5 |
| 10 | `add_blueprint_timer`: `RollbackTimerAuthoring` | Task 5 (proved on the `COMPILE_FAILED` path) |
| 11 | `add_blueprint_timer`: `TIMER_FUNCTION_NOT_FOUND` | **Dropped** — see §Dropped inventory items |
| 12 | `add_blueprint_timer`: `CREATE_FAILED` | **Dropped** — see §Dropped inventory items |

### Dropped inventory items

Both drops are branches that sit outside the handler's testable surface. A handler test drives the handler through its params; a branch no param can reach is not reachable from that surface at all, and a test that forced it would be testing the forcing mechanism.

- **`TIMER_FUNCTION_NOT_FOUND`** (`BlueprintHandlers.cpp:2628-2636`) fires only when `ResolveK2SetTimerFunction()` returns `nullptr`. That function asks `UKismetSystemLibrary::StaticClass()` for `K2_SetTimer` by name and then walks every `UFunction` on the class as a fallback (`:960-976`). `UKismetSystemLibrary` is a native Engine class, always loaded in an editor run, and `K2_SetTimer` is a `UFUNCTION` on it. No JSON parameter influences the lookup. Unreachable without unloading an Engine module.
- **`CREATE_FAILED`** in the timer handler (`:2638-2644` for the call node, `:2667-2673` for the Self node) fires only when `NewObject<UK2Node_CallFunction>` / `NewObject<UK2Node_Self>` returns `nullptr`, which is an allocation failure. No parameter reaches it. The *other* `CREATE_FAILED` in `ResolveOrCreateFunctionGraph` (`:891-895`) has the same shape.

Note that `add_blueprint_variable_assignment` has **no `COMPILE_FAILED` branch at all** — it calls `FKismetEditorUtilities::CompileBlueprint(Blueprint)` and reports `compiled`/`requires_compile` without consulting the result (`:2540-2546`, `:2578-2579`). That is not a gap in the tests; it is the handler's actual shape, and Task 4 asserts it.

### If a test proves a defect

These are characterization tests over shipped behaviour, so the expected outcome of every task is green on the first build that compiles. If an assertion that matches this plan's reading of the handler source fails against the real editor, **that is a handler defect, not a test to weaken**. Stop, keep the failing test exactly as written, and report it; the fix becomes its own task that changes `BlueprintHandlers.cpp` and leaves the assertion untouched. Never relax an assertion that surfaced a bug (CLAUDE.md Key Design Rule 9). The likeliest candidate is Task 5's rollback block: if a node the handler reported survives `RollbackTimerAuthoring`, that is a real leak.

---

## Global Constraints

Carried forward from the WS5a plan; every task's requirements implicitly include this section.

- **Placeholder vocabulary only.** This is a public repo and the target projects are private. Write `path/to/YourProject.uproject`, `<YourProject>Editor`, `<UE_ENGINE_ROOT>`, "the sample 5.6 target". Never a project codename, never an absolute machine path, and no unquoted capital-T scratch-directory word — the per-checkout token list blocks that as a standalone token, so write "scratch" instead. Applies to source comments, commit messages, the D-log row and CLAUDE.md.
- **No AI attribution** in commits — no `Co-Authored-By`, no "generated with".
- **One commit per task**, six commits total. Commit from the repo root.
- **Never edit `.uemcp-targets.json`.** It is per-machine and untracked-by-intent.
- **Deploy to the sample 5.6 target only.** The commands below take a `.uproject` path directly, so no profile is needed and none is assumed.
- **Shared C++ helpers live in `Public/` headers, never in per-file anonymous namespaces** (`UEMCP.Build.cs` sets `bUseUnity = true`; D133/D135/D137). `node server/test-anon-namespace-audit.mjs` must stay clean. It scans `Private/*.cpp` non-recursively, so `Private/Tests/*.cpp` is outside its scope — run it anyway as a guard.
- **New helpers are under 50 lines and live in `namespace UEMCP::Blueprint::Tests`** in this one file. Handler test bodies are the recorded exception to the 50-line rule (WS5a Global Constraints): they are flat sequences of dispatch-and-assert, and splitting them hides which dispatch an assertion belongs to. Do not add a second `namespace UEMCP::Blueprint::Tests` block anywhere else — `UEMCPBlueprintHelperTests.cpp` deliberately uses `UEMCP::Blueprint::HelperTests` because Unity may bundle both files into one translation unit.
- **Every dispatch to a handler that reads `compile` sets it explicitly.** The three handlers under test all read it. `add_blueprint_function_node`, `add_blueprint_event_node` and `add_blueprint_variable` have no `compile` parameter and never compile — do not pass one to them.
- **Nodes are found by the GUID the handler reported** (`FindNodeByGuid`), never by first-of-class. A freshly created Actor Blueprint's event graph is not guaranteed empty, and by Task 3 the fixture holds several nodes of the same class.
- **Never reuse a node or pin pointer taken before a dispatch that may compile.** `HandleAddBlueprintVariableAssignment` calls `FKismetEditorUtilities::CompileBlueprint(Blueprint)` with **no** options, so unlike the timer and disconnect paths (which go through `BuildBlueprintCompileDiagnosticResult` with `EBlueprintCompileOptions::SkipGarbageCollection`) it does not skip garbage collection, and compilation can reconstruct node pins. Re-resolve through `FindNodeByGuid` + `FindFixturePin` after any compiling dispatch. A stale pointer read can false-pass, which is worse than a crash.
- **Every early return calls `DestroyFixtureBlueprint(Fixture)`** — including the `AddError` guards. A test that returns without it leaks a standalone object into the rest of the run.
- **Every test name is unique per run.** The fixture helper already puts `FGuid::NewGuid().ToString(EGuidFormats::Short)` in the package leaf; automation tests run in arbitrary order and may run repeatedly in one editor session, so nothing may depend on another test having run.
- **Nothing is ever saved.** The fixture packages have no file on disk, `SidecarSaveHook.cpp:34` ignores transient-package Blueprints, and nothing saves an unsaved package in a headless `-unattended` run. This holds with `compile: true` as well: compiling does not save.
- **Proof is the count, not the exit code.** `reportExitCode` in `server/native-test-report.mjs` returns 0 whenever `failed === 0 && notRun === 0`, so a test that fails to register (name typo, file not picked up) leaves the total unchanged and still exits 0 — the silent-zero class in native clothing. Every task's proof line is the runner's `Native tests: <N> passed, 0 failed, 0 not run` with N stated: **23 / 24 / 25 / 26 / 27 / 27**.
- **The Node rotation must not move.** Baseline 7,580 assertions across 79 files. Tasks 1-5 touch no Node code and do not re-run it; Task 6 edits `CLAUDE.md`, which `server/test-slash-command-anchors.mjs` reads, so it does.
- **Deploy cycle, run from the repo root, after every code change** (about 25 s for `Build.bat` on this module, about 30 s for the test run):

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
node server/verify-deploy.mjs --quiet --no-color
```

  **Close the editor before `Build.bat`** — a running editor locks the module DLL and the build is a silent no-op (D135); `verify-deploy` reports that as `[EDITOR-LOCKED]`. `verify-deploy.mjs` must print `SYNC` for the target afterwards. The pre-push compile gate refuses to publish plugin source while a built target reads NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` | Modify (Tasks 1-5) | Gains four helpers and five `IMPLEMENT_SIMPLE_AUTOMATION_TEST` blocks. No other file changes in Tasks 1-5. |
| `CLAUDE.md` | Modify (Task 6) | The native-tests count, line 421. |
| `docs/tracking/backlog.md` | Modify (Task 6) | One bullet appended to the existing BUG-2 entry. |
| `docs/tracking/risks-and-decisions.md` | Modify (Task 6) | The D198 row. |

No handler source is modified by this plan. If a test proves a defect, see **§If a test proves a defect** above.

## Handler facts the assertions rest on

Read once; every task assumes them. Line numbers are from this checkout (`BlueprintHandlers.cpp`, 3,495 lines).

- `HandleAddBlueprintVariableAssignment` `:2379-2581`. `kind` is compared case-insensitively and reported through `.ToLower()` (`:2570`). The `variable` kind requires `assignment.source_variable` (`MISSING_PARAMS` at `:2416`) and that it name an existing member (`VARIABLE_NOT_FOUND` at `:2421`). It builds a `UK2Node_VariableGet` (`:2483`), links it (`:2500`) and adds a `links` row with role `value` (`:2505`). `exec_from` requires both `node_id` and `pin` (`MISSING_PARAMS` at `:2518`), resolves the node by GUID (`NODE_NOT_FOUND` at `:2526`) and adds a `links` row with role `exec` (`:2537`). The response carries `requires_compile = !bCompile` and `compiled = bCompile` and **no compile block**.
- `HandleAddBlueprintTimer` `:2583-2767`. Order of rejections: `MISSING_PARAMS` (no `callback_function`), `INVALID_INTERVAL`, then `NO_GRAPH` when `FindOrCreateEventGraph` returns null (`:2615`), then the callback-graph resolution, then `TIMER_FUNCTION_NOT_FOUND`. With `compile: true` it builds the diagnostic block, sets `compiled_ok` and `compile`, and when the compile reports errors it calls `RollbackTimerAuthoring` and returns `COMPILE_FAILED` **with the whole result object in the error detail slot** (`:2756-2764`).
- `HandleDisconnectBlueprintPin` `:3124-3278`. With no `direction` it looks the pin up in both directions and returns `PIN_AMBIGUOUS` when both exist (`FindNamedPinOptionalDirection` `:678-695`, error at `:3160`). `target_direction` defaults to the opposite of the source pin's direction and is parsed only when `target_node_id` and `target_pin` are both present (`:3190-3195`); an unparseable value is `INVALID_DIRECTION`, and a parseable one that finds no pin is `PIN_NOT_FOUND` (`:3200`). The response always carries `would_modify`, `would_require_compile` and `pin_info`; it compiles only when `!dry_run && LinksBroken > 0` (`:3237`).
- `PinToJson` (`Private/BlueprintHandlerHelpers.cpp:27-47`) emits `pin_id`, `name`, `direction`, `category`, `subcategory`, `subcategory_object` when the type has one, `default`, `default_object` **only when `Pin->DefaultObject` is set**, and `link_count`.
- `BuildBlueprintCompileDiagnosticResult` (`Private/CompileDiagnosticHandler.cpp:108`) emits `name`, `asset_path`, `package_path`, `errors`/`warnings`/`notes`/`info`, `num_errors`, `num_warnings`, `succeeded`, `compiled`, `compiled_ok`, `generated_class_status`, `dirty_available`, `dirty`. `compiled_ok` is `errors.Num() == 0`, so warnings never fail a compile.
- **BUG-2 (`docs/tracking/backlog.md`)**: `target_pin_info` is built at `:3203`, *before* the break at `:3220-3230`, so on a real disconnect its `link_count` is the pre-break value while `pin_info` at `:3258` is post-break. Do not assert `target_pin_info.link_count`. The linked-pin `link_count` assertion belongs on a **dry run's** `pin_info`, where the value is correct and stable.

---

### Task 1: `add_blueprint_variable_assignment` — the `variable` kind

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` — one include, one helper inside `namespace UEMCP::Blueprint::Tests`, one test appended before `#endif // WITH_DEV_AUTOMATION_TESTS`

**Interfaces:**
- Consumes, all from the shipped WS5a fixture in `namespace UEMCP::Blueprint::Tests`: `struct FFixtureBlueprint { UBlueprint* Blueprint; UPackage* Package; FString PackagePath; }`, `FFixtureBlueprint CreateFixtureBlueprint()`, `void AddFixtureVariable(UBlueprint*, const FString&, FName, FName = NAME_None)`, `void DestroyFixtureBlueprint(FFixtureBlueprint&)`, `TSharedPtr<FJsonObject> Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `bool IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `FString ErrorCodeOf(const TSharedPtr<FJsonObject>&)`, `TSharedPtr<FJsonObject> ResultOf(const TSharedPtr<FJsonObject>&)`, `FString StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `TSharedPtr<FJsonObject> FindRole(const TSharedPtr<FJsonObject>&, const FString&, const FString&)`, `UEdGraph* FixtureEventGraph(UBlueprint*)`, `UEdGraphNode* FindNodeByGuid(UEdGraph*, const FString&)`, `UEdGraphPin* FindFixturePin(UEdGraphNode*, const TArray<FString>&, EEdGraphPinDirection)`.
- Produces, in `namespace UEMCP::Blueprint::Tests`, used by Tasks 2-5:
  - `double NumberFieldOr(const TSharedPtr<FJsonObject>& Obj, const FString& Field, double Fallback = -1.0)`

- [ ] **Step 1: Pre-start check — is the test file or the handler in flight?**

```bash
git status --short plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: the first command prints nothing, and the runner reports **`Native tests: 22 passed, 0 failed, 0 not run`**. Stop and report instead of continuing if either differs — every count in this plan is relative to a green 22.

- [ ] **Step 2: Add the `K2Node_VariableGet` include**

In the include block of `UEMCPBlueprintHandlerTests.cpp`, immediately before `#include "K2Node_VariableSet.h"` (keeping the block alphabetical):

```cpp
#include "K2Node_VariableGet.h"
```

- [ ] **Step 3: Add the `NumberFieldOr` helper**

Inside `namespace UEMCP::Blueprint::Tests`, immediately after `StringFieldOr` and before `ResultOf`:

```cpp
	/**
	 * Log-silent number read; the numeric twin of StringFieldOr, and needed for the
	 * same reason — FJsonObject::GetNumberField on an absent field logs a LogJson
	 * Error, and the automation framework scores an Error-level log as a test
	 * failure. link_count and num_errors are both read off objects that may not
	 * carry them. The default is negative so a missing field can never be mistaken
	 * for a real count.
	 */
	double NumberFieldOr(const TSharedPtr<FJsonObject>& Obj, const FString& Field, double Fallback = -1.0)
	{
		double Value = Fallback;
		if (Obj.IsValid())
		{
			Obj->TryGetNumberField(Field, Value);
		}
		return Value;
	}
```

- [ ] **Step 4: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the disconnect test and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// add_blueprint_variable_assignment — the variable kind. The shipped
// AddVariableAssignment test covers the literal kind; this covers the branch that
// creates a K2Node_VariableGet, links it into the set node, and reports a links[value]
// row plus a source_value pin row — none of which a literal assignment produces.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersAssignmentVariableKindTest,
	"UEMCP.BlueprintHandlers.AssignmentVariableKind",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersAssignmentVariableKindTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	AddFixtureVariable(Fixture.Blueprint, TEXT("Score"), UEdGraphSchema_K2::PC_Int);
	AddFixtureVariable(Fixture.Blueprint, TEXT("SourceScore"), UEdGraphSchema_K2::PC_Int);

	// Capitalized on purpose: the handler compares kind case-insensitively and
	// lowercases it into the response, and the assertion below only proves that
	// if the input is not already lowercase.
	TSharedPtr<FJsonObject> Assignment = MakeShared<FJsonObject>();
	Assignment->SetStringField(TEXT("kind"), TEXT("Variable"));
	Assignment->SetStringField(TEXT("source_variable"), TEXT("SourceScore"));

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Params->SetStringField(TEXT("target_variable"), TEXT("Score"));
	Params->SetObjectField(TEXT("assignment"), Assignment);
	Params->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> Response = Dispatch(TEXT("add_blueprint_variable_assignment"), Params);
	FString Code;
	if (!IsSuccess(Response, Code))
	{
		AddError(FString::Printf(TEXT("variable assignment failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	const TSharedPtr<FJsonObject> Result = ResultOf(Response);
	TestEqual(TEXT("assignment_kind lowercased"), StringFieldOr(Result, TEXT("assignment_kind")), FString(TEXT("variable")));
	TestEqual(TEXT("target_variable"), StringFieldOr(Result, TEXT("target_variable")), FString(TEXT("Score")));
	TestEqual(TEXT("source_variable reported"), StringFieldOr(Result, TEXT("source_variable")), FString(TEXT("SourceScore")));
	TestEqual(TEXT("graph_name"), StringFieldOr(Result, TEXT("graph_name")), FString(TEXT("EventGraph")));
	TestTrue(TEXT("requires_compile set when compile is false"), Result->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("compiled false"), Result->GetBoolField(TEXT("compiled")));

	// ---- the get node a literal assignment never creates ----
	const TSharedPtr<FJsonObject> GetNodeJson = FindRole(Result, TEXT("nodes"), TEXT("get"));
	const TSharedPtr<FJsonObject> SetNodeJson = FindRole(Result, TEXT("nodes"), TEXT("set"));
	const FString GetNodeId = StringFieldOr(GetNodeJson, TEXT("node_id"));
	const FString SetNodeId = StringFieldOr(SetNodeJson, TEXT("node_id"));
	TestEqual(TEXT("get node class"), StringFieldOr(GetNodeJson, TEXT("node_class")), FString(TEXT("K2Node_VariableGet")));
	TestEqual(TEXT("set node class"), StringFieldOr(SetNodeJson, TEXT("node_class")), FString(TEXT("K2Node_VariableSet")));
	TestFalse(TEXT("get node_id is empty"), GetNodeId.IsEmpty());
	TestFalse(TEXT("set node_id is empty"), SetNodeId.IsEmpty());

	// ---- the links[value] row ----
	const TArray<TSharedPtr<FJsonValue>>* Links = nullptr;
	TestTrue(TEXT("links array present"), Result->TryGetArrayField(TEXT("links"), Links));
	TestEqual(TEXT("a variable assignment creates exactly one link"), Links ? Links->Num() : -1, 1);
	const TSharedPtr<FJsonObject> ValueLink = FindRole(Result, TEXT("links"), TEXT("value"));
	TestEqual(TEXT("value link source is the get node"), StringFieldOr(ValueLink, TEXT("source_node_id")), GetNodeId);
	TestEqual(TEXT("value link target is the set node"), StringFieldOr(ValueLink, TEXT("target_node_id")), SetNodeId);
	const TSharedPtr<FJsonObject>* LinkSourcePin = nullptr;
	const TSharedPtr<FJsonObject>* LinkTargetPin = nullptr;
	if (ValueLink->TryGetObjectField(TEXT("source_pin"), LinkSourcePin) && LinkSourcePin
		&& ValueLink->TryGetObjectField(TEXT("target_pin"), LinkTargetPin) && LinkTargetPin)
	{
		TestEqual(TEXT("value link source pin name"), StringFieldOr(*LinkSourcePin, TEXT("name")), FString(TEXT("SourceScore")));
		TestEqual(TEXT("value link source pin direction"), StringFieldOr(*LinkSourcePin, TEXT("direction")), FString(TEXT("output")));
		TestEqual(TEXT("value link target pin name"), StringFieldOr(*LinkTargetPin, TEXT("name")), FString(TEXT("Score")));
		TestEqual(TEXT("value link target pin direction"), StringFieldOr(*LinkTargetPin, TEXT("direction")), FString(TEXT("input")));
	}
	else
	{
		AddError(TEXT("links[value] carried no source_pin / target_pin objects"));
	}

	// ---- the source_value pin row, which only the variable kind emits ----
	const TSharedPtr<FJsonObject> SourcePinJson = FindRole(Result, TEXT("pins"), TEXT("source_value"));
	const TSharedPtr<FJsonObject> TargetPinJson = FindRole(Result, TEXT("pins"), TEXT("target_value"));
	TestEqual(TEXT("source_value pin name"), StringFieldOr(SourcePinJson, TEXT("name")), FString(TEXT("SourceScore")));
	TestEqual(TEXT("source_value pin direction"), StringFieldOr(SourcePinJson, TEXT("direction")), FString(TEXT("output")));
	TestEqual(TEXT("source_value pin category"), StringFieldOr(SourcePinJson, TEXT("category")), UEdGraphSchema_K2::PC_Int.ToString());
	TestEqual(TEXT("source_value pin link_count"), (int32)NumberFieldOr(SourcePinJson, TEXT("link_count")), 1);
	TestEqual(TEXT("target_value pin link_count"), (int32)NumberFieldOr(TargetPinJson, TEXT("link_count")), 1);

	// ---- graph state, read from the graph rather than the envelope ----
	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	UK2Node_VariableGet* GetNode = Cast<UK2Node_VariableGet>(FindNodeByGuid(EventGraph, GetNodeId));
	UK2Node_VariableSet* SetNode = Cast<UK2Node_VariableSet>(FindNodeByGuid(EventGraph, SetNodeId));
	if (!GetNode || !SetNode)
	{
		AddError(TEXT("a reported node id did not resolve to a node of that class in the event graph"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("get node reads SourceScore"), GetNode->VariableReference.GetMemberName(), FName(TEXT("SourceScore")));
	TestEqual(TEXT("set node targets Score"), SetNode->VariableReference.GetMemberName(), FName(TEXT("Score")));

	UEdGraphPin* SourcePin = FindFixturePin(GetNode, {TEXT("SourceScore")}, EGPD_Output);
	UEdGraphPin* TargetPin = FindFixturePin(SetNode, {TEXT("Score")}, EGPD_Input);
	if (!SourcePin || !TargetPin)
	{
		AddError(TEXT("the get or set node is missing its value pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestTrue(TEXT("the get output links to the set input"), SourcePin->LinkedTo.Contains(TargetPin));
	TestEqual(TEXT("the target pin has exactly one link"), TargetPin->LinkedTo.Num(), 1);
	TestEqual(TEXT("source_value pin_id matches the graph pin"), StringFieldOr(SourcePinJson, TEXT("pin_id")), SourcePin->PinId.ToString());
	TestEqual(TEXT("target_value pin_id matches the graph pin"), StringFieldOr(TargetPinJson, TEXT("pin_id")), TargetPin->PinId.ToString());

	// ---- error: assignment.source_variable omitted ----
	TSharedPtr<FJsonObject> NoSource = MakeShared<FJsonObject>();
	NoSource->SetStringField(TEXT("kind"), TEXT("variable"));
	TSharedPtr<FJsonObject> NoSourceParams = MakeShared<FJsonObject>();
	NoSourceParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	NoSourceParams->SetStringField(TEXT("target_variable"), TEXT("Score"));
	NoSourceParams->SetObjectField(TEXT("assignment"), NoSource);
	NoSourceParams->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("missing source_variable code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), NoSourceParams)),
		FString(TEXT("MISSING_PARAMS")));

	// ---- error: a source variable that does not exist. Distinct from the shipped
	// test's VARIABLE_NOT_FOUND, which is raised for the TARGET variable well before
	// the assignment object is read; this one is the source-side check at :2421. ----
	TSharedPtr<FJsonObject> BadSource = MakeShared<FJsonObject>();
	BadSource->SetStringField(TEXT("kind"), TEXT("variable"));
	BadSource->SetStringField(TEXT("source_variable"), TEXT("NoSuchSourceVariable"));
	TSharedPtr<FJsonObject> BadSourceParams = MakeShared<FJsonObject>();
	BadSourceParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	BadSourceParams->SetStringField(TEXT("target_variable"), TEXT("Score"));
	BadSourceParams->SetObjectField(TEXT("assignment"), BadSource);
	BadSourceParams->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("unknown source variable code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), BadSourceParams)),
		FString(TEXT("VARIABLE_NOT_FOUND")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 5: Build and run**

Close the editor, then from the repo root:

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `PASS UEMCP.BlueprintHandlers.AssignmentVariableKind` and **`Native tests: 23 passed, 0 failed, 0 not run`**. A total of 22 means the new test did not register — check the pretty name for a typo.

If it fails, read the error text before changing the test. A `VARIABLE_NOT_FOUND` on the success path means `AddFixtureVariable` did not take for one of the two names; a missing `source_value` pin row means the handler's `FindPin` tier-3 fallback resolved a different output pin than expected.

- [ ] **Step 6: Prove the assertions bind (deliberate falsification)**

Temporarily change one assertion to a value that must be wrong:

```cpp
	TestEqual(TEXT("get node reads SourceScore"), GetNode->VariableReference.GetMemberName(), FName(TEXT("NotSourceScore")));
```

Then rebuild and run:

```bash
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `FAIL UEMCP.BlueprintHandlers.AssignmentVariableKind` and `Native tests: 22 passed, 1 failed, 0 not run`. **Restore `FName(TEXT("SourceScore"))`**, rebuild, and confirm `Native tests: 23 passed, 0 failed, 0 not run` again before committing.

- [ ] **Step 7: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color
```

Expected: 0 collisions; the target reads `SYNC`. No Node code changed, so the rotation is not re-run for this task.

- [ ] **Step 8: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Cover the variable kind of add_blueprint_variable_assignment natively

The shipped handler test only exercises the literal kind, so the branch that
creates a K2Node_VariableGet, links it into the set node and reports it never
ran. The new test asserts the envelope (assignment_kind lowercased,
source_variable echoed, the get node's class and id, the links[value] row with
both pin objects, the source_value and target_value pin rows including pin_id
and link_count) and the graph behind it: a get node bound to the source
variable whose output pin is linked to the set node's input pin.

Two source-side rejections come with it: MISSING_PARAMS when
assignment.source_variable is omitted, and the handler's own VARIABLE_NOT_FOUND
for a source variable that does not exist, which is a different call site from
the target-side check the shipped test covers.

NumberFieldOr joins StringFieldOr as the log-silent reader for numeric fields;
a bare GetNumberField on an absent field logs a LogJson Error that the
automation framework scores as a failure.

Native tests 22 -> 23.
MSG
```

---

### Task 2: `add_blueprint_variable_assignment` — `exec_from`, and `PinToJson`'s `default_object`

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` — one helper added and `FindRole` reduced to a call of it, one test appended before `#endif // WITH_DEV_AUTOMATION_TESTS`

**Interfaces:**
- Consumes from the shipped fixture and Task 1, all in `namespace UEMCP::Blueprint::Tests`: `FFixtureBlueprint`, `CreateFixtureBlueprint()`, `AddFixtureVariable(UBlueprint*, const FString&, FName, FName)`, `DestroyFixtureBlueprint(FFixtureBlueprint&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `ErrorCodeOf(const TSharedPtr<FJsonObject>&)`, `ResultOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `NumberFieldOr(const TSharedPtr<FJsonObject>&, const FString&, double)`, `FindRole(const TSharedPtr<FJsonObject>&, const FString&, const FString&)`, `FixtureEventGraph(UBlueprint*)`, `FindNodeByGuid(UEdGraph*, const FString&)`, `FindFixturePin(UEdGraphNode*, const TArray<FString>&, EEdGraphPinDirection)`.
- Produces, in `namespace UEMCP::Blueprint::Tests`:
  - `TSharedPtr<FJsonObject> FindEntryByField(const TSharedPtr<FJsonObject>& Result, const FString& ArrayField, const FString& FieldName, const FString& Value)` — used only by this task; later tasks keep calling `FindRole`.
  - `FindRole(const TSharedPtr<FJsonObject>&, const FString&, const FString&)` keeps its exact signature and behaviour; only its body changes, to a one-line call of `FindEntryByField`. No existing or later call site changes.

- [ ] **Step 1: Add `FindEntryByField` and reduce `FindRole` to it**

Inside `namespace UEMCP::Blueprint::Tests`, replace the whole existing `FindRole` block (its doc comment and body) with these two functions, in this order:

```cpp
	/**
	 * The entry of Result[ArrayField] whose FieldName equals Value, or an empty
	 * object. FindRole is the role-keyed case; this exists because
	 * add_blueprint_function_node returns a flat pins array whose rows carry no
	 * role at all, so a pin there can only be found by name.
	 */
	TSharedPtr<FJsonObject> FindEntryByField(const TSharedPtr<FJsonObject>& Result, const FString& ArrayField,
		const FString& FieldName, const FString& Value)
	{
		const TArray<TSharedPtr<FJsonValue>>* Entries = nullptr;
		if (Result.IsValid() && Result->TryGetArrayField(ArrayField, Entries) && Entries)
		{
			for (const TSharedPtr<FJsonValue>& Entry : *Entries)
			{
				const TSharedPtr<FJsonObject>* Obj = nullptr;
				FString EntryValue;
				if (Entry.IsValid() && Entry->TryGetObject(Obj) && Obj && (*Obj)->TryGetStringField(FieldName, EntryValue)
					&& EntryValue == Value)
				{
					return *Obj;
				}
			}
		}
		return MakeShared<FJsonObject>();
	}

	/** The entry of Result[ArrayField] whose "role" matches, or an empty object. */
	TSharedPtr<FJsonObject> FindRole(const TSharedPtr<FJsonObject>& Result, const FString& ArrayField, const FString& Role)
	{
		return FindEntryByField(Result, ArrayField, TEXT("role"), Role);
	}
```

No call site changes: `FindRole` keeps its name, parameters and return type.

- [ ] **Step 2: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the Task 1 test and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// add_blueprint_variable_assignment — exec_from. The exec source is authored by
// add_blueprint_function_node through the same registry rather than by reaching into
// the editor API, so the arrangement is itself shipped behaviour.
//
// That call does double duty. SphereOverlapActors takes a plain UClass* parameter
// (no DeterminesOutputType machinery, so setting its default reshapes nothing else)
// and is BlueprintCallable rather than pure, so the node has both a class pin whose
// DefaultObject the handler sets and the "then" exec output this test needs. Its pins
// array is therefore the one response in reach that carries PinToJson's default_object
// branch, which nothing has asserted before.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersAssignmentExecFromTest,
	"UEMCP.BlueprintHandlers.AssignmentExecFrom",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersAssignmentExecFromTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	AddFixtureVariable(Fixture.Blueprint, TEXT("Score"), UEdGraphSchema_K2::PC_Int);

	// ---- arrange: a non-pure library call, for its "then" exec output ----
	// add_blueprint_function_node has no compile parameter and never compiles.
	TSharedPtr<FJsonObject> PinDefaults = MakeShared<FJsonObject>();
	PinDefaults->SetStringField(TEXT("ActorClassFilter"), TEXT("Actor"));
	TSharedPtr<FJsonObject> FuncParams = MakeShared<FJsonObject>();
	FuncParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	FuncParams->SetStringField(TEXT("function_name"), TEXT("SphereOverlapActors"));
	FuncParams->SetStringField(TEXT("target"), TEXT("KismetSystemLibrary"));
	FuncParams->SetObjectField(TEXT("params"), PinDefaults);

	const TSharedPtr<FJsonObject> FuncResponse = Dispatch(TEXT("add_blueprint_function_node"), FuncParams);
	FString Code;
	if (!IsSuccess(FuncResponse, Code))
	{
		AddError(FString::Printf(TEXT("arrange step failed: add_blueprint_function_node returned '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> FuncResult = ResultOf(FuncResponse);
	const FString FuncNodeId = StringFieldOr(FuncResult, TEXT("node_id"));
	TestEqual(TEXT("arranged node class"), StringFieldOr(FuncResult, TEXT("node_class")), FString(TEXT("K2Node_CallFunction")));
	if (FuncNodeId.IsEmpty())
	{
		AddError(TEXT("arrange step produced no node id"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	UEdGraphNode* FuncNode = FindNodeByGuid(EventGraph, FuncNodeId);
	UEdGraphPin* ClassPin = FindFixturePin(FuncNode, {TEXT("ActorClassFilter")}, EGPD_Input);
	UEdGraphPin* ThenPin = FindFixturePin(FuncNode, {TEXT("then")}, EGPD_Output);
	if (!FuncNode || !ClassPin || !ThenPin)
	{
		AddError(TEXT("the arranged call node is missing its ActorClassFilter or then pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// ---- PinToJson's default_object branch, on the class pin the arrange step set ----
	// The path is computed, not spelled out, so this does not encode where the engine
	// keeps AActor.
	const TSharedPtr<FJsonObject> ClassPinJson = FindEntryByField(FuncResult, TEXT("pins"), TEXT("name"), TEXT("ActorClassFilter"));
	TestEqual(TEXT("class pin category"), StringFieldOr(ClassPinJson, TEXT("category")), UEdGraphSchema_K2::PC_Class.ToString());
	TestEqual(TEXT("class pin default_object"), StringFieldOr(ClassPinJson, TEXT("default_object")), AActor::StaticClass()->GetPathName());
	TestEqual(TEXT("class pin link_count"), (int32)NumberFieldOr(ClassPinJson, TEXT("link_count")), 0);
	TestEqual(TEXT("class pin_id matches the graph pin"), StringFieldOr(ClassPinJson, TEXT("pin_id")), ClassPin->PinId.ToString());
	TestTrue(TEXT("the graph pin really holds that DefaultObject"), ClassPin->DefaultObject == AActor::StaticClass());

	// A pin with no DefaultObject omits the field rather than emitting it empty.
	TestFalse(TEXT("the exec pin omits default_object"),
		FindEntryByField(FuncResult, TEXT("pins"), TEXT("name"), TEXT("then"))->HasField(TEXT("default_object")));

	// ---- act: a literal assignment wired into that node's exec output ----
	TSharedPtr<FJsonObject> ExecFrom = MakeShared<FJsonObject>();
	ExecFrom->SetStringField(TEXT("node_id"), FuncNodeId);
	ExecFrom->SetStringField(TEXT("pin"), TEXT("then"));

	TSharedPtr<FJsonObject> Assignment = MakeShared<FJsonObject>();
	Assignment->SetStringField(TEXT("kind"), TEXT("literal"));
	Assignment->SetNumberField(TEXT("value"), 7.0);

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Params->SetStringField(TEXT("target_variable"), TEXT("Score"));
	Params->SetObjectField(TEXT("assignment"), Assignment);
	Params->SetObjectField(TEXT("exec_from"), ExecFrom);
	Params->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> Response = Dispatch(TEXT("add_blueprint_variable_assignment"), Params);
	if (!IsSuccess(Response, Code))
	{
		AddError(FString::Printf(TEXT("assignment with exec_from failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> Result = ResultOf(Response);
	const FString SetNodeId = StringFieldOr(FindRole(Result, TEXT("nodes"), TEXT("set")), TEXT("node_id"));

	// ---- the links[exec] row. A literal assignment on its own reports no links at
	// all (the shipped test asserts exactly that), so this row is entirely exec_from's. ----
	const TArray<TSharedPtr<FJsonValue>>* Links = nullptr;
	TestTrue(TEXT("links array present"), Result->TryGetArrayField(TEXT("links"), Links));
	TestEqual(TEXT("exec_from adds exactly one link to a literal assignment"), Links ? Links->Num() : -1, 1);
	const TSharedPtr<FJsonObject> ExecLink = FindRole(Result, TEXT("links"), TEXT("exec"));
	TestEqual(TEXT("exec link source node"), StringFieldOr(ExecLink, TEXT("source_node_id")), FuncNodeId);
	TestEqual(TEXT("exec link target node"), StringFieldOr(ExecLink, TEXT("target_node_id")), SetNodeId);
	const TSharedPtr<FJsonObject>* ExecSourcePin = nullptr;
	const TSharedPtr<FJsonObject>* ExecTargetPin = nullptr;
	if (ExecLink->TryGetObjectField(TEXT("source_pin"), ExecSourcePin) && ExecSourcePin
		&& ExecLink->TryGetObjectField(TEXT("target_pin"), ExecTargetPin) && ExecTargetPin)
	{
		TestEqual(TEXT("exec link source pin"), StringFieldOr(*ExecSourcePin, TEXT("name")), FString(TEXT("then")));
		TestEqual(TEXT("exec link target pin"), StringFieldOr(*ExecTargetPin, TEXT("name")), FString(TEXT("execute")));
		TestEqual(TEXT("exec link source pin is an exec pin"),
			StringFieldOr(*ExecSourcePin, TEXT("category")), UEdGraphSchema_K2::PC_Exec.ToString());
		TestEqual(TEXT("exec link source pin_id matches the graph pin"),
			StringFieldOr(*ExecSourcePin, TEXT("pin_id")), ThenPin->PinId.ToString());
	}
	else
	{
		AddError(TEXT("links[exec] carried no source_pin / target_pin objects"));
	}

	// The exec_in pin row now reports the link exec_from made.
	TestEqual(TEXT("exec_in pin link_count"),
		(int32)NumberFieldOr(FindRole(Result, TEXT("pins"), TEXT("exec_in")), TEXT("link_count")), 1);

	// ---- graph state ----
	UEdGraphNode* SetNode = FindNodeByGuid(EventGraph, SetNodeId);
	UEdGraphPin* ExecutePin = FindFixturePin(SetNode, {TEXT("execute")}, EGPD_Input);
	if (!SetNode || !ExecutePin)
	{
		AddError(TEXT("the reported set node id did not resolve, or it has no execute pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestTrue(TEXT("the call node's then pin links to the set node's execute pin"), ThenPin->LinkedTo.Contains(ExecutePin));
	TestEqual(TEXT("the execute pin has exactly one link"), ExecutePin->LinkedTo.Num(), 1);

	// ---- error: exec_from carrying node_id but no pin ----
	TSharedPtr<FJsonObject> HalfExec = MakeShared<FJsonObject>();
	HalfExec->SetStringField(TEXT("node_id"), FuncNodeId);
	TSharedPtr<FJsonObject> HalfExecParams = MakeShared<FJsonObject>();
	HalfExecParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	HalfExecParams->SetStringField(TEXT("target_variable"), TEXT("Score"));
	HalfExecParams->SetObjectField(TEXT("assignment"), Assignment);
	HalfExecParams->SetObjectField(TEXT("exec_from"), HalfExec);
	HalfExecParams->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("half-specified exec_from code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), HalfExecParams)),
		FString(TEXT("MISSING_PARAMS")));

	// ---- error: exec_from naming a node that is not in the graph ----
	TSharedPtr<FJsonObject> MissingExec = MakeShared<FJsonObject>();
	MissingExec->SetStringField(TEXT("node_id"), FGuid::NewGuid().ToString());
	MissingExec->SetStringField(TEXT("pin"), TEXT("then"));
	TSharedPtr<FJsonObject> MissingExecParams = MakeShared<FJsonObject>();
	MissingExecParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	MissingExecParams->SetStringField(TEXT("target_variable"), TEXT("Score"));
	MissingExecParams->SetObjectField(TEXT("assignment"), Assignment);
	MissingExecParams->SetObjectField(TEXT("exec_from"), MissingExec);
	MissingExecParams->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("unknown exec_from node code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), MissingExecParams)),
		FString(TEXT("NODE_NOT_FOUND")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 3: Build and run**

Close the editor, then from the repo root:

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `PASS UEMCP.BlueprintHandlers.AssignmentExecFrom` and **`Native tests: 24 passed, 0 failed, 0 not run`**.

If the arrange step returns `FUNCTION_NOT_FOUND`, the target-class resolution did not reach `UKismetSystemLibrary` — the handler tries `KismetSystemLibrary`, `UKismetSystemLibrary` and `/Script/Engine.KismetSystemLibrary` in that order (`BlueprintHandlers.cpp:2095-2107`). If `default_object` is absent, `UEdGraphSchema_K2::TrySetDefaultObject` rejected the class rather than writing it; read `ApplyNodePinDefaults` (`:726-789`) before touching the assertion.

- [ ] **Step 4: Prove the assertions bind (deliberate falsification)**

Temporarily expect the class pin to report a `default_object` the arrange step did not set (no new include needed — the comparison is against a literal):

```cpp
	TestEqual(TEXT("class pin default_object"), StringFieldOr(ClassPinJson, TEXT("default_object")), FString(TEXT("/Script/Engine.NotAClass")));
```

Rebuild and run.

Expected: `FAIL UEMCP.BlueprintHandlers.AssignmentExecFrom` and `Native tests: 23 passed, 1 failed, 0 not run`. **Restore the assertion**, rebuild, and confirm `Native tests: 24 passed, 0 failed, 0 not run`.

- [ ] **Step 5: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color
```

Expected: 0 collisions; the target reads `SYNC`.

- [ ] **Step 6: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Cover exec_from on add_blueprint_variable_assignment, and PinToJson's default_object

exec_from is the block that wires a new variable-set node into an existing
execution chain, and none of it ran under test: not the links[exec] row, not
the MISSING_PARAMS guard for a half-specified block, not the NODE_NOT_FOUND
for a node id that is not in the graph.

The exec source is authored by dispatching add_blueprint_function_node through
the same registry, so the arrangement is shipped behaviour rather than a
reach into the editor API. That call is also the only response in reach whose
pins carry a DefaultObject: SphereOverlapActors takes a plain UClass*
parameter, so setting its default exercises PinToJson's default_object branch
without the pin-reshaping that a DeterminesOutputType parameter would bring.
The expected path is computed from the class rather than spelled out.

FindRole now delegates to a new FindEntryByField, which is what can locate a
pin in add_blueprint_function_node's flat pins array, whose rows carry no role.
FindRole keeps its signature, so no existing call site changes.

Native tests 23 -> 24.
MSG
```

---

### Task 3: `disconnect_blueprint_pin` — ambiguity, `target_direction`, and the dry-run report

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` — one test appended before `#endif // WITH_DEV_AUTOMATION_TESTS`

**Interfaces:**
- Consumes from the shipped fixture and Tasks 1-2, all in `namespace UEMCP::Blueprint::Tests`: `FFixtureBlueprint`, `CreateFixtureBlueprint()`, `AddFixtureVariable(UBlueprint*, const FString&, FName, FName)`, `DestroyFixtureBlueprint(FFixtureBlueprint&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `ErrorCodeOf(const TSharedPtr<FJsonObject>&)`, `ResultOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `NumberFieldOr(const TSharedPtr<FJsonObject>&, const FString&, double)`, `FindRole(const TSharedPtr<FJsonObject>&, const FString&, const FString&)`, `FixtureEventGraph(UBlueprint*)`, `FindNodeByGuid(UEdGraph*, const FString&)`, `FindFixturePin(UEdGraphNode*, const TArray<FString>&, EEdGraphPinDirection)`.
- Produces: nothing new.

- [ ] **Step 1: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the Task 2 test and before `#endif // WITH_DEV_AUTOMATION_TESTS`.

Note on the first arrangement: a `UK2Node_VariableSet` for a member variable named `then` carries an **input** data pin `then` (the variable, `UK2Node_Variable::CreatePinForVariable` names it after the variable) and the **output** exec pin `UEdGraphSchema_K2::PN_Then`, also `then`. That is the only cross-direction pin-name collision reachable through these handlers: every other pin name here comes from a unique `UFunction` parameter or from the distinct exec names `execute` / `then`, and `UK2Node_VariableSet`'s own value output is named `Output_Get` (engine `K2Node_VariableSet.cpp:398-401`), not after the variable. **Fallback if `FBlueprintEditorUtils::AddMemberVariable` refuses the name `then`** (the arrange dispatch then returns `VARIABLE_NOT_FOUND` and the test stops with the message below): delete the `then`-variable arrangement and instead add a same-named opposite-direction pin to the timer node arranged further down, immediately after it is resolved —

```cpp
	TimerNode->CreatePin(EGPD_Output, UEdGraphSchema_K2::PC_Exec, FName(TEXT("execute")));
```

— then run the `PIN_AMBIGUOUS` and disambiguated dispatches against `TimerNodeId` with pin `execute` instead of `then`. Use the fallback only on that failure; the variable route is preferred because it reaches the branch entirely through shipped handlers.

```cpp
// =====================================================================================
// disconnect_blueprint_pin — the edges the shipped DisconnectPin test leaves: the
// PIN_AMBIGUOUS branch, target_direction parsing on the target side, and the
// would_* / pin_info fields that only a dry run reports honestly.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersDisconnectPinEdgesTest,
	"UEMCP.BlueprintHandlers.DisconnectPinEdges",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersDisconnectPinEdgesTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// ---- arrange A: a node carrying one pin name in both directions ----
	// A variable-set node for a member variable named "then" has an input data pin
	// "then" and the output exec pin PN_Then, also "then". K2Node_VariableSet's own
	// value output is named "Output_Get", so this is the collision, not that pin.
	AddFixtureVariable(Fixture.Blueprint, TEXT("then"), UEdGraphSchema_K2::PC_Int);

	TSharedPtr<FJsonObject> ThenAssignment = MakeShared<FJsonObject>();
	ThenAssignment->SetStringField(TEXT("kind"), TEXT("literal"));
	ThenAssignment->SetNumberField(TEXT("value"), 1.0);
	TSharedPtr<FJsonObject> ThenParams = MakeShared<FJsonObject>();
	ThenParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	ThenParams->SetStringField(TEXT("target_variable"), TEXT("then"));
	ThenParams->SetObjectField(TEXT("assignment"), ThenAssignment);
	ThenParams->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> ThenResponse = Dispatch(TEXT("add_blueprint_variable_assignment"), ThenParams);
	FString Code;
	if (!IsSuccess(ThenResponse, Code))
	{
		AddError(FString::Printf(
			TEXT("arrange failed: no set node for a member variable named 'then' (code '%s'); see the fallback in this test's plan step"),
			*Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const FString ThenSetNodeId = StringFieldOr(FindRole(ResultOf(ThenResponse), TEXT("nodes"), TEXT("set")), TEXT("node_id"));
	if (ThenSetNodeId.IsEmpty())
	{
		AddError(TEXT("arrange step produced no set node id"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// ---- PIN_AMBIGUOUS: one name, both directions, no direction given ----
	TSharedPtr<FJsonObject> Ambiguous = MakeShared<FJsonObject>();
	Ambiguous->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Ambiguous->SetStringField(TEXT("node_id"), ThenSetNodeId);
	Ambiguous->SetStringField(TEXT("pin"), TEXT("then"));
	Ambiguous->SetBoolField(TEXT("dry_run"), true);
	Ambiguous->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("ambiguous pin code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), Ambiguous)),
		FString(TEXT("PIN_AMBIGUOUS")));

	// ---- the same call plus a direction resolves, which is what proves the
	// ambiguity — not a missing pin — was the cause ----
	TSharedPtr<FJsonObject> Disambiguated = MakeShared<FJsonObject>();
	Disambiguated->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Disambiguated->SetStringField(TEXT("node_id"), ThenSetNodeId);
	Disambiguated->SetStringField(TEXT("pin"), TEXT("then"));
	Disambiguated->SetStringField(TEXT("direction"), TEXT("input"));
	Disambiguated->SetBoolField(TEXT("dry_run"), true);
	Disambiguated->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> DisambiguatedResponse = Dispatch(TEXT("disconnect_blueprint_pin"), Disambiguated);
	if (!IsSuccess(DisambiguatedResponse, Code))
	{
		AddError(FString::Printf(TEXT("the disambiguated dry run failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> DisambiguatedResult = ResultOf(DisambiguatedResponse);
	TestEqual(TEXT("resolved direction"), StringFieldOr(DisambiguatedResult, TEXT("direction")), FString(TEXT("input")));
	TestEqual(TEXT("an unlinked pin matches nothing"), (int32)DisambiguatedResult->GetNumberField(TEXT("links_matched")), 0);
	TestFalse(TEXT("would_modify false with nothing linked"), DisambiguatedResult->GetBoolField(TEXT("would_modify")));
	TestFalse(TEXT("would_require_compile false with nothing linked"), DisambiguatedResult->GetBoolField(TEXT("would_require_compile")));

	// ---- arrange B: BeginPlay.then -> Timer.execute, so there is a link to report on ----
	TSharedPtr<FJsonObject> TimerParams = MakeShared<FJsonObject>();
	TimerParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	TimerParams->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPEdgesFixtureTimer"));
	TimerParams->SetNumberField(TEXT("interval"), 1.0);
	TimerParams->SetBoolField(TEXT("create_callback_graph"), true);
	TimerParams->SetBoolField(TEXT("insert_on_begin_play"), true);
	TimerParams->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> TimerResponse = Dispatch(TEXT("add_blueprint_timer"), TimerParams);
	if (!IsSuccess(TimerResponse, Code))
	{
		AddError(FString::Printf(TEXT("arrange step failed: add_blueprint_timer returned '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> TimerResult = ResultOf(TimerResponse);
	const FString BeginPlayId = StringFieldOr(TimerResult, TEXT("begin_play_node_id"));
	const FString TimerNodeId = StringFieldOr(TimerResult, TEXT("timer_node_id"));
	// Guarded before use: begin_play_node_id is conditional in the handler, and
	// FindNodeByGuid returns null for an empty id — without this, a missing field
	// would surface as the "did not link" error below and point at the wrong cause.
	if (BeginPlayId.IsEmpty() || TimerNodeId.IsEmpty())
	{
		AddError(TEXT("arrange step produced no begin-play or timer node id"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	UEdGraphNode* BeginPlayNode = FindNodeByGuid(EventGraph, BeginPlayId);
	UEdGraphNode* TimerNode = FindNodeByGuid(EventGraph, TimerNodeId);
	UEdGraphPin* ThenPin = FindFixturePin(BeginPlayNode, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecutePin = FindFixturePin(TimerNode, {TEXT("execute")}, EGPD_Input);
	if (!ThenPin || !ExecutePin || !ThenPin->LinkedTo.Contains(ExecutePin))
	{
		AddError(TEXT("arrange step did not link begin play then to the timer execute pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// Every dispatch below is a dry run, so the link survives all of them and each
	// one reads the same arranged state.
	auto MakeDryParams = [&Fixture, &BeginPlayId]()
	{
		TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
		Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
		Params->SetStringField(TEXT("node_id"), BeginPlayId);
		Params->SetStringField(TEXT("pin"), TEXT("then"));
		Params->SetStringField(TEXT("direction"), TEXT("output"));
		Params->SetBoolField(TEXT("dry_run"), true);
		Params->SetBoolField(TEXT("compile"), false);
		return Params;
	};

	// ---- the dry-run report on a linked pin ----
	const TSharedPtr<FJsonObject> DryResponse = Dispatch(TEXT("disconnect_blueprint_pin"), MakeDryParams());
	if (!IsSuccess(DryResponse, Code))
	{
		AddError(FString::Printf(TEXT("dry run on the linked pin failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> DryResult = ResultOf(DryResponse);
	TestEqual(TEXT("dry run matched one link"), (int32)DryResult->GetNumberField(TEXT("links_matched")), 1);
	TestEqual(TEXT("dry run broke nothing"), (int32)DryResult->GetNumberField(TEXT("links_broken")), 0);
	TestTrue(TEXT("would_modify true with a link present"), DryResult->GetBoolField(TEXT("would_modify")));
	TestTrue(TEXT("would_require_compile true with a link present"), DryResult->GetBoolField(TEXT("would_require_compile")));
	TestFalse(TEXT("requires_compile stays false on a dry run"), DryResult->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("compiled false on a dry run"), DryResult->GetBoolField(TEXT("compiled")));

	// pin_info is built at the end of the handler, so on a dry run — where nothing
	// was broken — its link_count is both correct and stable. The shipped test
	// deliberately asserts only name and direction on target_pin_info, which is
	// built before the break and is therefore stale on a real disconnect (BUG-2 in
	// docs/tracking/backlog.md); that asymmetry is why this assertion lives here.
	const TSharedPtr<FJsonObject>* PinInfo = nullptr;
	if (DryResult->TryGetObjectField(TEXT("pin_info"), PinInfo) && PinInfo)
	{
		TestEqual(TEXT("pin_info name"), StringFieldOr(*PinInfo, TEXT("name")), FString(TEXT("then")));
		TestEqual(TEXT("pin_info direction"), StringFieldOr(*PinInfo, TEXT("direction")), FString(TEXT("output")));
		TestEqual(TEXT("pin_info category"), StringFieldOr(*PinInfo, TEXT("category")), UEdGraphSchema_K2::PC_Exec.ToString());
		TestEqual(TEXT("pin_info link_count"), (int32)NumberFieldOr(*PinInfo, TEXT("link_count")), 1);
		TestEqual(TEXT("pin_info pin_id matches the graph pin"), StringFieldOr(*PinInfo, TEXT("pin_id")), ThenPin->PinId.ToString());
	}
	else
	{
		AddError(TEXT("the dry-run response carried no pin_info"));
	}

	// ---- target_direction: rejected when unparseable ----
	TSharedPtr<FJsonObject> BadTargetDirection = MakeDryParams();
	BadTargetDirection->SetStringField(TEXT("target_node_id"), TimerNodeId);
	BadTargetDirection->SetStringField(TEXT("target_pin"), TEXT("execute"));
	BadTargetDirection->SetStringField(TEXT("target_direction"), TEXT("sideways"));
	TestEqual(TEXT("unparseable target_direction code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), BadTargetDirection)),
		FString(TEXT("INVALID_DIRECTION")));

	// ---- target_direction: parsed and actually applied. "execute" is an input pin,
	// so asking for it on the output side must miss rather than fall back. ----
	TSharedPtr<FJsonObject> WrongTargetDirection = MakeDryParams();
	WrongTargetDirection->SetStringField(TEXT("target_node_id"), TimerNodeId);
	WrongTargetDirection->SetStringField(TEXT("target_pin"), TEXT("execute"));
	WrongTargetDirection->SetStringField(TEXT("target_direction"), TEXT("output"));
	TestEqual(TEXT("target_direction pointing the wrong way code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), WrongTargetDirection)),
		FString(TEXT("PIN_NOT_FOUND")));

	// ---- target_direction: the explicit correct value behaves like the inferred one ----
	TSharedPtr<FJsonObject> RightTargetDirection = MakeDryParams();
	RightTargetDirection->SetStringField(TEXT("target_node_id"), TimerNodeId);
	RightTargetDirection->SetStringField(TEXT("target_pin"), TEXT("execute"));
	RightTargetDirection->SetStringField(TEXT("target_direction"), TEXT("input"));

	const TSharedPtr<FJsonObject> RightResponse = Dispatch(TEXT("disconnect_blueprint_pin"), RightTargetDirection);
	if (!IsSuccess(RightResponse, Code))
	{
		AddError(FString::Printf(TEXT("dry run with an explicit target_direction failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> RightResult = ResultOf(RightResponse);
	TestEqual(TEXT("explicit target_direction still matches the link"), (int32)RightResult->GetNumberField(TEXT("links_matched")), 1);
	TestEqual(TEXT("target_pin echoed"), StringFieldOr(RightResult, TEXT("target_pin")), FString(TEXT("execute")));
	const TSharedPtr<FJsonObject>* TargetPinInfo = nullptr;
	if (RightResult->TryGetObjectField(TEXT("target_pin_info"), TargetPinInfo) && TargetPinInfo)
	{
		// Name and direction only: see the BUG-2 note above for why link_count on
		// this block is not asserted anywhere.
		TestEqual(TEXT("target_pin_info name"), StringFieldOr(*TargetPinInfo, TEXT("name")), FString(TEXT("execute")));
		TestEqual(TEXT("target_pin_info direction"), StringFieldOr(*TargetPinInfo, TEXT("direction")), FString(TEXT("input")));
	}
	else
	{
		AddError(TEXT("the explicit-target dry run carried no target_pin_info"));
	}

	// ---- nothing above was a real break ----
	// Re-resolved rather than reusing ThenPin/ExecutePin from before the four
	// dispatches: none of them compiles, so those pointers are in fact still valid,
	// but re-resolving keeps this file free of the pattern its own constraints
	// forbid and matches how the shipped disconnect test re-reads after a dispatch.
	UEdGraphPin* ThenPinAfter = FindFixturePin(FindNodeByGuid(EventGraph, BeginPlayId), {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecutePinAfter = FindFixturePin(FindNodeByGuid(EventGraph, TimerNodeId), {TEXT("execute")}, EGPD_Input);
	if (!ThenPinAfter || !ExecutePinAfter)
	{
		AddError(TEXT("could not re-resolve then/execute pins after the dry runs"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestTrue(TEXT("every dispatch here was a dry run, so the link is still there"),
		ThenPinAfter->LinkedTo.Contains(ExecutePinAfter));

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Build and run**

Close the editor, then from the repo root:

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `PASS UEMCP.BlueprintHandlers.DisconnectPinEdges` and **`Native tests: 25 passed, 0 failed, 0 not run`**.

If the first arrange step reports `VARIABLE_NOT_FOUND`, apply the `CreatePin` fallback described above this step and re-run — do not weaken the `PIN_AMBIGUOUS` assertion.

- [ ] **Step 3: Prove the assertions bind (deliberate falsification)**

Temporarily expect the wrong code for the ambiguous call:

```cpp
	TestEqual(TEXT("ambiguous pin code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), Ambiguous)),
		FString(TEXT("PIN_NOT_FOUND")));
```

Rebuild and run. Expected: `FAIL UEMCP.BlueprintHandlers.DisconnectPinEdges` and `Native tests: 24 passed, 1 failed, 0 not run`. A failure message reporting the actual code as `PIN_AMBIGUOUS` is the proof this test reaches the branch at all. **Restore `PIN_AMBIGUOUS`**, rebuild, and confirm 25 passed / 0 failed.

- [ ] **Step 4: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color
```

Expected: 0 collisions; the target reads `SYNC`.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Cover disconnect_blueprint_pin's ambiguity, target_direction and dry-run report

Three branches the shipped DisconnectPin test does not reach. PIN_AMBIGUOUS
needs a node whose pin name exists in both directions; a variable-set node for
a member variable named "then" is that node, because its input data pin takes
the variable's name and its output exec pin is PN_Then. The same call with an
explicit direction then succeeds, which is what proves the ambiguity rather
than a missing pin was the cause.

target_direction gets all three shapes: an unparseable value is
INVALID_DIRECTION, a parseable one pointing at the wrong side misses with
PIN_NOT_FOUND rather than falling back, and the explicit correct value behaves
like the inferred default.

The dry-run report now has its would_modify, would_require_compile and pin_info
fields asserted, including pin_info's link_count and pin_id. link_count is
asserted here and not on target_pin_info because that block is built before the
break and is stale on a real disconnect, which backlog BUG-2 already records.

Every dispatch in the test is a dry run, so the arranged link survives all of
them and the last assertion checks exactly that.

Native tests 24 -> 25.
MSG
```

---

### Task 4: the `compile: true` leg of all three handlers

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` — one test appended before `#endif // WITH_DEV_AUTOMATION_TESTS`

**Interfaces:**
- Consumes from the shipped fixture and Tasks 1-3, all in `namespace UEMCP::Blueprint::Tests`: `FFixtureBlueprint`, `CreateFixtureBlueprint()`, `AddFixtureVariable(UBlueprint*, const FString&, FName, FName)`, `DestroyFixtureBlueprint(FFixtureBlueprint&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `ResultOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `NumberFieldOr(const TSharedPtr<FJsonObject>&, const FString&, double)`, `FindRole(const TSharedPtr<FJsonObject>&, const FString&, const FString&)`, `FixtureEventGraph(UBlueprint*)`, `FindNodeByGuid(UEdGraph*, const FString&)`, `FindFixturePin(UEdGraphNode*, const TArray<FString>&, EEdGraphPinDirection)`.
- Produces: nothing new.

- [ ] **Step 1: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the Task 3 test and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// compile:true on all three handlers, in one fixture so each leg builds on the last.
//
// The three are deliberately asymmetric and this test pins that asymmetry:
//   - add_blueprint_variable_assignment calls CompileBlueprint directly and reports
//     only two booleans — no diagnostic block, no compiled_ok, and no COMPILE_FAILED
//     branch anywhere in the handler. Asserting the ABSENCE is what would catch a
//     later "make them consistent" change.
//   - add_blueprint_timer and disconnect_blueprint_pin both go through
//     BuildBlueprintCompileDiagnosticResult and carry the full block.
//   - disconnect_blueprint_pin compiles only when it actually broke something, so a
//     dry run with compile:true must not compile at all.
//
// The assignment handler's CompileBlueprint call passes no options, so unlike the
// other two it does not set SkipGarbageCollection and it can reconstruct node pins.
// Nothing below reuses a node or pin pointer taken before a dispatch.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersCompilePathsTest,
	"UEMCP.BlueprintHandlers.CompilePaths",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersCompilePathsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	AddFixtureVariable(Fixture.Blueprint, TEXT("Score"), UEdGraphSchema_K2::PC_Int);

	// ---- 1. add_blueprint_variable_assignment with compile:true ----
	TSharedPtr<FJsonObject> Assignment = MakeShared<FJsonObject>();
	Assignment->SetStringField(TEXT("kind"), TEXT("literal"));
	Assignment->SetNumberField(TEXT("value"), 5.0);
	TSharedPtr<FJsonObject> AssignParams = MakeShared<FJsonObject>();
	AssignParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	AssignParams->SetStringField(TEXT("target_variable"), TEXT("Score"));
	AssignParams->SetObjectField(TEXT("assignment"), Assignment);
	AssignParams->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> AssignResponse = Dispatch(TEXT("add_blueprint_variable_assignment"), AssignParams);
	FString Code;
	if (!IsSuccess(AssignResponse, Code))
	{
		AddError(FString::Printf(TEXT("assignment with compile:true failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> AssignResult = ResultOf(AssignResponse);
	TestTrue(TEXT("assignment reports compiled"), AssignResult->GetBoolField(TEXT("compiled")));
	TestFalse(TEXT("assignment clears requires_compile"), AssignResult->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("assignment carries no compile block"), AssignResult->HasField(TEXT("compile")));
	TestFalse(TEXT("assignment carries no compiled_ok"), AssignResult->HasField(TEXT("compiled_ok")));

	// Re-resolved from the reported GUID rather than reused, because this handler's
	// compile does not skip garbage collection and may reconstruct pins.
	const FString SetNodeId = StringFieldOr(FindRole(AssignResult, TEXT("nodes"), TEXT("set")), TEXT("node_id"));
	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	UEdGraphNode* SetNode = FindNodeByGuid(EventGraph, SetNodeId);
	UEdGraphPin* ScorePin = FindFixturePin(SetNode, {TEXT("Score")}, EGPD_Input);
	if (!SetNode || !ScorePin)
	{
		AddError(TEXT("the set node or its Score pin did not survive the compile"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("the literal survived the compile"), ScorePin->DefaultValue, FString(TEXT("5")));

	// ---- 2. add_blueprint_timer with compile:true ----
	TSharedPtr<FJsonObject> TimerParams = MakeShared<FJsonObject>();
	TimerParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	TimerParams->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPCompilePathsTimer"));
	TimerParams->SetNumberField(TEXT("interval"), 1.0);
	TimerParams->SetBoolField(TEXT("create_callback_graph"), true);
	TimerParams->SetBoolField(TEXT("insert_on_begin_play"), true);
	TimerParams->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> TimerResponse = Dispatch(TEXT("add_blueprint_timer"), TimerParams);
	if (!IsSuccess(TimerResponse, Code))
	{
		AddError(FString::Printf(
			TEXT("timer with compile:true returned '%s'; on COMPILE_FAILED read detail.compile.errors — a fixture Actor Blueprint carrying one variable-set node and one timer chain is expected to compile clean"),
			*Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> TimerResult = ResultOf(TimerResponse);
	TestTrue(TEXT("timer reports compiled"), TimerResult->GetBoolField(TEXT("compiled")));
	TestFalse(TEXT("timer clears requires_compile on a clean compile"), TimerResult->GetBoolField(TEXT("requires_compile")));
	TestTrue(TEXT("timer reports compiled_ok"), TimerResult->GetBoolField(TEXT("compiled_ok")));

	const TSharedPtr<FJsonObject>* TimerCompile = nullptr;
	if (TimerResult->TryGetObjectField(TEXT("compile"), TimerCompile) && TimerCompile)
	{
		TestTrue(TEXT("timer compile block succeeded"), (*TimerCompile)->GetBoolField(TEXT("succeeded")));
		TestEqual(TEXT("timer compile block reports no errors"), (int32)NumberFieldOr(*TimerCompile, TEXT("num_errors")), 0);
		TestEqual(TEXT("timer compile block names the Blueprint"),
			StringFieldOr(*TimerCompile, TEXT("name")), Fixture.Blueprint->GetName());
		TestEqual(TEXT("timer compile block reports a generated class"),
			StringFieldOr(*TimerCompile, TEXT("generated_class_status")), FString(TEXT("valid")));
	}
	else
	{
		AddError(TEXT("timer with compile:true carried no compile block"));
	}

	const FString BeginPlayId = StringFieldOr(TimerResult, TEXT("begin_play_node_id"));
	const FString TimerNodeId = StringFieldOr(TimerResult, TEXT("timer_node_id"));
	if (BeginPlayId.IsEmpty() || TimerNodeId.IsEmpty())
	{
		AddError(TEXT("the timer response named no begin play or timer node"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// ---- 3. a disconnect dry run with compile:true must not compile ----
	TSharedPtr<FJsonObject> DryParams = MakeShared<FJsonObject>();
	DryParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	DryParams->SetStringField(TEXT("node_id"), BeginPlayId);
	DryParams->SetStringField(TEXT("pin"), TEXT("then"));
	DryParams->SetStringField(TEXT("direction"), TEXT("output"));
	DryParams->SetStringField(TEXT("target_node_id"), TimerNodeId);
	DryParams->SetStringField(TEXT("target_pin"), TEXT("execute"));
	DryParams->SetBoolField(TEXT("dry_run"), true);
	DryParams->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> DryResponse = Dispatch(TEXT("disconnect_blueprint_pin"), DryParams);
	if (!IsSuccess(DryResponse, Code))
	{
		AddError(FString::Printf(TEXT("dry-run disconnect with compile:true failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> DryResult = ResultOf(DryResponse);
	// Also the guard for leg 4: if this were 0 the real break below would break
	// nothing, the handler would never compile, and its assertions would be vacuous.
	TestEqual(TEXT("the dry run found the link the real break needs"), (int32)DryResult->GetNumberField(TEXT("links_matched")), 1);
	TestFalse(TEXT("a dry run never reports compiled"), DryResult->GetBoolField(TEXT("compiled")));
	TestFalse(TEXT("a dry run carries no compile block"), DryResult->HasField(TEXT("compile")));
	TestFalse(TEXT("a dry run carries no compiled_ok"), DryResult->HasField(TEXT("compiled_ok")));

	// ---- 4. the real disconnect with compile:true ----
	TSharedPtr<FJsonObject> BreakParams = MakeShared<FJsonObject>();
	BreakParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	BreakParams->SetStringField(TEXT("node_id"), BeginPlayId);
	BreakParams->SetStringField(TEXT("pin"), TEXT("then"));
	BreakParams->SetStringField(TEXT("direction"), TEXT("output"));
	BreakParams->SetStringField(TEXT("target_node_id"), TimerNodeId);
	BreakParams->SetStringField(TEXT("target_pin"), TEXT("execute"));
	BreakParams->SetBoolField(TEXT("dry_run"), false);
	BreakParams->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> BreakResponse = Dispatch(TEXT("disconnect_blueprint_pin"), BreakParams);
	if (!IsSuccess(BreakResponse, Code))
	{
		AddError(FString::Printf(TEXT("disconnect with compile:true failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> BreakResult = ResultOf(BreakResponse);
	TestEqual(TEXT("the real break broke one link"), (int32)BreakResult->GetNumberField(TEXT("links_broken")), 1);
	TestTrue(TEXT("disconnect reports compiled"), BreakResult->GetBoolField(TEXT("compiled")));
	TestFalse(TEXT("disconnect clears requires_compile on a clean compile"), BreakResult->GetBoolField(TEXT("requires_compile")));
	TestTrue(TEXT("disconnect reports compiled_ok"), BreakResult->GetBoolField(TEXT("compiled_ok")));

	const TSharedPtr<FJsonObject>* BreakCompile = nullptr;
	if (BreakResult->TryGetObjectField(TEXT("compile"), BreakCompile) && BreakCompile)
	{
		TestTrue(TEXT("disconnect compile block succeeded"), (*BreakCompile)->GetBoolField(TEXT("succeeded")));
		TestEqual(TEXT("disconnect compile block reports no errors"), (int32)NumberFieldOr(*BreakCompile, TEXT("num_errors")), 0);
	}
	else
	{
		AddError(TEXT("the real disconnect with compile:true carried no compile block"));
	}

	// ---- the graph after the compiling break, re-resolved from the reported ids ----
	UEdGraphNode* BeginPlayAfter = FindNodeByGuid(EventGraph, BeginPlayId);
	UEdGraphNode* TimerAfter = FindNodeByGuid(EventGraph, TimerNodeId);
	UEdGraphPin* ThenAfter = FindFixturePin(BeginPlayAfter, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecuteAfter = FindFixturePin(TimerAfter, {TEXT("execute")}, EGPD_Input);
	if (!ThenAfter || !ExecuteAfter)
	{
		AddError(TEXT("could not re-resolve then/execute pins after the compiling break"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestFalse(TEXT("the link is gone after a compiling break"), ThenAfter->LinkedTo.Contains(ExecuteAfter));

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Build and run**

Close the editor, then from the repo root:

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `PASS UEMCP.BlueprintHandlers.CompilePaths` and **`Native tests: 26 passed, 0 failed, 0 not run`**.

If leg 2 reports `COMPILE_FAILED`, read the error messages in the failure text before touching anything: the fixture is supposed to compile clean, and a real compile error here is a finding about the handlers, not about the test.

- [ ] **Step 3: Prove the assertions bind (deliberate falsification)**

Temporarily claim the assignment handler does carry a diagnostic block:

```cpp
	TestTrue(TEXT("assignment carries no compile block"), AssignResult->HasField(TEXT("compile")));
```

Rebuild and run. Expected: `FAIL UEMCP.BlueprintHandlers.CompilePaths` and `Native tests: 25 passed, 1 failed, 0 not run`. **Restore `TestFalse`**, rebuild, and confirm 26 passed / 0 failed.

- [ ] **Step 4: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color
```

Expected: 0 collisions; the target reads `SYNC`.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Cover the compile:true leg of all three tested Blueprint handlers

Every shipped handler test passes compile:false, so the compiling half of each
handler had never run. One fixture now walks all four legs in order.

The three handlers are asymmetric and the test pins the asymmetry rather than
smoothing it over. add_blueprint_variable_assignment calls CompileBlueprint
directly and reports only compiled and requires_compile — no diagnostic block,
no compiled_ok, and no COMPILE_FAILED branch exists in it at all; asserting
that absence is what would catch a later change that "makes them consistent".
add_blueprint_timer and disconnect_blueprint_pin both carry the full block, and
their succeeded / num_errors / name / generated_class_status fields are checked.

disconnect_blueprint_pin compiles only when it broke something, so a dry run
with compile:true must report compiled false and carry no block; the dry run
also asserts links_matched is 1, which is what stops the real break's
assertions from being vacuous.

No node or pin pointer crosses a compiling dispatch: the assignment handler's
CompileBlueprint call passes no options, so it does not skip garbage collection
and can reconstruct pins. Everything is re-resolved from the reported GUIDs.

Native tests 25 -> 26.
MSG
```

---

### Task 5: `add_blueprint_timer` — `NO_GRAPH`, `COMPILE_FAILED` and `RollbackTimerAuthoring`

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` — one include, one helper added with `CreateFixtureBlueprint` reduced to a call of it, one test appended before `#endif // WITH_DEV_AUTOMATION_TESTS`

**Interfaces:**
- Consumes from the shipped fixture and Tasks 1-4, all in `namespace UEMCP::Blueprint::Tests`: `FFixtureBlueprint`, `CreateFixtureBlueprint()`, `DestroyFixtureBlueprint(FFixtureBlueprint&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `ErrorCodeOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `NumberFieldOr(const TSharedPtr<FJsonObject>&, const FString&, double)`, `FixtureEventGraph(UBlueprint*)`, `FindNodeByGuid(UEdGraph*, const FString&)`.
- Produces, in `namespace UEMCP::Blueprint::Tests`:
  - `FFixtureBlueprint CreateFixtureBlueprintOfType(UClass* ParentClass, EBlueprintType BlueprintType)`
  - `CreateFixtureBlueprint()` keeps its exact signature and behaviour — it becomes a one-line call of the new helper, so none of the four earlier tests change.

- [ ] **Step 1: Add the `UBlueprintFunctionLibrary` include**

In the include block, immediately before `#include "Kismet2/BlueprintEditorUtils.h"` (keeping the block alphabetical):

```cpp
#include "Kismet/BlueprintFunctionLibrary.h"
```

- [ ] **Step 2: Generalize the fixture factory**

Inside `namespace UEMCP::Blueprint::Tests`, replace the whole existing `CreateFixtureBlueprint` block (its doc comment and body) with these two functions, in this order:

```cpp
	/**
	 * Blueprint of the given parent class and type, in a fresh in-memory package.
	 * The object name equals the package leaf — see the file header for why that is
	 * load-bearing. The type matters to more than the parent class: only
	 * BPTYPE_Normal and BPTYPE_LevelScript get an EventGraph
	 * (FBlueprintEditorUtils::DoesSupportEventGraphs), which is how a fixture with
	 * no event graph is built.
	 */
	FFixtureBlueprint CreateFixtureBlueprintOfType(UClass* ParentClass, EBlueprintType BlueprintType)
	{
		FFixtureBlueprint Fixture;
		const FString Leaf = FString::Printf(TEXT("BP_UEMCPFixture_%s"),
			*FGuid::NewGuid().ToString(EGuidFormats::Short));
		Fixture.PackagePath = FString::Printf(TEXT("%s/%s"), FixtureRoot, *Leaf);
		Fixture.Package = CreatePackage(*Fixture.PackagePath);
		if (!Fixture.Package)
		{
			return Fixture;
		}
		Fixture.Blueprint = FKismetEditorUtilities::CreateBlueprint(
			ParentClass,
			Fixture.Package,
			FName(*Leaf),
			BlueprintType,
			UBlueprint::StaticClass(),
			UBlueprintGeneratedClass::StaticClass());
		if (Fixture.Blueprint)
		{
			FAssetRegistryModule::AssetCreated(Fixture.Blueprint);
		}
		return Fixture;
	}

	/** Actor-parented Blueprint with an EventGraph — what every test but one wants. */
	FFixtureBlueprint CreateFixtureBlueprint()
	{
		return CreateFixtureBlueprintOfType(AActor::StaticClass(), BPTYPE_Normal);
	}
```

- [ ] **Step 3: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the Task 4 test and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// add_blueprint_timer's two remaining reachable failures.
//
// NO_GRAPH needs a Blueprint with no event graph. FBlueprintEditorUtils::
// DoesSupportEventGraphs admits only BPTYPE_Normal and BPTYPE_LevelScript, so
// CreateBlueprint gives a BPTYPE_FunctionLibrary none, and FindEventGraph only
// searches — it never creates one — so the handler's FindOrCreateEventGraph returns
// null.
//
// COMPILE_FAILED needs a Blueprint that cannot compile. UK2Node_Event::
// ValidateNodeDuringCompilation logs an Error when bOverrideFunction is set and the
// referenced member does not resolve, and add_blueprint_event_node sets
// bOverrideFunction for any name it is given — so one dispatch plants a node that is
// guaranteed to fail compilation, without touching the editor API. That same path is
// the only way to see RollbackTimerAuthoring undo its work.
//
// The two other failure branches in this handler are unreachable from the wire
// surface and are deliberately not tested: TIMER_FUNCTION_NOT_FOUND needs
// UKismetSystemLibrary::K2_SetTimer to be absent from a loaded Engine module, and
// CREATE_FAILED needs NewObject to return null.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersTimerFailuresTest,
	"UEMCP.BlueprintHandlers.TimerFailures",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersTimerFailuresTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	// ---- NO_GRAPH ----
	FFixtureBlueprint Library = CreateFixtureBlueprintOfType(
		UBlueprintFunctionLibrary::StaticClass(), BPTYPE_FunctionLibrary);
	if (!Library.Blueprint)
	{
		AddError(TEXT("function-library fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Library);
		return false;
	}
	TestEqual(TEXT("a function library has no ubergraph"), Library.Blueprint->UbergraphPages.Num(), 0);

	TSharedPtr<FJsonObject> LibraryParams = MakeShared<FJsonObject>();
	LibraryParams->SetStringField(TEXT("blueprint_name"), Library.PackagePath);
	LibraryParams->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPLibraryTimer"));
	LibraryParams->SetNumberField(TEXT("interval"), 1.0);
	LibraryParams->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("no event graph code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), LibraryParams)),
		FString(TEXT("NO_GRAPH")));
	DestroyFixtureBlueprint(Library);

	// ---- COMPILE_FAILED and the rollback it triggers ----
	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// Plant a node that cannot compile. add_blueprint_event_node has no compile
	// parameter, so this dispatch only authors the node.
	TSharedPtr<FJsonObject> EventParams = MakeShared<FJsonObject>();
	EventParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	EventParams->SetStringField(TEXT("event_name"), TEXT("UEMCPMissingEventForCompileFailure"));

	FString Code;
	if (!IsSuccess(Dispatch(TEXT("add_blueprint_event_node"), EventParams), Code))
	{
		AddError(FString::Printf(TEXT("arrange step failed: add_blueprint_event_node returned '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	const FString CallbackName = TEXT("OnUEMCPRollbackTimer");
	TSharedPtr<FJsonObject> TimerParams = MakeShared<FJsonObject>();
	TimerParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	TimerParams->SetStringField(TEXT("callback_function"), CallbackName);
	TimerParams->SetNumberField(TEXT("interval"), 1.0);
	TimerParams->SetBoolField(TEXT("create_callback_graph"), true);
	TimerParams->SetBoolField(TEXT("insert_on_begin_play"), true);
	TimerParams->SetBoolField(TEXT("compile"), true);

	const TSharedPtr<FJsonObject> TimerResponse = Dispatch(TEXT("add_blueprint_timer"), TimerParams);
	TestEqual(TEXT("compile failure code"), ErrorCodeOf(TimerResponse), FString(TEXT("COMPILE_FAILED")));

	// The handler passes its whole result object as the error DETAIL, not as result —
	// the same slot UNSUPPORTED_ASSIGNMENT_KIND uses. ResultOf would return an empty
	// object here and every assertion below would pass vacuously.
	const TSharedPtr<FJsonObject>* Detail = nullptr;
	if (!TimerResponse.IsValid() || !TimerResponse->TryGetObjectField(TEXT("detail"), Detail) || !Detail)
	{
		AddError(TEXT("COMPILE_FAILED carried no detail object"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestTrue(TEXT("detail reports compiled"), (*Detail)->GetBoolField(TEXT("compiled")));
	TestTrue(TEXT("detail keeps requires_compile set after a failed compile"), (*Detail)->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("detail reports compiled_ok false"), (*Detail)->GetBoolField(TEXT("compiled_ok")));
	TestEqual(TEXT("detail names the callback graph"), StringFieldOr(*Detail, TEXT("callback_graph_name")), CallbackName);
	TestTrue(TEXT("detail reports the callback graph was created"), (*Detail)->GetBoolField(TEXT("function_graph_created")));

	const TSharedPtr<FJsonObject>* CompileBlock = nullptr;
	if ((*Detail)->TryGetObjectField(TEXT("compile"), CompileBlock) && CompileBlock)
	{
		TestFalse(TEXT("the compile block did not succeed"), (*CompileBlock)->GetBoolField(TEXT("succeeded")));
		TestTrue(TEXT("the compile block reports at least one error"), NumberFieldOr(*CompileBlock, TEXT("num_errors")) >= 1.0);

		// Matched loosely on purpose: the engine text is "Missing Event '{0}' for @@"
		// and FCompilerResultsLog substitutes the @@ token at report time.
		const TArray<TSharedPtr<FJsonValue>>* Errors = nullptr;
		bool bSawMissingEvent = false;
		if ((*CompileBlock)->TryGetArrayField(TEXT("errors"), Errors) && Errors)
		{
			for (const TSharedPtr<FJsonValue>& Entry : *Errors)
			{
				const TSharedPtr<FJsonObject>* Obj = nullptr;
				bSawMissingEvent |= (Entry.IsValid() && Entry->TryGetObject(Obj) && Obj
					&& StringFieldOr(*Obj, TEXT("message")).Contains(TEXT("Missing Event")));
			}
		}
		TestTrue(TEXT("the planted event is the reported error"), bSawMissingEvent);
	}
	else
	{
		AddError(TEXT("the COMPILE_FAILED detail carried no compile block"));
	}

	// ---- RollbackTimerAuthoring: everything the handler authored is gone again ----
	const FString TimerNodeId = StringFieldOr(*Detail, TEXT("timer_node_id"));
	const FString SelfNodeId = StringFieldOr(*Detail, TEXT("self_node_id"));
	const FString BeginPlayId = StringFieldOr(*Detail, TEXT("begin_play_node_id"));
	// Asserted non-empty first: FindNodeByGuid returns null for an empty id, so
	// without this the three TestNull calls below could pass on missing fields.
	TestFalse(TEXT("detail names the timer node"), TimerNodeId.IsEmpty());
	TestFalse(TEXT("detail names the self node"), SelfNodeId.IsEmpty());
	TestFalse(TEXT("detail names the begin play node"), BeginPlayId.IsEmpty());

	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	TestNull(TEXT("the timer node was rolled back"), FindNodeByGuid(EventGraph, TimerNodeId));
	TestNull(TEXT("the self node was rolled back"), FindNodeByGuid(EventGraph, SelfNodeId));
	TestNull(TEXT("the begin play node was rolled back"), FindNodeByGuid(EventGraph, BeginPlayId));

	bool bCallbackGraphPresent = false;
	for (UEdGraph* Graph : Fixture.Blueprint->FunctionGraphs)
	{
		bCallbackGraphPresent |= (Graph && Graph->GetName() == CallbackName);
	}
	TestFalse(TEXT("the callback function graph was rolled back"), bCallbackGraphPresent);

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 4: Build and run**

Close the editor, then from the repo root:

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `PASS UEMCP.BlueprintHandlers.TimerFailures` and **`Native tests: 27 passed, 0 failed, 0 not run`**, and the four earlier Blueprint-handler tests still passing — Step 2 touched a helper all of them use.

**If a rollback assertion fails**, that is a handler defect, not a test to weaken: nodes the handler reported are surviving `RollbackTimerAuthoring`. Stop, keep the assertion exactly as written, and report it per **§If a test proves a defect**.

- [ ] **Step 5: Prove the assertions bind (deliberate falsification)**

Temporarily expect the timer node to survive the rollback:

```cpp
	TestNotNull(TEXT("the timer node was rolled back"), FindNodeByGuid(EventGraph, TimerNodeId));
```

Rebuild and run. Expected: `FAIL UEMCP.BlueprintHandlers.TimerFailures` and `Native tests: 26 passed, 1 failed, 0 not run`. **Restore `TestNull`**, rebuild, and confirm 27 passed / 0 failed.

- [ ] **Step 6: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color
```

Expected: 0 collisions; the target reads `SYNC`.

- [ ] **Step 7: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Cover add_blueprint_timer's NO_GRAPH, COMPILE_FAILED and rollback

Both remaining reachable failures of this handler, each arranged through the
registry rather than the editor API.

NO_GRAPH needs a Blueprint with no event graph. Only BPTYPE_Normal and
BPTYPE_LevelScript get one, so a BPTYPE_FunctionLibrary fixture has none and
the handler's FindOrCreateEventGraph returns null — FindEventGraph only
searches, it never creates. CreateFixtureBlueprint now delegates to a
CreateFixtureBlueprintOfType that takes the parent class and type; its own
signature is unchanged, so no earlier test moves.

COMPILE_FAILED needs a Blueprint that cannot compile. One
add_blueprint_event_node dispatch for a name that does not exist plants an
override event whose member never resolves, which the engine reports as a
compile Error rather than a warning. That is also the only route to
RollbackTimerAuthoring: the test then asserts the timer, self and begin-play
nodes the response named are all absent from the graph and the callback
function graph is off the Blueprint.

The node ids come out of the error's detail object, not result — the handler
passes its whole result as the error detail, and reading result would have made
every rollback assertion pass vacuously. The compiler message is matched on a
substring because the engine substitutes a token into it.

TIMER_FUNCTION_NOT_FOUND and CREATE_FAILED stay untested on purpose: one needs
K2_SetTimer absent from a loaded Engine module, the other needs NewObject to
return null. Neither is reachable from any parameter, which is the surface a
handler test drives.

Native tests 26 -> 27.
MSG
```

---

### Task 6: Record the new count and the third quirk

**Files:**
- Modify: `CLAUDE.md:421`
- Modify: `docs/tracking/backlog.md` (one bullet appended to the existing BUG-2 entry)
- Modify: `docs/tracking/risks-and-decisions.md` (one row appended after D197)

**Interfaces:**
- Consumes: the final count of 27 from Tasks 1-5.
- Produces: nothing consumed by later tasks (this is the last).

- [ ] **Step 1: Verify the number this task is about to write down**

```bash
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
```

Expected: `Native tests: 27 passed, 0 failed, 0 not run`. If it differs, stop — do not write a number the runner does not report.

- [ ] **Step 2: Update the CLAUDE.md count**

In `CLAUDE.md`, replace this fragment:

```
**Native plugin tests**: 22 UE automation tests live in
```

with:

```
**Native plugin tests**: 27 UE automation tests live in
```

Nothing else in that sentence changes: the file list already names all four test files, and the clause naming `add_blueprint_variable_assignment`, `add_blueprint_timer` and `disconnect_blueprint_pin` stays true — every test added by this plan targets those same three handlers.

- [ ] **Step 3: Append the third quirk to BUG-2**

In `docs/tracking/backlog.md`, in the existing `### BUG-2 — Two pre-existing quirks surfaced by the WS5a handler tests …` entry, insert this bullet immediately before the `- **Trigger**:` line, and change that heading's word `Two` to `Three`:

```markdown
- `HandleAddBlueprintVariableAssignment` sets `requires_compile = !bCompile` and `compiled = bCompile` (`BlueprintHandlers.cpp:~2578-2579`) without consulting whether the compile it just ran succeeded, and it has no `COMPILE_FAILED` branch at all — unlike `add_blueprint_timer` and `disconnect_blueprint_pin`, which both derive `requires_compile` from `compiled_ok` and fail the call when the compile does. A caller passing `compile: true` to the assignment handler is told the Blueprint compiled whether or not it did. `UEMCP.BlueprintHandlers.CompilePaths` asserts the current shape, including the absence of the `compile` block, so a fix has to update that test deliberately.
```

- [ ] **Step 4: Append the D198 row**

In `docs/tracking/risks-and-decisions.md`, add one row immediately after the `| D197 | … |` row, in the existing `| # | Decision | Rationale / Source |` format (one line, no embedded newlines, inner pipes escaped as `\|`):

```markdown
| D198 | **Native handler coverage gaps closed; two branches declared unreachable 2026-09-13** — WS5a left `BlueprintHandlers.cpp` covered only on each handler's main success path and its cheapest rejections. Five tests close the rest: `UEMCP.BlueprintHandlers.AssignmentVariableKind` (the `variable` kind's get node, `links[value]` row, `source_value` pin row and source-side `VARIABLE_NOT_FOUND`), `AssignmentExecFrom` (the `links[exec]` row plus `MISSING_PARAMS` and `NODE_NOT_FOUND`), `DisconnectPinEdges` (`PIN_AMBIGUOUS`, `target_direction` parsing, the dry-run `would_*` and `pin_info` fields), `CompilePaths` (the `compile: true` leg of all three handlers) and `TimerFailures` (`NO_GRAPH` and `COMPILE_FAILED` with its `RollbackTimerAuthoring` proof). Native suite **22 → 27**. Three arrangements are dispatched through the registry rather than reaching into the editor API — `add_blueprint_function_node` for an exec source that also carries the only pin with a `DefaultObject` in reach, `add_blueprint_event_node` for a node that cannot compile, `add_blueprint_timer` for a linked pin — so the arrangement is itself shipped behaviour. **Two branches are declared unreachable from the wire surface and are deliberately untested**: `TIMER_FUNCTION_NOT_FOUND` requires `UKismetSystemLibrary::K2_SetTimer` to be absent from a loaded Engine module, and the timer handler's `CREATE_FAILED` requires `NewObject` to return null; no JSON parameter reaches either, and the surface a handler test drives is its params. A third BUG-2-family quirk was recorded rather than fixed: the assignment handler reports `compiled` without consulting whether the compile succeeded. | Engine facts the tests rest on, each read from UE 5.6 source: `UK2Node_VariableSet::GetVariableOutputPinName` returns `Output_Get`, so the only cross-direction pin-name collision reachable through these handlers is a member variable named `then` against the node's `PN_Then` output; `UK2Node_Event::ValidateNodeDuringCompilation` logs an **Error** for an unresolvable override (`UK2Node_Variable`'s equivalent logs only a Warning, which would not fail a compile); `FBlueprintEditorUtils::DoesSupportEventGraphs` admits only `BPTYPE_Normal` and `BPTYPE_LevelScript` and `FindEventGraph` never creates one, which is what makes `NO_GRAPH` reachable; `UEdGraphSchema_K2::TrySetDefaultObject` writes `Pin.DefaultObject`, which is what makes `PinToJson`'s `default_object` branch reachable. Verification: `node server/run-native-tests.mjs --uproject <the sample 5.6 target>` reports `Native tests: 27 passed, 0 failed, 0 not run`; `node server/test-anon-namespace-audit.mjs` clean; Node rotation unchanged at 7580/0 across 79 files. Source: plan `docs/superpowers/plans/2026-09-13-native-handler-coverage-gaps.md`; extends D197 and the WS5a plan. |
```

- [ ] **Step 5: Codename and placeholder scan**

The pre-commit hook scans the staged diff against `.git/info/forbidden-tokens`, but scan first rather than relying on it — the hook is the safety net, not the first line of defence. From the repo root:

```bash
git add CLAUDE.md docs/tracking/backlog.md docs/tracking/risks-and-decisions.md
git diff --cached | grep -n -i -E "$(grep -v -e '^#' -e '^$' -e '^regex:' .git/info/forbidden-tokens | paste -sd'|' -)" || echo "no literal token match"
git diff --cached | grep -n -E "$(grep '^regex:' .git/info/forbidden-tokens | sed 's/^regex://' | paste -sd'|' -)" || echo "no regex token match"
```

The comment and blank lines must be filtered out of the literal list, or the bare `#` from the file's own header matches every heading in the diff. Expected: both commands print their "no … match" line. A real hit means a codename, a machine path or the blocked scratch-directory token reached a tracked file — fix it before committing.

- [ ] **Step 6: Final verification**

```bash
node server/run-native-tests.mjs --uproject path/to/YourProject.uproject
node server/test-anon-namespace-audit.mjs
cd server && node run-rotation.mjs | tail -3
```

Expected: `Native tests: 27 passed, 0 failed, 0 not run`; audit clean; rotation `7580` passed, `0` failed across 79 files. `test-slash-command-anchors.mjs` reads `CLAUDE.md`, so a rotation failure here means the edit broke an anchor it depends on — fix the anchor, do not skip the test.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/tracking/backlog.md docs/tracking/risks-and-decisions.md
git commit -F - <<'MSG'
Record the native handler coverage at 27 tests and the third BlueprintHandlers quirk (D198)

CLAUDE.md's native-tests note said 22; the five tests added by this workstream
take it to 27. The rest of that sentence stands: the file list already names
all four test files, and every new test targets the same three handlers it
already named.

D198 records what the five tests close, the engine facts each rests on, and the
two branches declared unreachable from the wire surface rather than left as
silent gaps — TIMER_FUNCTION_NOT_FOUND needs K2_SetTimer absent from a loaded
Engine module, and the timer handler's CREATE_FAILED needs NewObject to return
null.

backlog BUG-2 gains a third bullet: add_blueprint_variable_assignment reports
compiled without consulting whether the compile succeeded, and has no
COMPILE_FAILED branch at all, so a caller passing compile:true is told the
Blueprint compiled whether or not it did. Recorded rather than fixed, because
the fix changes wire behaviour; UEMCP.BlueprintHandlers.CompilePaths pins the
current shape so a fix has to update it deliberately.
MSG
```

---

## Self-review

**1. Spec coverage.** Every row of §Coverage inventory maps to a task or to §Dropped inventory items, and the table names the task inline. Item 1 → Task 1. Item 2 → Task 2. Item 3 → `pin_id`/`link_count` in Tasks 1 (source_value, target_value), 2 (class pin, exec source pin) and 3 (dry-run `pin_info`); `default_object` in Task 2, including the negative case that a pin without one omits the field. Items 4, 5, 6 → Task 3. Item 7 → Task 4, in all four legs. Items 8 and 10 → Task 5, on one arrangement. Item 9 → Task 5. Items 11 and 12 → dropped, each with the specific call site and the specific condition no parameter reaches. No inventory row is unaccounted for. The brief's "no handler code changes unless a test proves a defect" is honoured — no task touches `BlueprintHandlers.cpp` — and §If a test proves a defect states what to do if one does, with Task 5 Step 4 naming the likeliest candidate.

**2. Placeholder scan.** No "TBD", no "implement later", no "add appropriate error handling", no "write tests for the above", no "similar to Task N" — each task restates its full deploy-cycle, falsification, guard and commit commands rather than referring back, and each Interfaces block lists the exact helper signatures it consumes because its implementer may not have read the earlier tasks. Every code step carries real C++; every expected output is a literal string. The one branch point (Task 3's `then`-variable arrangement) is a contingency with both paths written out, the exact `CreatePin` line for the fallback, and the condition that selects between them — not an unresolved choice. No private project name, no absolute machine path, no blocked scratch-directory token: `path/to/YourProject.uproject`, `<YourProject>Editor`, `<UE_ENGINE_ROOT>`, "the sample 5.6 target" throughout, and Task 6 Step 5 scans the staged diff before committing.

**3. Type consistency.** `NumberFieldOr(const TSharedPtr<FJsonObject>&, const FString&, double = -1.0)` is defined in Task 1 and called with two arguments in Tasks 1-5; its result is cast to `int32` at every count comparison and compared as a `double` only in Task 5's `>= 1.0`. `FindEntryByField(const TSharedPtr<FJsonObject>&, const FString&, const FString&, const FString&)` is defined in Task 2 and used there and, through `FindRole`, everywhere else; `FindRole` keeps its three-parameter signature and return type, so the four call sites already in the file and every new one bind unchanged. `CreateFixtureBlueprintOfType(UClass*, EBlueprintType)` is defined in Task 5 and `CreateFixtureBlueprint()` keeps its zero-argument signature, so Tasks 1-4 and the three shipped tests are untouched by that refactor — Task 5 Step 4 re-checks all of them. `FindFixturePin` takes a `TArray<FString>` of candidate names at all eleven new call sites. `FFixtureBlueprint::PackagePath` is what every `blueprint_name` reads and `FFixtureBlueprint::Blueprint` what every graph lookup starts from. Response fields are spelled exactly as the handlers write them — `assignment_kind`, `source_variable`, `links_matched`, `links_broken`, `would_modify`, `would_require_compile`, `pin_info`, `target_pin_info`, `begin_play_node_id`, `timer_node_id`, `self_node_id`, `callback_graph_name`, `function_graph_created`, `compiled_ok`, `num_errors`, `generated_class_status` — and every error code is one of `MISSING_PARAMS`, `VARIABLE_NOT_FOUND`, `NODE_NOT_FOUND`, `PIN_NOT_FOUND`, `PIN_AMBIGUOUS`, `INVALID_DIRECTION`, `NO_GRAPH`, `COMPILE_FAILED`, each read from the handler source. Test totals chain 22 → 23 → 24 → 25 → 26 → 27 → 27 with no gap, and every falsification step states the matching `N-1 passed, 1 failed`.
