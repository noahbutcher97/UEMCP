# WS5a: `BlueprintHandlers.cpp` Helper Extraction and Native Handler Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp` its first automated check by extracting its pure logic into a `Public/` header with unit tests and adding three handler-level native tests that dispatch real commands against an in-memory Blueprint, taking the native suite from 16 tests to 22.

**Architecture:** `BlueprintHandlers.cpp` is 3,703 lines with everything after line 48 inside `namespace UEMCP { namespace { … } }`, so nothing in it is reachable from a test translation unit. Four pure functions move verbatim into `Public/BlueprintHandlerHelpers.h` + `Private/BlueprintHandlerHelpers.cpp` (`namespace UEMCP`, no anonymous namespace — the module builds with `bUseUnity = true`, so a duplicate anonymous-namespace symbol is a link error, and `server/test-anon-namespace-audit.mjs` blocks the commit that reintroduces one). One new pure function, `FormatLiteralForPinCategory`, is extracted out of `TryApplyLiteralAssignmentDefault`, which stays behind as a thin wrapper that owns the response envelope and the `Pin->DefaultValue` write. Because the anonymous namespace is *nested inside* `UEMCP`, every existing unqualified call site resolves against the new declarations with no edit. The handlers themselves are then tested through the front door: `RegisterBlueprintHandlers` runs at module startup from `MCPCommandRegistry.cpp:175`, so `FMCPCommandRegistry::Get().Dispatch(TEXT("<command>"), Params, OutResponse)` reaches them in any editor with the plugin loaded — the same mechanism the existing `UEMCP.MCPCommandRegistry.Dispatch` test relies on. Each handler test creates an Actor-parented Blueprint in an unsaved in-memory package under `/Game/__UEMCPTests/`, which the handlers' `ResolveBlueprint` resolves once the test registers it with `FAssetRegistryModule::AssetCreated`.

**Tech Stack:** UE 5.6 C++ editor module; `IMPLEMENT_SIMPLE_AUTOMATION_TEST` with `EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter` behind `#if WITH_DEV_AUTOMATION_TESTS`; `FKismetEditorUtilities`, `FBlueprintEditorUtils`, `UEdGraphSchema_K2`, `FAssetRegistryModule`; `run-native-tests.bat` (headless `UnrealEditor-Cmd`) for the proof; `sync-plugin.bat` + `Build.bat` + `verify-deploy.mjs` for the deploy cycle.

**Spec:** `docs/superpowers/specs/2026-09-09-health-audit-remediation-design.md` §4 WS5 and §6.

## Deviations from the spec and from the controller's decisions

Recorded here so a reviewer does not read them as drift:

1. **Move scope is narrower than the spec's wording.** The spec says "pin-type to JSON mapping, parameter validation shared by the handlers, the variable-default resolution behind `SetSupportedVariableDefault`". There is no "parameter validation shared by the handlers" that is pure: the shared validators (`ResolveBlueprint`, `ResolveTargetGraph`, `TryLinkPins`) all emit response envelopes and touch editor objects, which is exactly why the handler-level tests in Tasks 2-4 exist. Moved instead: `PinDirectionToString`, `PinTypeToJson`, `PinToJson`, `SetSupportedVariableDefault`, plus the new `FormatLiteralForPinCategory`.
2. **`FormatLiteralForPinCategory` takes `const FEdGraphPinType&`, not `FName PinCategory`.** `BlueprintHandlers.cpp:729` reads `if (Category == UEdGraphSchema_K2::PC_Struct && Pin->PinType.PinSubCategoryObject == TBaseStructure<FVector>::Get())`. A function given only the category cannot evaluate the second conjunct, so an `FName`-only signature would either format an `FRotator` pin as a Vector (a behaviour change) or leave struct handling in the wrapper (mapping split across two files). The whole pin type is passed instead. Task 1's tests already build `FEdGraphPinType` values by hand, so the test surface is unchanged.
3. **Three fields are added to `UUEMCPTestObject`, not one.** `double DoubleValue` for the `FDoubleProperty` branch, `FVector VectorValue` for the supported-struct branch and three of its four error branches, `FRotator RotatorValue` for the "unsupported struct default type" branch. Same reason in all three cases: the function has a branch and the object has no field that reaches it. The unsupported-*property*-type tail needs no new field — the existing `FName NameValue` reaches it, because `SetSupportedVariableDefault` has no `FNameProperty` branch. No existing test asserts a property count on this class (verified: `UEMCPTests.cpp` looks properties up by name).
4. **WS5b is closed by measurement instead of implemented.** See Task 5; the numbers are in the D197 row.

## Global Constraints

- **Placeholder vocabulary only.** This is a public repo and the target projects are private. Write `path/to/YourProject.uproject`, `<YourProject>Editor`, `<UE_ENGINE_ROOT>`, "the primary 5.6 target", "the team target project". Never a project codename, never an absolute machine path, and no unquoted capital-T scratch-directory word — the per-checkout token list blocks that as a standalone token, so write "scratch" instead. Applies to source comments, commit messages, the D-log row and CLAUDE.md.
- **No AI attribution** in commits — no `Co-Authored-By`, no "generated with".
- **One commit per task**, five commits total. Commit from the repo root.
- **Never edit `.uemcp-targets.json`.** It is per-machine and untracked-by-intent. The commands below assume a `smoke` profile exists; if it does not, substitute `--target <alias>` or `--uproject path/to/YourProject.uproject` and say which you used in the task report.
- **Shared C++ helpers live in `Public/` headers, never in per-file anonymous namespaces** (`UEMCP.Build.cs` sets `bUseUnity = true`; D133/D135/D137). `node server/test-anon-namespace-audit.mjs` must stay clean; it scans `Private/*.cpp` non-recursively, so `Private/Tests/*.cpp` is outside its scope but `Private/BlueprintHandlerHelpers.cpp` is inside it.
- **Pure move means byte-identical bodies.** A moved function keeps its name, signature, body and the comment block above it. The only permitted change is removing one tab of indentation (the originals sit two levels deep inside `namespace UEMCP { namespace { … } }`; in the new file they sit one level deep). Do not "fix" anything you move — in particular leave `FString::FromInt(FMath::RoundToInt(Value->AsNumber()))` exactly as written.
- **Functions under 50 lines applies to newly authored code, test helpers included.** Moved bodies are exempt under the pure-move rule (`SetSupportedVariableDefault` is 133 lines). Two accepted exceptions in new code, both flat dispatch tables that would be obscured by splitting: `FormatLiteralForPinCategory` (~60 lines, five category branches each preserving an exact existing message and code) and the handler test bodies, which delegate fixture work to helpers rather than inlining it.
- **The fixture Blueprint's object name must equal its package leaf.** `StaticLoadObjectInternal` (engine `UObjectGlobals.cpp`) resolves a dot-less path by retrying it as `<path>.<short package name>`; that retry is the only reason `LoadObject<UBlueprint>(nullptr, TEXT("/Game/__UEMCPTests/BP_X"))` finds an unsaved in-memory object. Give the package and the Blueprint the same leaf name or resolution silently fails with `BLUEPRINT_NOT_FOUND`.
- **Every test name is unique per run.** `FGuid::NewGuid().ToString(EGuidFormats::Short)` in the package leaf; automation tests run in arbitrary order and may run repeatedly in one editor session.
- **Nothing is ever saved.** The fixture packages have no file on disk, `SidecarSaveHook.cpp:34` ignores transient-package Blueprints, and nothing saves an unsaved package in a headless `-unattended` run. Handler calls pass `compile: false` unless the asserted state needs compilation.
- **Proof is the count, not the exit code.** `reportExitCode` in `server/native-test-report.mjs` returns 0 whenever `failed === 0 && notRun === 0`, so a test that fails to register (name typo, file not picked up) leaves the total unchanged and still exits 0 — the silent-zero class in native clothing. Every task's proof line is the runner's `Native tests: <N> passed, 0 failed, 0 not run` with N stated: **19 / 20 / 21 / 22 / 22**.
- **The Node rotation must not move.** Baseline 7,580 assertions across 79 files; no task in this workstream changes it.
- **Deploy cycle, run from the repo root, after every code change** (about 25 s for `Build.bat` on this module, about 30 s for the test run):

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
node server/verify-deploy.mjs --quiet --no-color --profile smoke
```

  **Close the editor before `Build.bat`** — a running editor locks the module DLL and the build is a silent no-op (D135); `verify-deploy` reports that as `[EDITOR-LOCKED]`. `verify-deploy.mjs` must print `SYNC` for the target afterwards. The pre-push compile gate refuses to publish plugin source while the built target reads NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY.
- **Team-project constraint (spec §4 WS5).** This workstream adds four plugin files. After merge, the team target project's UEMCP pin and version record must be bumped so its installed plugin source includes them; state this in the final commit body in placeholder vocabulary.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h` | Create (Task 1) | Declarations + doc comments for the five pure helpers. The only shape `Private/Tests/*.cpp` can include. |
| `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp` | Create (Task 1) | The four moved bodies verbatim plus `FormatLiteralForPinCategory`, all in `namespace UEMCP`. |
| `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp` | Modify (Task 1) | Loses lines 245-284 and 489-621; gains one include; `TryApplyLiteralAssignmentDefault` (680-751) becomes a wrapper. No call site changes. |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTestObject.h` | Modify (Task 1) | Three new `UPROPERTY` fields: `double DoubleValue`, `FVector VectorValue`, `FRotator RotatorValue`. |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp` | Create (Task 1) | 3 tests, `UEMCP.BlueprintHelpers.*`, helpers in `namespace UEMCP::Blueprint::HelperTests`. |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` | Create (Task 2), Modify (Tasks 3, 4) | Shared fixture + 3 tests, `UEMCP.BlueprintHandlers.*`, helpers in `namespace UEMCP::Blueprint::Tests`. |
| `CLAUDE.md` | Modify (Task 5) | Native-tests count, file list, and the coverage clause. |
| `docs/tracking/risks-and-decisions.md` | Modify (Task 5) | D197 row. |

The two test files use **different helper namespaces on purpose**: under Unity they may land in the same translation unit, and two `namespace UEMCP::Blueprint::Tests` blocks defining same-named helpers would be a redefinition error.

---

### Task 1: Extract the pure helpers and unit-test them

**Files:**
- Create: `plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h`
- Create: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp`
- Create: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp:245-284`, `:489-621`, `:680-751`, include block at `:2-46`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTestObject.h:18-31`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all in `namespace UEMCP`, declared in `Public/BlueprintHandlerHelpers.h`:
  - `FString PinDirectionToString(EEdGraphPinDirection Direction)`
  - `TSharedPtr<FJsonObject> PinTypeToJson(const FEdGraphPinType& PinType)`
  - `TSharedPtr<FJsonObject> PinToJson(const UEdGraphPin* Pin)`
  - `bool SetSupportedVariableDefault(UObject* CDO, FProperty* Property, const TSharedPtr<FJsonValue>& Value, FString& OutErrorMessage)`
  - `bool FormatLiteralForPinCategory(const FEdGraphPinType& PinType, const TSharedPtr<FJsonValue>& Value, FString& OutDefaultValue, FString& OutError, FString& OutErrorCode)`
  - `UUEMCPTestObject` gains `double DoubleValue`, `FVector VectorValue`, `FRotator RotatorValue`.

- [ ] **Step 1: Pre-start check — is `BlueprintHandlers.cpp` in flight?**

The spec requires this before touching the file: if the UE 5.8 compatibility stream still has work here, stop rather than build on it.

```bash
git status --short plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp
git log --oneline -5 -- plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp
git log --oneline origin/main..HEAD
```

Expected: the first command prints nothing (no uncommitted change). **Stop and report instead of continuing** if it prints anything, or if the third command shows unpushed commits touching this file — the audit HEAD is supposed to be public before this workstream is dispatched (spec §3).

- [ ] **Step 2: Add the three test-object fields**

In `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTestObject.h`, after the existing `FName NameValue;` property and before the closing `};`:

```cpp
	UPROPERTY()
	double DoubleValue = 0.0;

	UPROPERTY()
	FVector VectorValue = FVector::ZeroVector;

	UPROPERTY()
	FRotator RotatorValue = FRotator::ZeroRotator;
```

Also update the class doc comment's first line so it stops claiming the fields are only scalars and only for one suite:

```cpp
/**
 * Tiny UObject with scalar and struct UPROPERTY fields exercised by the
 * PropertyHandlerRegistry and Blueprint-helper automation tests.
 * Not used in production — only compiled into the test translation unit.
 */
```

- [ ] **Step 3: Write the failing test file**

Create `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
//
// WS5a unit tests for the pure helpers in Public/BlueprintHandlerHelpers.h.
// No Blueprint, no graph, no editor world: pin types are built by hand and
// property defaults are written onto a UUEMCPTestObject instance. The handler-
// level tests that need a real Blueprint live in UEMCPBlueprintHandlerTests.cpp.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "GameFramework/Actor.h"
#include "Misc/AutomationTest.h"

#include "BlueprintHandlerHelpers.h"
#include "UEMCPTestObject.h"

// Distinct from UEMCP::Blueprint::Tests in UEMCPBlueprintHandlerTests.cpp:
// Unity may bundle both files into one translation unit, and same-named
// helpers in one namespace would be a redefinition.
namespace UEMCP::Blueprint::HelperTests
{
	FEdGraphPinType MakePinType(FName Category, FName SubCategory = NAME_None, UObject* SubCategoryObject = nullptr)
	{
		FEdGraphPinType PinType;
		PinType.PinCategory = Category;
		PinType.PinSubCategory = SubCategory;
		PinType.PinSubCategoryObject = SubCategoryObject;
		return PinType;
	}

	TSharedPtr<FJsonValue> JsonNumber(double In) { return MakeShared<FJsonValueNumber>(In); }
	TSharedPtr<FJsonValue> JsonString(const FString& In) { return MakeShared<FJsonValueString>(In); }
	TSharedPtr<FJsonValue> JsonBool(bool In) { return MakeShared<FJsonValueBoolean>(In); }

	TSharedPtr<FJsonValue> JsonNumberArray(const TArray<double>& In)
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		for (const double Entry : In)
		{
			Values.Add(MakeShared<FJsonValueNumber>(Entry));
		}
		return MakeShared<FJsonValueArray>(Values);
	}

	/** [1, "two", 3] — reaches the "must contain only numbers" branch. */
	TSharedPtr<FJsonValue> JsonMixedArray()
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		Values.Add(MakeShared<FJsonValueNumber>(1.0));
		Values.Add(MakeShared<FJsonValueString>(TEXT("two")));
		Values.Add(MakeShared<FJsonValueNumber>(3.0));
		return MakeShared<FJsonValueArray>(Values);
	}

	FProperty* TestProperty(const TCHAR* Name)
	{
		return FindFProperty<FProperty>(UUEMCPTestObject::StaticClass(), Name);
	}
}

// =====================================================================================
// PinTypeToJson + PinDirectionToString — the pin-shape contract every BP-write
// response depends on.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHelpersPinTypeToJsonTest,
	"UEMCP.BlueprintHelpers.PinTypeToJson",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHelpersPinTypeToJsonTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::HelperTests;

	// Int pin: category and subcategory round-trip, container text is present,
	// subcategory_object is omitted rather than emitted empty.
	const TSharedPtr<FJsonObject> IntJson = UEMCP::PinTypeToJson(MakePinType(UEdGraphSchema_K2::PC_Int));
	TestTrue(TEXT("int json allocated"), IntJson.IsValid());
	TestEqual(TEXT("int category"), IntJson->GetStringField(TEXT("category")), UEdGraphSchema_K2::PC_Int.ToString());
	TestEqual(TEXT("int subcategory is None"), IntJson->GetStringField(TEXT("subcategory")), FString(TEXT("None")));
	TestFalse(TEXT("int container text empty"), IntJson->GetStringField(TEXT("container")).IsEmpty());
	TestFalse(TEXT("int omits subcategory_object"), IntJson->HasField(TEXT("subcategory_object")));

	// Object pin: subcategory_object is the referenced class's name, not its path.
	const TSharedPtr<FJsonObject> ObjectJson = UEMCP::PinTypeToJson(
		MakePinType(UEdGraphSchema_K2::PC_Object, NAME_None, AActor::StaticClass()));
	TestEqual(TEXT("object category"), ObjectJson->GetStringField(TEXT("category")), UEdGraphSchema_K2::PC_Object.ToString());
	TestEqual(TEXT("object subcategory_object"), ObjectJson->GetStringField(TEXT("subcategory_object")), FString(TEXT("Actor")));
	TestFalse(TEXT("object container text empty"), ObjectJson->GetStringField(TEXT("container")).IsEmpty());

	// Float pin carries a subcategory, so the field is not always None.
	const TSharedPtr<FJsonObject> FloatJson = UEMCP::PinTypeToJson(
		MakePinType(UEdGraphSchema_K2::PC_Real, UEdGraphSchema_K2::PC_Float));
	TestEqual(TEXT("float category"), FloatJson->GetStringField(TEXT("category")), UEdGraphSchema_K2::PC_Real.ToString());
	TestEqual(TEXT("float subcategory"), FloatJson->GetStringField(TEXT("subcategory")), UEdGraphSchema_K2::PC_Float.ToString());

	// Direction mapping is the other half of the contract.
	TestEqual(TEXT("input direction"), UEMCP::PinDirectionToString(EGPD_Input), FString(TEXT("input")));
	TestEqual(TEXT("output direction"), UEMCP::PinDirectionToString(EGPD_Output), FString(TEXT("output")));

	return true;
}

// =====================================================================================
// SetSupportedVariableDefault — every supported property kind and every rejection.
// Note the JSON coercion rules this exercises: FJsonValueNumber::TryGetBool and
// ::TryGetString both succeed, so a number is NOT a type error for a bool or
// string property. Only arrays and objects fail TryGetBool / TryGetString, and
// only non-numeric strings fail TryGetNumber.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHelpersVariableDefaultsTest,
	"UEMCP.BlueprintHelpers.VariableDefaults",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHelpersVariableDefaultsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::HelperTests;

	UUEMCPTestObject* Obj = NewObject<UUEMCPTestObject>();
	if (!Obj)
	{
		AddError(TEXT("failed to allocate UUEMCPTestObject"));
		return false;
	}
	FString Error;

	// --- supported kinds write through to the object ---
	TestTrue(TEXT("bool accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("BoolValue")), JsonBool(true), Error));
	TestTrue(TEXT("bool written"), Obj->BoolValue);

	TestTrue(TEXT("int accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonNumber(7.0), Error));
	TestEqual(TEXT("int written"), Obj->IntValue, 7);

	TestTrue(TEXT("float accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("FloatValue")), JsonNumber(1.5), Error));
	TestEqual(TEXT("float written"), Obj->FloatValue, 1.5f);

	TestTrue(TEXT("double accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("DoubleValue")), JsonNumber(2.25), Error));
	TestEqual(TEXT("double written"), Obj->DoubleValue, 2.25);

	TestTrue(TEXT("string accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("StringValue")), JsonString(TEXT("hello")), Error));
	TestEqual(TEXT("string written"), Obj->StringValue, FString(TEXT("hello")));

	TestTrue(TEXT("vector accepted"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonNumberArray({1.0, 2.0, 3.0}), Error));
	TestTrue(TEXT("vector written"), Obj->VectorValue.Equals(FVector(1.0, 2.0, 3.0)));

	// --- argument guards, asserted on the exact messages ---
	TestFalse(TEXT("null CDO rejected"),
		UEMCP::SetSupportedVariableDefault(nullptr, TestProperty(TEXT("IntValue")), JsonNumber(1.0), Error));
	TestEqual(TEXT("null CDO message"), Error, FString(TEXT("Invalid default object")));

	TestFalse(TEXT("null property rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, nullptr, JsonNumber(1.0), Error));
	TestEqual(TEXT("null property message"), Error, FString(TEXT("Variable property is null")));

	TestFalse(TEXT("missing value rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), nullptr, Error));
	TestEqual(TEXT("missing value message"), Error, FString(TEXT("Missing default value")));

	// --- per-kind type mismatches ---
	TestFalse(TEXT("bool rejects array"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("BoolValue")), JsonNumberArray({1.0}), Error));
	TestTrue(TEXT("bool mismatch message"), Error.Contains(TEXT("BoolValue")) && Error.Contains(TEXT("boolean")));

	TestFalse(TEXT("int rejects non-numeric string"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonString(TEXT("not a number")), Error));
	TestTrue(TEXT("int mismatch message"), Error.Contains(TEXT("IntValue")) && Error.Contains(TEXT("numeric")));

	TestFalse(TEXT("float rejects non-numeric string"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("FloatValue")), JsonString(TEXT("not a number")), Error));
	TestTrue(TEXT("float mismatch message"), Error.Contains(TEXT("FloatValue")) && Error.Contains(TEXT("numeric")));

	TestFalse(TEXT("double rejects non-numeric string"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("DoubleValue")), JsonString(TEXT("not a number")), Error));
	TestTrue(TEXT("double mismatch message"), Error.Contains(TEXT("DoubleValue")) && Error.Contains(TEXT("numeric")));

	TestFalse(TEXT("string rejects array"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("StringValue")), JsonNumberArray({1.0}), Error));
	TestTrue(TEXT("string mismatch message"), Error.Contains(TEXT("StringValue")) && Error.Contains(TEXT("string")));

	// --- int32 range and integrality ---
	TestFalse(TEXT("int rejects fractional"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonNumber(1.5), Error));
	TestTrue(TEXT("fractional message"), Error.Contains(TEXT("integral int32")));

	TestFalse(TEXT("int rejects out-of-range"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("IntValue")), JsonNumber(3000000000.0), Error));
	TestTrue(TEXT("out-of-range message"), Error.Contains(TEXT("integral int32")));
	TestEqual(TEXT("rejections left the property alone"), Obj->IntValue, 7);

	// --- struct branches ---
	TestFalse(TEXT("vector rejects non-array"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonNumber(1.0), Error));
	TestTrue(TEXT("non-array message"), Error.Contains(TEXT("[x,y,z]")));

	TestFalse(TEXT("vector rejects wrong arity"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonNumberArray({1.0, 2.0}), Error));
	TestTrue(TEXT("arity message"), Error.Contains(TEXT("requires 3 values")) && Error.Contains(TEXT("got 2")));

	TestFalse(TEXT("vector rejects non-numeric element"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("VectorValue")), JsonMixedArray(), Error));
	TestTrue(TEXT("element message"), Error.Contains(TEXT("only numbers")));

	TestFalse(TEXT("non-Vector struct rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("RotatorValue")), JsonNumberArray({1.0, 2.0, 3.0}), Error));
	TestTrue(TEXT("unsupported struct message"),
		Error.Contains(TEXT("unsupported struct default type")) && Error.Contains(TEXT("Rotator")));

	// --- the tail: a property class with no branch at all (FNameProperty) ---
	TestFalse(TEXT("name property rejected"),
		UEMCP::SetSupportedVariableDefault(Obj, TestProperty(TEXT("NameValue")), JsonString(TEXT("Tag")), Error));
	TestTrue(TEXT("unsupported property message"),
		Error.Contains(TEXT("unsupported default property type")) && Error.Contains(TEXT("NameProperty")));

	return true;
}

// =====================================================================================
// FormatLiteralForPinCategory — the mapping behind add_blueprint_variable_assignment's
// literal kind. Unlike the property path above, these are strict EJson::Type checks,
// so a number is a type error for a boolean pin.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHelpersLiteralDefaultsTest,
	"UEMCP.BlueprintHelpers.LiteralDefaults",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHelpersLiteralDefaultsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::HelperTests;

	FString Default, Error, Code;

	// --- int: rounded, rendered by FString::FromInt ---
	TestTrue(TEXT("int literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Int), JsonNumber(4.6), Default, Error, Code));
	TestEqual(TEXT("int literal rounds"), Default, FString(TEXT("5")));

	TestFalse(TEXT("int literal rejects string"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Int), JsonString(TEXT("5")), Default, Error, Code));
	TestEqual(TEXT("int mismatch code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));
	TestEqual(TEXT("int mismatch message"), Error, FString(TEXT("Integer variable assignment requires a numeric literal")));

	// --- float and real share one branch; the formatter is SanitizeFloat ---
	TestTrue(TEXT("real literal accepted"),
		UEMCP::FormatLiteralForPinCategory(
			MakePinType(UEdGraphSchema_K2::PC_Real, UEdGraphSchema_K2::PC_Float), JsonNumber(2.5), Default, Error, Code));
	TestEqual(TEXT("real literal formatting"), Default, FString::SanitizeFloat(2.5));

	TestTrue(TEXT("float literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Float), JsonNumber(2.5), Default, Error, Code));
	TestEqual(TEXT("float literal formatting"), Default, FString::SanitizeFloat(2.5));

	TestFalse(TEXT("float literal rejects bool"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Float), JsonBool(true), Default, Error, Code));
	TestEqual(TEXT("float mismatch message"), Error, FString(TEXT("Float variable assignment requires a numeric literal")));

	// --- boolean ---
	TestTrue(TEXT("bool literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Boolean), JsonBool(true), Default, Error, Code));
	TestEqual(TEXT("bool literal true"), Default, FString(TEXT("true")));
	TestTrue(TEXT("bool literal false accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Boolean), JsonBool(false), Default, Error, Code));
	TestEqual(TEXT("bool literal false"), Default, FString(TEXT("false")));

	TestFalse(TEXT("bool literal rejects number"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Boolean), JsonNumber(1.0), Default, Error, Code));
	TestEqual(TEXT("bool mismatch message"), Error, FString(TEXT("Boolean variable assignment requires a boolean literal")));

	// --- string ---
	TestTrue(TEXT("string literal accepted"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_String), JsonString(TEXT("abc")), Default, Error, Code));
	TestEqual(TEXT("string literal verbatim"), Default, FString(TEXT("abc")));

	TestFalse(TEXT("string literal rejects number"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_String), JsonNumber(1.0), Default, Error, Code));
	TestEqual(TEXT("string mismatch message"), Error, FString(TEXT("String variable assignment requires a string literal")));

	// --- Vector struct: only when the sub-category object is FVector ---
	const FEdGraphPinType VectorPin = MakePinType(
		UEdGraphSchema_K2::PC_Struct, NAME_None, TBaseStructure<FVector>::Get());
	TestTrue(TEXT("vector literal accepted"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, JsonNumberArray({1.0, 2.0, 3.0}), Default, Error, Code));
	TestEqual(TEXT("vector literal formatting"), Default, FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"), 1.0, 2.0, 3.0));
	TestTrue(TEXT("vector literal shape"), Default.StartsWith(TEXT("(X=1.")) && Default.EndsWith(TEXT(")")));

	TestFalse(TEXT("vector literal rejects non-array"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, JsonNumber(1.0), Default, Error, Code));
	TestEqual(TEXT("vector mismatch code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));
	TestEqual(TEXT("vector mismatch message"), Error, FString(TEXT("Vector variable assignment requires [x, y, z] numeric literal")));

	TestFalse(TEXT("vector literal rejects wrong arity"),
		UEMCP::FormatLiteralForPinCategory(VectorPin, JsonNumberArray({1.0, 2.0}), Default, Error, Code));
	TestEqual(TEXT("vector arity code"), Code, FString(TEXT("LITERAL_TYPE_MISMATCH")));

	// A struct pin that is not FVector falls through to the unsupported tail —
	// this is why the function takes the whole pin type, not just the category.
	TestFalse(TEXT("rotator struct pin unsupported"),
		UEMCP::FormatLiteralForPinCategory(
			MakePinType(UEdGraphSchema_K2::PC_Struct, NAME_None, TBaseStructure<FRotator>::Get()),
			JsonNumberArray({1.0, 2.0, 3.0}), Default, Error, Code));
	TestEqual(TEXT("rotator struct code"), Code, FString(TEXT("UNSUPPORTED_LITERAL_TYPE")));

	// --- unsupported category, and the missing-value guard ---
	TestFalse(TEXT("object pin unsupported"),
		UEMCP::FormatLiteralForPinCategory(
			MakePinType(UEdGraphSchema_K2::PC_Object, NAME_None, AActor::StaticClass()),
			JsonString(TEXT("x")), Default, Error, Code));
	TestEqual(TEXT("unsupported code"), Code, FString(TEXT("UNSUPPORTED_LITERAL_TYPE")));
	TestEqual(TEXT("unsupported message"), Error, FString(TEXT("Unsupported literal assignment pin type")));

	TestFalse(TEXT("invalid value rejected"),
		UEMCP::FormatLiteralForPinCategory(MakePinType(UEdGraphSchema_K2::PC_Int), nullptr, Default, Error, Code));
	TestEqual(TEXT("invalid value code"), Code, FString(TEXT("MISSING_PARAMS")));
	TestEqual(TEXT("invalid value message"), Error,
		FString(TEXT("Literal assignment requires a target value pin and value")));

	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
```

- [ ] **Step 4: Build to confirm the test file fails to compile**

Close the editor, then from the repo root:

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
```

Expected: FAIL — `Cannot open include file: 'BlueprintHandlerHelpers.h'`. That is the red state; the header does not exist yet.

- [ ] **Step 5: Check the five names have no other definition in the module**

The anon-namespace audit proves no two `Private/*.cpp` files share an *anonymous* symbol; it says nothing about another file defining `UEMCP::PinToJson` at named-namespace scope, which becomes a duplicate external symbol the moment the header declares it. Check before promoting the names:

```bash
grep -rn "PinDirectionToString\|PinTypeToJson\|PinToJson\|SetSupportedVariableDefault\|FormatLiteralForPinCategory" \
  plugin/UEMCP/Source/UEMCP/ --include=*.cpp --include=*.h | grep -v "BlueprintHandlers.cpp"
```

Expected, as measured when this plan was written: two hits only, both for `AnimGraphPinDirectionToString` in `AnimationHandlers.cpp:269` and `:637` — a different name (and a different return type, `const TCHAR*`), so there is no collision. Any other hit is a name to reconcile or rename before the move.

- [ ] **Step 6: Write the header**

Create `plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"

class FProperty;
class UObject;

/**
 * WS5a: the pure parts of BlueprintHandlers.cpp, lifted out of its anonymous
 * namespace so automation tests can reach them.
 *
 * Why a Public/ header and not a second anonymous namespace: this module builds
 * with bUseUnity = true, so a duplicate anonymous-namespace symbol is a link
 * error (D133 / D135 / D137), server/test-anon-namespace-audit.mjs blocks the
 * commit that reintroduces one, and a Public/ header is the only shape that
 * Private/Tests/*.cpp can include.
 *
 * Everything here is free of editor state: JSON and pin types in, JSON or an
 * FString out. The handlers keep the parts that need a live UEdGraphPin, a
 * UBlueprint, or a response envelope — including the TryApplyLiteralAssignment-
 * Default wrapper around FormatLiteralForPinCategory.
 *
 * Covered by Private/Tests/UEMCPBlueprintHelperTests.cpp (UEMCP.BlueprintHelpers.*).
 */
namespace UEMCP
{
	/** "input" for EGPD_Input, "output" for anything else. */
	FString PinDirectionToString(EEdGraphPinDirection Direction);

	/**
	 * {category, subcategory, container} for a pin type, plus subcategory_object
	 * when the type references one. container is UEdGraphSchema_K2::TypeToText,
	 * so it is display text and not a stable identifier.
	 */
	TSharedPtr<FJsonObject> PinTypeToJson(const FEdGraphPinType& PinType);

	/**
	 * The full pin row used in every BP-write response: pin_id, name, direction,
	 * category, subcategory, subcategory_object (when present), default,
	 * default_object (when present), link_count. Returns an empty object for a
	 * null pin rather than failing.
	 */
	TSharedPtr<FJsonObject> PinToJson(const UEdGraphPin* Pin);

	/**
	 * Writes one JSON value into a class-default-object property, for the
	 * variable kinds set_blueprint_variable_default supports: bool, int32,
	 * float, double, FString, and an FVector struct as [x,y,z]. Returns false
	 * with OutErrorMessage set for a null argument, a JSON type the property
	 * cannot take, a non-integral or out-of-range int32, a struct that is not
	 * FVector, or a property class with no branch here.
	 */
	bool SetSupportedVariableDefault(UObject* CDO, FProperty* Property,
		const TSharedPtr<FJsonValue>& Value, FString& OutErrorMessage);

	/**
	 * Renders a JSON literal as the string a pin's DefaultValue expects, for the
	 * categories literal assignment supports: int, float/real, boolean, string,
	 * and an FVector struct. Returns false with OutError and OutErrorCode set —
	 * MISSING_PARAMS for an invalid value, LITERAL_TYPE_MISMATCH when the JSON
	 * type does not match the category, UNSUPPORTED_LITERAL_TYPE for any other
	 * category. Takes the whole pin type because the struct branch reads
	 * PinSubCategoryObject; a category alone cannot tell FVector from FRotator.
	 */
	bool FormatLiteralForPinCategory(const FEdGraphPinType& PinType,
		const TSharedPtr<FJsonValue>& Value, FString& OutDefaultValue,
		FString& OutError, FString& OutErrorCode);
}
```

- [ ] **Step 7: Create the implementation file and move the four bodies**

Create `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp` with this head, then move bodies into it:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
#include "BlueprintHandlerHelpers.h"

#include "EdGraphSchema_K2.h"
#include "UObject/UnrealType.h"
```

Then, in `namespace UEMCP { … }`, in this order:

1. `PinDirectionToString` — cut from `BlueprintHandlers.cpp:245-249`.
2. `PinTypeToJson` — cut from `:250-262`.
3. `PinToJson` — cut from `:263-284`.
4. `SetSupportedVariableDefault` — cut from `:489-621`.

Each body is pasted **unchanged** except for removing one leading tab per line (the originals are two levels deep). Do not reorder branches, reword messages, or adjust the `FString::FromInt(FMath::RoundToInt(...))` narrowing in the int32 branch.

Then append the new function — the category mapping lifted out of `TryApplyLiteralAssignmentDefault` (`:680-751`) with the envelope work left behind:

```cpp
	bool FormatLiteralForPinCategory(const FEdGraphPinType& PinType,
		const TSharedPtr<FJsonValue>& Value, FString& OutDefaultValue,
		FString& OutError, FString& OutErrorCode)
	{
		if (!Value.IsValid())
		{
			OutError = TEXT("Literal assignment requires a target value pin and value");
			OutErrorCode = TEXT("MISSING_PARAMS");
			return false;
		}

		const FName Category = PinType.PinCategory;
		if (Category == UEdGraphSchema_K2::PC_Int)
		{
			if (Value->Type != EJson::Number)
			{
				OutError = TEXT("Integer variable assignment requires a numeric literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::FromInt(FMath::RoundToInt(Value->AsNumber()));
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_Float || Category == UEdGraphSchema_K2::PC_Real)
		{
			if (Value->Type != EJson::Number)
			{
				OutError = TEXT("Float variable assignment requires a numeric literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::SanitizeFloat(Value->AsNumber());
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_Boolean)
		{
			if (Value->Type != EJson::Boolean)
			{
				OutError = TEXT("Boolean variable assignment requires a boolean literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = Value->AsBool() ? TEXT("true") : TEXT("false");
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_String)
		{
			if (Value->Type != EJson::String)
			{
				OutError = TEXT("String variable assignment requires a string literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = Value->AsString();
			return true;
		}
		if (Category == UEdGraphSchema_K2::PC_Struct
			&& PinType.PinSubCategoryObject == TBaseStructure<FVector>::Get())
		{
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (Value->Type != EJson::Array || !Value->TryGetArray(Arr) || !Arr || Arr->Num() != 3)
			{
				OutError = TEXT("Vector variable assignment requires [x, y, z] numeric literal");
				OutErrorCode = TEXT("LITERAL_TYPE_MISMATCH");
				return false;
			}
			OutDefaultValue = FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"),
				(*Arr)[0]->AsNumber(),
				(*Arr)[1]->AsNumber(),
				(*Arr)[2]->AsNumber());
			return true;
		}

		OutError = TEXT("Unsupported literal assignment pin type");
		OutErrorCode = TEXT("UNSUPPORTED_LITERAL_TYPE");
		return false;
	}
```

- [ ] **Step 8: Point `BlueprintHandlers.cpp` at the new header and reduce the wrapper**

Add the include in the first include group, keeping it alphabetical — immediately after `#include "BlueprintHandlers.h"` and its blank line, before `#include "BlueprintLookupHelper.h"`:

```cpp
#include "BlueprintHandlerHelpers.h"
```

Then replace the body of `TryApplyLiteralAssignmentDefault` (the function that started at `:680`) with the wrapper. Keep the function where it is, inside the anonymous namespace:

```cpp
		/**
		 * Envelope-owning wrapper around UEMCP::FormatLiteralForPinCategory: the
		 * mapping is in BlueprintHandlerHelpers.cpp (unit-tested); this keeps the
		 * parts that need the pin — the error detail block and the DefaultValue
		 * write. The !Pin guard stays here because the pure function needs a pin
		 * type; the !Value guard lives in the pure function and emits the same
		 * message and code, so the combined behavior is unchanged.
		 */
		bool TryApplyLiteralAssignmentDefault(UEdGraphPin* Pin, const TSharedPtr<FJsonValue>& Value,
			TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Pin)
			{
				BuildErrorResponse(OutResponse, TEXT("Literal assignment requires a target value pin and value"), TEXT("MISSING_PARAMS"));
				return false;
			}

			FString DefaultValue, Error, ErrorCode;
			if (!FormatLiteralForPinCategory(Pin->PinType, Value, DefaultValue, Error, ErrorCode))
			{
				if (ErrorCode == TEXT("UNSUPPORTED_LITERAL_TYPE"))
				{
					TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
					Detail->SetObjectField(TEXT("target_pin"), PinToJson(Pin));
					Detail->SetObjectField(TEXT("target_pin_type"), PinTypeToJson(Pin->PinType));
					BuildErrorResponse(OutResponse, Error, ErrorCode, Detail);
					return false;
				}
				BuildErrorResponse(OutResponse, Error, ErrorCode);
				return false;
			}

			Pin->DefaultValue = DefaultValue;
			return true;
		}
```

No other call site changes: the anonymous namespace is nested inside `namespace UEMCP`, so the unqualified `PinToJson` / `PinTypeToJson` / `PinDirectionToString` / `SetSupportedVariableDefault` calls at `:269, :306, :319, :339, :343, :379-:390, :415-:426, :640-:646, :746-:747, :1667, :1954, :3202-:3226, :3310-:3322, :3411-:3466` all resolve to the new declarations.

- [ ] **Step 9: Build and run the native tests**

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: build succeeds; the runner prints `PASS UEMCP.BlueprintHelpers.PinTypeToJson`, `PASS UEMCP.BlueprintHelpers.VariableDefaults`, `PASS UEMCP.BlueprintHelpers.LiteralDefaults` and the summary line **`Native tests: 19 passed, 0 failed, 0 not run`**. A total of 16 means the new file did not register — check the pretty names and that the file sits under `Private/Tests/`.

- [ ] **Step 10: Guards — anon-namespace audit, deploy state, Node rotation**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color --profile smoke
cd server && node run-rotation.mjs | tail -3
```

Expected: audit reports 0 collisions; verify-deploy says `SYNC`; rotation `7580` passed, `0` failed across 79 files (unchanged — this task touches no Node code).

- [ ] **Step 11: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h \
        plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlerHelpers.cpp \
        plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp \
        plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTestObject.h \
        plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHelperTests.cpp
git commit -F - <<'MSG'
Extract BlueprintHandlers pure helpers into Public/BlueprintHandlerHelpers.h with unit tests

Pin JSON shaping, variable-default resolution and literal formatting were all
locked inside the file's anonymous namespace, so none of it could be tested.
They move verbatim into a Public/ header, which is also the only shape that
satisfies the W-K rule: this module builds with bUseUnity = true, so a second
anonymous-namespace copy would be a link error.

FormatLiteralForPinCategory is new: the category-to-default-string mapping
extracted out of TryApplyLiteralAssignmentDefault, which stays behind as a
wrapper owning the error envelope and the pin write. It takes the whole
FEdGraphPinType because the struct branch has to tell FVector from FRotator.

UUEMCPTestObject gains double, FVector and FRotator fields so the tests can
reach the branches that had no matching property.

Native tests 16 -> 19.
MSG
```

---

### Task 2: Handler fixture and the `add_blueprint_variable_assignment` test

**Files:**
- Create: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp`

**Interfaces:**
- Consumes: nothing from Task 1 (this file includes no helper header; it drives the registry).
- Produces, in `namespace UEMCP::Blueprint::Tests`, used by Tasks 3 and 4:
  - `struct FFixtureBlueprint { UBlueprint* Blueprint; UPackage* Package; FString PackagePath; }`
  - `FFixtureBlueprint CreateFixtureBlueprint()`
  - `void AddFixtureVariable(UBlueprint* Blueprint, const FString& VarName, FName Category, FName SubCategory = NAME_None)`
  - `void DestroyFixtureBlueprint(FFixtureBlueprint& Fixture)`
  - `TSharedPtr<FJsonObject> Dispatch(const FString& Command, const TSharedPtr<FJsonObject>& Params)`
  - `bool IsSuccess(const TSharedPtr<FJsonObject>& Response, FString& OutCode)`
  - `TSharedPtr<FJsonObject> ResultOf(const TSharedPtr<FJsonObject>& Response)`
  - `FString ErrorCodeOf(const TSharedPtr<FJsonObject>& Response)`
  - `FString StringFieldOr(const TSharedPtr<FJsonObject>& Obj, const FString& Field)`
  - `UEdGraph* FixtureEventGraph(UBlueprint* Blueprint)`
  - `template <typename TNode> TNode* FindFirstNodeOfClass(UEdGraph* Graph)`
  - `UEdGraphNode* FindNodeByGuid(UEdGraph* Graph, const FString& NodeId)`
  - `UEdGraphPin* FindFixturePin(UEdGraphNode* Node, const TArray<FString>& PinNames, EEdGraphPinDirection Direction)`
  - `TSharedPtr<FJsonObject> FindRole(const TSharedPtr<FJsonObject>& Result, const FString& ArrayField, const FString& Role)`

- [ ] **Step 1: Write the fixture and the failing test**

Create `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
//
// WS5a handler-level tests for BlueprintHandlers.cpp. Each test dispatches a
// real command through FMCPCommandRegistry — RegisterBlueprintHandlers runs at
// module startup from MCPCommandRegistry.cpp, so the registry reaches the
// handlers in any editor with the plugin loaded — and then asserts both the
// response envelope and the graph the handler actually built.
//
// The Blueprint under test lives in an unsaved in-memory package under
// /Game/__UEMCPTests/. Two facts make that work: the handlers' ResolveBlueprint
// accepts a /Game/... path whose package the AssetRegistry knows even when no
// file exists (hence FAssetRegistryModule::AssetCreated), and LoadObject
// resolves a dot-less path by retrying it as "<path>.<short name>" (engine
// StaticLoadObjectInternal), which is why the Blueprint's object name MUST equal
// its package leaf. Nothing is ever saved: the package has no file, the sidecar
// save hook ignores unsaved Blueprints, and a headless -unattended run saves
// nothing.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

#include "MCPCommandRegistry.h"

namespace UEMCP::Blueprint::Tests
{
	/** Package root for fixture Blueprints. Never saved; unique leaf per call. */
	static const TCHAR* FixtureRoot = TEXT("/Game/__UEMCPTests");

	struct FFixtureBlueprint
	{
		UBlueprint* Blueprint = nullptr;
		UPackage* Package = nullptr;
		/** What blueprint_name receives. Package form; the resolver strips any .Object suffix. */
		FString PackagePath;
	};

	/**
	 * Actor-parented Blueprint in a fresh in-memory package. The object name
	 * equals the package leaf — see the file header for why that is load-bearing.
	 */
	FFixtureBlueprint CreateFixtureBlueprint()
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
			AActor::StaticClass(),
			Fixture.Package,
			FName(*Leaf),
			BPTYPE_Normal,
			UBlueprint::StaticClass(),
			UBlueprintGeneratedClass::StaticClass());
		if (Fixture.Blueprint)
		{
			FAssetRegistryModule::AssetCreated(Fixture.Blueprint);
		}
		return Fixture;
	}

	/** Member variable of the given pin category; mirrors add_blueprint_variable. */
	void AddFixtureVariable(UBlueprint* Blueprint, const FString& VarName, FName Category, FName SubCategory = NAME_None)
	{
		if (!Blueprint)
		{
			return;
		}
		FEdGraphPinType PinType;
		PinType.PinCategory = Category;
		PinType.PinSubCategory = SubCategory;
		FBlueprintEditorUtils::AddMemberVariable(Blueprint, FName(*VarName), PinType);
	}

	/**
	 * Best-effort teardown. Isolation comes from the unique package leaf, not
	 * from collection: the AssetRegistry entry or an undo record may still hold
	 * a reference, so no test asserts the object is gone. RF_Standalone is
	 * cleared first, and MarkAsGarbage check()s that the object is not rooted.
	 */
	void DestroyFixtureBlueprint(FFixtureBlueprint& Fixture)
	{
		if (Fixture.Blueprint)
		{
			FAssetRegistryModule::AssetDeleted(Fixture.Blueprint);
			Fixture.Blueprint->ClearFlags(RF_Public | RF_Standalone);
			Fixture.Blueprint->MarkAsGarbage();
			Fixture.Blueprint = nullptr;
		}
		if (Fixture.Package)
		{
			Fixture.Package->SetDirtyFlag(false);
			Fixture.Package->ClearFlags(RF_Public | RF_Standalone);
			Fixture.Package->MarkAsGarbage();
			Fixture.Package = nullptr;
		}
		CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
	}

	/** One command through the registry the plugin populates at startup. */
	TSharedPtr<FJsonObject> Dispatch(const FString& Command, const TSharedPtr<FJsonObject>& Params)
	{
		TSharedPtr<FJsonObject> Response;
		FMCPCommandRegistry::Get().Dispatch(Command, Params, Response);
		return Response;
	}

	/** True when status == "success". OutCode carries the error code otherwise. */
	bool IsSuccess(const TSharedPtr<FJsonObject>& Response, FString& OutCode)
	{
		OutCode.Reset();
		if (!Response.IsValid())
		{
			OutCode = TEXT("NO_RESPONSE");
			return false;
		}
		FString Status;
		Response->TryGetStringField(TEXT("status"), Status);
		Response->TryGetStringField(TEXT("code"), OutCode);
		return Status == TEXT("success");
	}

	FString ErrorCodeOf(const TSharedPtr<FJsonObject>& Response)
	{
		FString Code;
		IsSuccess(Response, Code);
		return Code;
	}

	/**
	 * Log-silent string read. FJsonObject::GetStringField on an absent field
	 * logs a LogJson Error, and the automation framework counts an Error-level
	 * log as a test failure — so a missing optional field would be reported as
	 * a JSON type error rather than as the assertion that actually failed.
	 * Several fields read below are conditional (begin_play_node_id, the self
	 * and callback_entry roles), so every string read off a JSON object goes
	 * through here. HasField stays where absence is the expected result; that
	 * path is log-silent already.
	 */
	FString StringFieldOr(const TSharedPtr<FJsonObject>& Obj, const FString& Field)
	{
		FString Value;
		if (Obj.IsValid())
		{
			Obj->TryGetStringField(Field, Value);
		}
		return Value;
	}

	TSharedPtr<FJsonObject> ResultOf(const TSharedPtr<FJsonObject>& Response)
	{
		const TSharedPtr<FJsonObject>* Result = nullptr;
		if (Response.IsValid() && Response->TryGetObjectField(TEXT("result"), Result) && Result)
		{
			return *Result;
		}
		return MakeShared<FJsonObject>();
	}

	/** The entry of Result[ArrayField] whose "role" matches, or an empty object. */
	TSharedPtr<FJsonObject> FindRole(const TSharedPtr<FJsonObject>& Result, const FString& ArrayField, const FString& Role)
	{
		const TArray<TSharedPtr<FJsonValue>>* Entries = nullptr;
		if (Result.IsValid() && Result->TryGetArrayField(ArrayField, Entries) && Entries)
		{
			for (const TSharedPtr<FJsonValue>& Entry : *Entries)
			{
				const TSharedPtr<FJsonObject>* Obj = nullptr;
				FString EntryRole;
				if (Entry.IsValid() && Entry->TryGetObject(Obj) && Obj && (*Obj)->TryGetStringField(TEXT("role"), EntryRole)
					&& EntryRole == Role)
				{
					return *Obj;
				}
			}
		}
		return MakeShared<FJsonObject>();
	}

	/** The fixture's event graph. CreateBlueprint gives an Actor Blueprint one. */
	UEdGraph* FixtureEventGraph(UBlueprint* Blueprint)
	{
		if (!Blueprint)
		{
			return nullptr;
		}
		for (UEdGraph* Graph : Blueprint->UbergraphPages)
		{
			if (Graph && Graph->GetName().Contains(TEXT("EventGraph")))
			{
				return Graph;
			}
		}
		return nullptr;
	}

	template <typename TNode>
	TNode* FindFirstNodeOfClass(UEdGraph* Graph)
	{
		if (!Graph)
		{
			return nullptr;
		}
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (TNode* Typed = Cast<TNode>(Node))
			{
				return Typed;
			}
		}
		return nullptr;
	}

	/**
	 * The node the handler actually reported, looked up by the GUID from its
	 * response. Preferred over FindFirstNodeOfClass wherever the envelope names
	 * a node: a freshly created Actor Blueprint's event graph is not guaranteed
	 * to be empty, so "first node of class X" can pick a node the handler never
	 * touched and fail later with a message that points nowhere.
	 */
	UEdGraphNode* FindNodeByGuid(UEdGraph* Graph, const FString& NodeId)
	{
		if (!Graph || NodeId.IsEmpty())
		{
			return nullptr;
		}
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (Node && Node->NodeGuid.ToString() == NodeId)
			{
				return Node;
			}
		}
		return nullptr;
	}

	/**
	 * First pin matching any of PinNames case-insensitively in the given
	 * direction. Takes a list because engine function pins are looked up by
	 * several spellings (Time / Interval, bLooping / Looping), exactly as the
	 * handlers' FindInputPinByNames does.
	 */
	UEdGraphPin* FindFixturePin(UEdGraphNode* Node, const TArray<FString>& PinNames, EEdGraphPinDirection Direction)
	{
		if (!Node)
		{
			return nullptr;
		}
		for (const FString& PinName : PinNames)
		{
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (Pin && Pin->Direction == Direction && Pin->PinName.ToString().Equals(PinName, ESearchCase::IgnoreCase))
				{
					return Pin;
				}
			}
		}
		return nullptr;
	}
}

// =====================================================================================
// add_blueprint_variable_assignment — literal kind. Chosen over the variable kind
// because the literal path is what FormatLiteralForPinCategory now serves, and an
// Int variable lets the pin default be asserted as an exact string.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersAddVariableAssignmentTest,
	"UEMCP.BlueprintHandlers.AddVariableAssignment",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersAddVariableAssignmentTest::RunTest(const FString& Parameters)
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

	// ---- success: literal assignment of 5 to Score ----
	TSharedPtr<FJsonObject> Assignment = MakeShared<FJsonObject>();
	Assignment->SetStringField(TEXT("kind"), TEXT("literal"));
	Assignment->SetNumberField(TEXT("value"), 5.0);

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Params->SetStringField(TEXT("target_variable"), TEXT("Score"));
	Params->SetObjectField(TEXT("assignment"), Assignment);
	Params->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> Response = Dispatch(TEXT("add_blueprint_variable_assignment"), Params);
	FString Code;
	if (!IsSuccess(Response, Code))
	{
		AddError(FString::Printf(TEXT("literal assignment failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	const TSharedPtr<FJsonObject> Result = ResultOf(Response);
	TestEqual(TEXT("graph_name"), StringFieldOr(Result, TEXT("graph_name")), FString(TEXT("EventGraph")));
	TestEqual(TEXT("target_variable"), StringFieldOr(Result, TEXT("target_variable")), FString(TEXT("Score")));
	TestEqual(TEXT("assignment_kind lowercased"), StringFieldOr(Result, TEXT("assignment_kind")), FString(TEXT("literal")));
	TestFalse(TEXT("no source_variable on a literal"), Result->HasField(TEXT("source_variable")));
	TestTrue(TEXT("requires_compile set when compile is false"), Result->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("compiled false"), Result->GetBoolField(TEXT("compiled")));

	const TArray<TSharedPtr<FJsonValue>>* Links = nullptr;
	TestTrue(TEXT("links array present"), Result->TryGetArrayField(TEXT("links"), Links));
	TestEqual(TEXT("literal assignment creates no links"), Links ? Links->Num() : -1, 0);

	const TSharedPtr<FJsonObject> SetNodeJson = FindRole(Result, TEXT("nodes"), TEXT("set"));
	TestEqual(TEXT("set node class"), StringFieldOr(SetNodeJson, TEXT("node_class")), FString(TEXT("K2Node_VariableSet")));
	TestFalse(TEXT("set node_id is empty"), StringFieldOr(SetNodeJson, TEXT("node_id")).IsEmpty());
	TestFalse(TEXT("no get node for a literal"), FindRole(Result, TEXT("nodes"), TEXT("get"))->HasField(TEXT("node_id")));

	const TSharedPtr<FJsonObject> TargetPinJson = FindRole(Result, TEXT("pins"), TEXT("target_value"));
	TestEqual(TEXT("target pin name"), StringFieldOr(TargetPinJson, TEXT("name")), FString(TEXT("Score")));
	TestEqual(TEXT("target pin direction"), StringFieldOr(TargetPinJson, TEXT("direction")), FString(TEXT("input")));
	TestEqual(TEXT("target pin default"), StringFieldOr(TargetPinJson, TEXT("default")), FString(TEXT("5")));

	// ---- graph state, read from the graph rather than the envelope ----
	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	UK2Node_VariableSet* SetNode = FindFirstNodeOfClass<UK2Node_VariableSet>(EventGraph);
	if (!SetNode)
	{
		AddError(TEXT("no K2Node_VariableSet in the event graph after a successful assignment"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("set node targets Score"), SetNode->VariableReference.GetMemberName(), FName(TEXT("Score")));
	TestEqual(TEXT("set node id matches the envelope"),
		SetNode->NodeGuid.ToString(), StringFieldOr(SetNodeJson, TEXT("node_id")));

	UEdGraphPin* ScorePin = FindFixturePin(SetNode, {TEXT("Score")}, EGPD_Input);
	if (!ScorePin)
	{
		AddError(TEXT("the variable-set node has no Score input pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("pin default written in the graph"), ScorePin->DefaultValue, FString(TEXT("5")));
	TestEqual(TEXT("pin left unlinked"), ScorePin->LinkedTo.Num(), 0);
	TestEqual(TEXT("pin category"), ScorePin->PinType.PinCategory, UEdGraphSchema_K2::PC_Int);

	// ---- error: unknown target variable ----
	TSharedPtr<FJsonObject> MissingVarParams = MakeShared<FJsonObject>();
	MissingVarParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	MissingVarParams->SetStringField(TEXT("target_variable"), TEXT("NoSuchVariable"));
	MissingVarParams->SetObjectField(TEXT("assignment"), Assignment);
	TestEqual(TEXT("unknown variable code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), MissingVarParams)),
		FString(TEXT("VARIABLE_NOT_FOUND")));

	// ---- error: unsupported assignment kind, with its detail block ----
	TSharedPtr<FJsonObject> BadKind = MakeShared<FJsonObject>();
	BadKind->SetStringField(TEXT("kind"), TEXT("increment"));
	TSharedPtr<FJsonObject> BadKindParams = MakeShared<FJsonObject>();
	BadKindParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	BadKindParams->SetStringField(TEXT("target_variable"), TEXT("Score"));
	BadKindParams->SetObjectField(TEXT("assignment"), BadKind);

	const TSharedPtr<FJsonObject> BadKindResponse = Dispatch(TEXT("add_blueprint_variable_assignment"), BadKindParams);
	TestEqual(TEXT("unsupported kind code"), ErrorCodeOf(BadKindResponse), FString(TEXT("UNSUPPORTED_ASSIGNMENT_KIND")));
	const TSharedPtr<FJsonObject>* Detail = nullptr;
	if (BadKindResponse.IsValid() && BadKindResponse->TryGetObjectField(TEXT("detail"), Detail) && Detail)
	{
		TestEqual(TEXT("detail echoes the provided kind"), StringFieldOr((*Detail), TEXT("provided")), FString(TEXT("increment")));
		const TArray<TSharedPtr<FJsonValue>>* Allowed = nullptr;
		TestTrue(TEXT("detail lists allowed values"), (*Detail)->TryGetArrayField(TEXT("allowed_values"), Allowed));
		TestEqual(TEXT("two allowed kinds"), Allowed ? Allowed->Num() : -1, 2);
	}
	else
	{
		AddError(TEXT("UNSUPPORTED_ASSIGNMENT_KIND carried no detail object"));
	}

	// ---- error: missing assignment object ----
	TSharedPtr<FJsonObject> NoAssignment = MakeShared<FJsonObject>();
	NoAssignment->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	NoAssignment->SetStringField(TEXT("target_variable"), TEXT("Score"));
	TestEqual(TEXT("missing assignment code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), NoAssignment)),
		FString(TEXT("MISSING_PARAMS")));

	// ---- error: unresolvable blueprint_name ----
	TSharedPtr<FJsonObject> BadBlueprint = MakeShared<FJsonObject>();
	BadBlueprint->SetStringField(TEXT("blueprint_name"), TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	BadBlueprint->SetStringField(TEXT("target_variable"), TEXT("Score"));
	BadBlueprint->SetObjectField(TEXT("assignment"), Assignment);
	TestEqual(TEXT("unresolvable blueprint code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), BadBlueprint)),
		FString(TEXT("BLUEPRINT_NOT_FOUND")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
```

- [ ] **Step 2: Build and run**

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `PASS UEMCP.BlueprintHandlers.AddVariableAssignment` and **`Native tests: 20 passed, 0 failed, 0 not run`**. This is a characterization test over shipped behavior, so it passes on the first green build; the count is what proves it ran.

If it fails, read the error text before changing the test. A `BLUEPRINT_NOT_FOUND` on the success path means the fixture's object name and package leaf have drifted apart (see Global Constraints); a `VARIABLE_NOT_FOUND` means `AddMemberVariable` did not take.

- [ ] **Step 3: Prove the assertions bind (deliberate falsification)**

Temporarily change one assertion to a value that must be wrong, so the test is shown to be capable of failing rather than merely of passing:

```cpp
	TestEqual(TEXT("pin default written in the graph"), ScorePin->DefaultValue, FString(TEXT("999")));
```

Then build and run:

```bash
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `FAIL UEMCP.BlueprintHandlers.AddVariableAssignment` with an `Expected '5' to equal '999'`-shaped message, and `Native tests: 19 passed, 1 failed, 0 not run`. **Restore `TEXT("5")`**, rebuild, and confirm `Native tests: 20 passed, 0 failed, 0 not run` again before committing.

- [ ] **Step 4: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color --profile smoke
```

Expected: 0 collisions; `SYNC`. (No Node code changed, so the rotation is not re-run for this task.)

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Add a native handler test for add_blueprint_variable_assignment

First automated check on a BlueprintHandlers.cpp handler body. The test builds
an Actor Blueprint in an unsaved in-memory package, dispatches the command
through FMCPCommandRegistry the way the wire does, and asserts both halves:
the response envelope (graph name, assignment kind, node role and class, the
target pin's default) and the graph the handler actually produced (a
K2Node_VariableSet bound to the variable, its input pin carrying the literal
and no links). Four error codes are covered: VARIABLE_NOT_FOUND,
UNSUPPORTED_ASSIGNMENT_KIND with its detail block, MISSING_PARAMS and
BLUEPRINT_NOT_FOUND.

The fixture helpers in this file are reused by the timer and disconnect tests.
Nothing is saved: the package has no file on disk.

Native tests 19 -> 20.
MSG
```

---

### Task 3: The `add_blueprint_timer` test

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` (append one test; the fixture namespace is unchanged)

**Interfaces:**
- Consumes from Task 2, all in `namespace UEMCP::Blueprint::Tests`: `FFixtureBlueprint`, `CreateFixtureBlueprint()`, `DestroyFixtureBlueprint(FFixtureBlueprint&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `ErrorCodeOf(const TSharedPtr<FJsonObject>&)`, `ResultOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `FindRole(const TSharedPtr<FJsonObject>&, const FString&, const FString&)`, `FixtureEventGraph(UBlueprint*)`, `FindNodeByGuid(UEdGraph*, const FString&)`, `FindFixturePin(UEdGraphNode*, const TArray<FString>&, EEdGraphPinDirection)`.
- Produces: nothing new. Task 4 consumes the same Task 2 helpers.

- [ ] **Step 1: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the assignment test and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// add_blueprint_timer — the handler that authors a K2_SetTimer call, a Self node
// for its Object pin, a ReceiveBeginPlay event, and the callback function graph.
// compile:false keeps the compile-diagnostic path out of it; the asserted state
// does not need a compiled class.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersAddTimerTest,
	"UEMCP.BlueprintHandlers.AddTimer",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersAddTimerTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	const FString CallbackName = TEXT("OnUEMCPFixtureTimer");

	// ---- success ----
	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	Params->SetStringField(TEXT("callback_function"), CallbackName);
	Params->SetNumberField(TEXT("interval"), 1.5);
	Params->SetBoolField(TEXT("looping"), true);
	Params->SetBoolField(TEXT("create_callback_graph"), true);
	Params->SetBoolField(TEXT("insert_on_begin_play"), true);
	Params->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> Response = Dispatch(TEXT("add_blueprint_timer"), Params);
	FString Code;
	if (!IsSuccess(Response, Code))
	{
		AddError(FString::Printf(TEXT("add_blueprint_timer failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	const TSharedPtr<FJsonObject> Result = ResultOf(Response);
	TestEqual(TEXT("blueprint_name echoed"), StringFieldOr(Result, TEXT("blueprint_name")), Fixture.PackagePath);
	TestEqual(TEXT("callback_function echoed"), StringFieldOr(Result, TEXT("callback_function")), CallbackName);
	TestEqual(TEXT("event_graph_name"), StringFieldOr(Result, TEXT("event_graph_name")), FString(TEXT("EventGraph")));
	TestEqual(TEXT("callback_graph_name"), StringFieldOr(Result, TEXT("callback_graph_name")), CallbackName);
	TestTrue(TEXT("function_graph_created"), Result->GetBoolField(TEXT("function_graph_created")));
	TestFalse(TEXT("timer_node_id is empty"), StringFieldOr(Result, TEXT("timer_node_id")).IsEmpty());
	TestFalse(TEXT("begin_play_node_id is empty"), StringFieldOr(Result, TEXT("begin_play_node_id")).IsEmpty());
	TestTrue(TEXT("requires_compile set when compile is false"), Result->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("compiled false"), Result->GetBoolField(TEXT("compiled")));
	TestFalse(TEXT("no compile block without compile:true"), Result->HasField(TEXT("compile")));

	TestFalse(TEXT("begin_play role node_id is empty"), StringFieldOr(FindRole(Result, TEXT("nodes"), TEXT("begin_play")), TEXT("node_id")).IsEmpty());
	TestEqual(TEXT("timer node class"),
		StringFieldOr(FindRole(Result, TEXT("nodes"), TEXT("timer")), TEXT("node_class")),
		FString(TEXT("K2Node_CallFunction")));
	TestEqual(TEXT("callback entry class"),
		StringFieldOr(FindRole(Result, TEXT("nodes"), TEXT("callback_entry")), TEXT("node_class")),
		FString(TEXT("K2Node_FunctionEntry")));
	TestFalse(TEXT("exec link source_node_id is empty"), StringFieldOr(FindRole(Result, TEXT("links"), TEXT("exec")), TEXT("source_node_id")).IsEmpty());

	// ---- graph state ----
	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	// Resolved by the GUIDs the handler reported, which is itself the
	// envelope-to-graph cross-check: a node of the expected class sitting at the
	// reported id means the envelope described what was really built.
	UK2Node_CallFunction* TimerNode = Cast<UK2Node_CallFunction>(
		FindNodeByGuid(EventGraph, StringFieldOr(Result, TEXT("timer_node_id"))));
	UK2Node_Event* BeginPlayNode = Cast<UK2Node_Event>(
		FindNodeByGuid(EventGraph, StringFieldOr(Result, TEXT("begin_play_node_id"))));
	if (!TimerNode || !BeginPlayNode)
	{
		AddError(TEXT("a reported node id did not resolve to a node of that class in the event graph"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("timer node calls K2_SetTimer"),
		TimerNode->FunctionReference.GetMemberName(), FName(TEXT("K2_SetTimer")));
	TestEqual(TEXT("begin play overrides ReceiveBeginPlay"),
		BeginPlayNode->EventReference.GetMemberName(), FName(TEXT("ReceiveBeginPlay")));

	UEdGraphPin* FunctionNamePin = FindFixturePin(TimerNode, {TEXT("FunctionName"), TEXT("Function Name")}, EGPD_Input);
	UEdGraphPin* TimePin = FindFixturePin(TimerNode, {TEXT("Time"), TEXT("Interval")}, EGPD_Input);
	UEdGraphPin* LoopingPin = FindFixturePin(TimerNode, {TEXT("bLooping"), TEXT("Looping")}, EGPD_Input);
	if (!FunctionNamePin || !TimePin || !LoopingPin)
	{
		AddError(TEXT("K2_SetTimer node is missing one of the FunctionName / Time / bLooping input pins"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("FunctionName default"), FunctionNamePin->DefaultValue, CallbackName);
	TestEqual(TEXT("Time default"), TimePin->DefaultValue, FString::SanitizeFloat(1.5));
	TestEqual(TEXT("bLooping default"), LoopingPin->DefaultValue, FString(TEXT("true")));

	UEdGraphPin* ThenPin = FindFixturePin(BeginPlayNode, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecutePin = FindFixturePin(TimerNode, {TEXT("execute")}, EGPD_Input);
	if (!ThenPin || !ExecutePin)
	{
		AddError(TEXT("exec pins not found on the begin-play or timer node"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestTrue(TEXT("begin play then links to the timer execute pin"), ThenPin->LinkedTo.Contains(ExecutePin));

	// The Object pin is driven by a Self node, so it must be linked, not defaulted.
	if (UEdGraphPin* ObjectPin = FindFixturePin(TimerNode, {TEXT("Object")}, EGPD_Input))
	{
		TestEqual(TEXT("timer Object pin has one link"), ObjectPin->LinkedTo.Num(), 1);
		TestFalse(TEXT("self role node_id is empty"), StringFieldOr(FindRole(Result, TEXT("nodes"), TEXT("self")), TEXT("node_id")).IsEmpty());
	}

	// The callback function graph exists on the Blueprint, not just in the response.
	bool bCallbackGraphPresent = false;
	for (UEdGraph* Graph : Fixture.Blueprint->FunctionGraphs)
	{
		bCallbackGraphPresent |= (Graph && Graph->GetName() == CallbackName);
	}
	TestTrue(TEXT("callback function graph added to the Blueprint"), bCallbackGraphPresent);

	// ---- error: no callback_function ----
	TSharedPtr<FJsonObject> NoCallback = MakeShared<FJsonObject>();
	NoCallback->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	NoCallback->SetNumberField(TEXT("interval"), 1.0);
	TestEqual(TEXT("missing callback code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), NoCallback)),
		FString(TEXT("MISSING_PARAMS")));

	// ---- error: non-positive interval ----
	TSharedPtr<FJsonObject> BadInterval = MakeShared<FJsonObject>();
	BadInterval->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	BadInterval->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPFixtureTimerTwo"));
	BadInterval->SetNumberField(TEXT("interval"), 0.0);
	TestEqual(TEXT("non-positive interval code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), BadInterval)),
		FString(TEXT("INVALID_INTERVAL")));

	// ---- error: callback graph missing and creation declined ----
	TSharedPtr<FJsonObject> NoCreate = MakeShared<FJsonObject>();
	NoCreate->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	NoCreate->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPFixtureTimerAbsent"));
	NoCreate->SetNumberField(TEXT("interval"), 1.0);
	NoCreate->SetBoolField(TEXT("create_callback_graph"), false);
	TestEqual(TEXT("declined graph creation code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), NoCreate)),
		FString(TEXT("CALLBACK_GRAPH_NOT_FOUND")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Build and run**

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `PASS UEMCP.BlueprintHandlers.AddTimer` and **`Native tests: 21 passed, 0 failed, 0 not run`**.

- [ ] **Step 3: Prove the assertions bind (deliberate falsification)**

Temporarily change the timer-function assertion to a name that cannot be right:

```cpp
	TestEqual(TEXT("timer node calls K2_SetTimer"),
		TimerNode->FunctionReference.GetMemberName(), FName(TEXT("K2_ClearTimer")));
```

Build and run. Expected: `FAIL UEMCP.BlueprintHandlers.AddTimer` and `Native tests: 20 passed, 1 failed, 0 not run`. **Restore `K2_SetTimer`**, rebuild, confirm 21 passed / 0 failed.

- [ ] **Step 4: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color --profile smoke
```

Expected: 0 collisions; `SYNC`.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Add a native handler test for add_blueprint_timer

Covers the widest authoring path in BlueprintHandlers.cpp: a K2_SetTimer call
node with its FunctionName, Time and bLooping defaults, a Self node feeding the
Object pin, a ReceiveBeginPlay event wired then -> execute, and a created
callback function graph. Asserted through the envelope and again against the
graph, with the node GUIDs cross-checked between the two. Three error codes:
MISSING_PARAMS, INVALID_INTERVAL and CALLBACK_GRAPH_NOT_FOUND.

Native tests 20 -> 21.
MSG
```

---

### Task 4: The `disconnect_blueprint_pin` test

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp` (append one test)

**Interfaces:**
- Consumes from Task 2, all in `namespace UEMCP::Blueprint::Tests`: `FFixtureBlueprint`, `CreateFixtureBlueprint()`, `DestroyFixtureBlueprint(FFixtureBlueprint&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `IsSuccess(const TSharedPtr<FJsonObject>&, FString&)`, `ErrorCodeOf(const TSharedPtr<FJsonObject>&)`, `ResultOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `FixtureEventGraph(UBlueprint*)`, `FindNodeByGuid(UEdGraph*, const FString&)`, `FindFixturePin(UEdGraphNode*, const TArray<FString>&, EEdGraphPinDirection)`.
- Produces: nothing.

This test builds its own linked state by calling `add_blueprint_timer` on its own fixture — automation tests run in arbitrary order, so it must not depend on Task 3's test having run. Using the timer handler is what keeps it free of `BlueprintHandlers.cpp`'s file-local helpers: the timer success path links BeginPlay `then` to the timer's `execute` pin when `insert_on_begin_play` is true.

- [ ] **Step 1: Write the test**

Append to `UEMCPBlueprintHandlerTests.cpp`, after the timer test and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// disconnect_blueprint_pin — dry run, targeted break, and the four cheapest
// rejections. The linked state is authored by add_blueprint_timer on this test's
// own fixture: automation tests run in arbitrary order, so nothing here relies on
// the timer test having run.
// =====================================================================================

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPBlueprintHandlersDisconnectPinTest,
	"UEMCP.BlueprintHandlers.DisconnectPin",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPBlueprintHandlersDisconnectPinTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Blueprint::Tests;

	FFixtureBlueprint Fixture = CreateFixtureBlueprint();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("fixture Blueprint was not created"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// ---- arrange: BeginPlay.then -> Timer.execute, via the timer handler ----
	TSharedPtr<FJsonObject> TimerParams = MakeShared<FJsonObject>();
	TimerParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	TimerParams->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPDisconnectFixtureTimer"));
	TimerParams->SetNumberField(TEXT("interval"), 1.0);
	TimerParams->SetBoolField(TEXT("insert_on_begin_play"), true);
	TimerParams->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> TimerResponse = Dispatch(TEXT("add_blueprint_timer"), TimerParams);
	FString Code;
	if (!IsSuccess(TimerResponse, Code))
	{
		AddError(FString::Printf(TEXT("arrange step failed: add_blueprint_timer returned '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> TimerResult = ResultOf(TimerResponse);
	const FString BeginPlayId = StringFieldOr(TimerResult, TEXT("begin_play_node_id"));
	const FString TimerNodeId = StringFieldOr(TimerResult, TEXT("timer_node_id"));
	if (BeginPlayId.IsEmpty() || TimerNodeId.IsEmpty())
	{
		AddError(TEXT("arrange step produced no begin-play or timer node id"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	UK2Node_Event* BeginPlayNode = Cast<UK2Node_Event>(FindNodeByGuid(EventGraph, BeginPlayId));
	UK2Node_CallFunction* TimerNode = Cast<UK2Node_CallFunction>(FindNodeByGuid(EventGraph, TimerNodeId));
	UEdGraphPin* ThenPin = FindFixturePin(BeginPlayNode, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecutePin = FindFixturePin(TimerNode, {TEXT("execute")}, EGPD_Input);
	if (!ThenPin || !ExecutePin || !ThenPin->LinkedTo.Contains(ExecutePin))
	{
		AddError(TEXT("arrange step did not link begin play then to the timer execute pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// A helper so the three call shapes below differ only in the fields that matter.
	auto MakeDisconnectParams = [&Fixture, &BeginPlayId](bool bDryRun, const FString& TargetNodeId, const FString& TargetPin)
	{
		TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
		Params->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
		Params->SetStringField(TEXT("node_id"), BeginPlayId);
		Params->SetStringField(TEXT("pin"), TEXT("then"));
		Params->SetStringField(TEXT("direction"), TEXT("output"));
		Params->SetBoolField(TEXT("dry_run"), bDryRun);
		Params->SetBoolField(TEXT("compile"), false);
		if (!TargetNodeId.IsEmpty())
		{
			Params->SetStringField(TEXT("target_node_id"), TargetNodeId);
			Params->SetStringField(TEXT("target_pin"), TargetPin);
		}
		return Params;
	};

	// ---- dry run: reports the match, changes nothing ----
	const TSharedPtr<FJsonObject> DryResponse =
		Dispatch(TEXT("disconnect_blueprint_pin"), MakeDisconnectParams(true, TimerNodeId, TEXT("execute")));
	if (!IsSuccess(DryResponse, Code))
	{
		AddError(FString::Printf(TEXT("dry-run disconnect failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> DryResult = ResultOf(DryResponse);
	TestTrue(TEXT("dry_run echoed"), DryResult->GetBoolField(TEXT("dry_run")));
	TestEqual(TEXT("dry run matched one link"), (int32)DryResult->GetNumberField(TEXT("links_matched")), 1);
	TestEqual(TEXT("dry run broke nothing"), (int32)DryResult->GetNumberField(TEXT("links_broken")), 0);
	TestTrue(TEXT("dry run would_modify"), DryResult->GetBoolField(TEXT("would_modify")));
	TestFalse(TEXT("dry run requires_compile false"), DryResult->GetBoolField(TEXT("requires_compile")));
	TestTrue(TEXT("dry run left the link in place"), ThenPin->LinkedTo.Contains(ExecutePin));

	// ---- real, targeted break ----
	const TSharedPtr<FJsonObject> BreakResponse =
		Dispatch(TEXT("disconnect_blueprint_pin"), MakeDisconnectParams(false, TimerNodeId, TEXT("execute")));
	if (!IsSuccess(BreakResponse, Code))
	{
		AddError(FString::Printf(TEXT("disconnect failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> BreakResult = ResultOf(BreakResponse);
	TestEqual(TEXT("graph_name"), StringFieldOr(BreakResult, TEXT("graph_name")), FString(TEXT("EventGraph")));
	TestEqual(TEXT("node_id echoed"), StringFieldOr(BreakResult, TEXT("node_id")), BeginPlayId);
	TestEqual(TEXT("pin echoed"), StringFieldOr(BreakResult, TEXT("pin")), FString(TEXT("then")));
	TestEqual(TEXT("resolved direction"), StringFieldOr(BreakResult, TEXT("direction")), FString(TEXT("output")));
	TestFalse(TEXT("dry_run false"), BreakResult->GetBoolField(TEXT("dry_run")));
	TestEqual(TEXT("one link matched"), (int32)BreakResult->GetNumberField(TEXT("links_matched")), 1);
	TestEqual(TEXT("one link broken"), (int32)BreakResult->GetNumberField(TEXT("links_broken")), 1);
	TestTrue(TEXT("requires_compile after a real break"), BreakResult->GetBoolField(TEXT("requires_compile")));
	TestFalse(TEXT("compiled false"), BreakResult->GetBoolField(TEXT("compiled")));
	TestEqual(TEXT("target_node_id echoed"), StringFieldOr(BreakResult, TEXT("target_node_id")), TimerNodeId);
	TestEqual(TEXT("target_pin echoed"), StringFieldOr(BreakResult, TEXT("target_pin")), FString(TEXT("execute")));

	const TSharedPtr<FJsonObject>* TargetPinInfo = nullptr;
	if (BreakResult->TryGetObjectField(TEXT("target_pin_info"), TargetPinInfo) && TargetPinInfo)
	{
		TestEqual(TEXT("target_pin_info name"), StringFieldOr((*TargetPinInfo), TEXT("name")), FString(TEXT("execute")));
		TestEqual(TEXT("target_pin_info direction"), StringFieldOr((*TargetPinInfo), TEXT("direction")), FString(TEXT("input")));
	}
	else
	{
		AddError(TEXT("targeted disconnect carried no target_pin_info"));
	}

	const TArray<TSharedPtr<FJsonValue>>* BrokenLinks = nullptr;
	TestTrue(TEXT("broken_links present"), BreakResult->TryGetArrayField(TEXT("broken_links"), BrokenLinks));
	TestEqual(TEXT("one broken link reported"), BrokenLinks ? BrokenLinks->Num() : -1, 1);
	if (BrokenLinks && BrokenLinks->Num() == 1)
	{
		const TSharedPtr<FJsonObject>* Link = nullptr;
		if ((*BrokenLinks)[0]->TryGetObject(Link) && Link)
		{
			TestEqual(TEXT("broken link names the pin"), StringFieldOr((*Link), TEXT("pin")), FString(TEXT("then")));
			TestEqual(TEXT("broken link names the linked pin"), StringFieldOr((*Link), TEXT("linked_pin")), FString(TEXT("execute")));
			TestEqual(TEXT("broken link source node"), StringFieldOr((*Link), TEXT("source_node_id")), BeginPlayId);
			TestEqual(TEXT("broken link target node"), StringFieldOr((*Link), TEXT("target_node_id")), TimerNodeId);
		}
	}

	// ---- graph state: the link is actually gone, the nodes are not ----
	TestFalse(TEXT("link removed from the graph"), ThenPin->LinkedTo.Contains(ExecutePin));
	TestEqual(TEXT("then pin has no links left"), ThenPin->LinkedTo.Num(), 0);
	TestEqual(TEXT("execute pin has no links left"), ExecutePin->LinkedTo.Num(), 0);
	TestNotNull(TEXT("begin play node still present"), FindNodeByGuid(EventGraph, BeginPlayId));
	TestNotNull(TEXT("timer node still present"), FindNodeByGuid(EventGraph, TimerNodeId));

	// ---- error: the same targeted disconnect a second time ----
	TestEqual(TEXT("second targeted disconnect code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), MakeDisconnectParams(false, TimerNodeId, TEXT("execute")))),
		FString(TEXT("LINK_NOT_FOUND")));

	// ---- error: bad direction ----
	TSharedPtr<FJsonObject> BadDirection = MakeDisconnectParams(true, FString(), FString());
	BadDirection->SetStringField(TEXT("direction"), TEXT("sideways"));
	TestEqual(TEXT("bad direction code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), BadDirection)),
		FString(TEXT("INVALID_DIRECTION")));

	// ---- error: unknown node ----
	TSharedPtr<FJsonObject> BadNode = MakeDisconnectParams(true, FString(), FString());
	BadNode->SetStringField(TEXT("node_id"), FGuid::NewGuid().ToString());
	TestEqual(TEXT("unknown node code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), BadNode)),
		FString(TEXT("NODE_NOT_FOUND")));

	// ---- error: unknown pin ----
	TSharedPtr<FJsonObject> BadPin = MakeDisconnectParams(true, FString(), FString());
	BadPin->SetStringField(TEXT("pin"), TEXT("no_such_pin"));
	TestEqual(TEXT("unknown pin code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), BadPin)),
		FString(TEXT("PIN_NOT_FOUND")));

	// ---- error: target_node_id without target_pin ----
	TSharedPtr<FJsonObject> HalfTarget = MakeDisconnectParams(true, FString(), FString());
	HalfTarget->SetStringField(TEXT("target_node_id"), TimerNodeId);
	TestEqual(TEXT("half-specified target code"),
		ErrorCodeOf(Dispatch(TEXT("disconnect_blueprint_pin"), HalfTarget)),
		FString(TEXT("MISSING_PARAMS")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}
```

- [ ] **Step 2: Build and run**

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `PASS UEMCP.BlueprintHandlers.DisconnectPin` and **`Native tests: 22 passed, 0 failed, 0 not run`**.

- [ ] **Step 3: Prove the assertions bind (deliberate falsification)**

Temporarily invert the post-break graph assertion:

```cpp
	TestTrue(TEXT("link removed from the graph"), ThenPin->LinkedTo.Contains(ExecutePin));
```

Build and run. Expected: `FAIL UEMCP.BlueprintHandlers.DisconnectPin` and `Native tests: 21 passed, 1 failed, 0 not run`. **Restore `TestFalse`**, rebuild, confirm 22 passed / 0 failed.

- [ ] **Step 4: Guards**

```bash
node server/test-anon-namespace-audit.mjs
node server/verify-deploy.mjs --quiet --no-color --profile smoke
```

Expected: 0 collisions; `SYNC`.

- [ ] **Step 5: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBlueprintHandlerTests.cpp
git commit -F - <<'MSG'
Add a native handler test for disconnect_blueprint_pin

The test authors its own linked state through add_blueprint_timer rather than
depending on another test, since automation tests run in arbitrary order. It
then covers the dry-run path (matches reported, graph untouched), the targeted
break (links_matched, links_broken, target_pin_info, the broken_links row) and
the graph afterwards (both pins unlinked, both nodes still present). Five error
codes: LINK_NOT_FOUND on a repeat, INVALID_DIRECTION, NODE_NOT_FOUND,
PIN_NOT_FOUND and MISSING_PARAMS for a half-specified target.

Native tests 21 -> 22.
MSG
```

---

### Task 5: Record the new coverage and close WS5b

**Files:**
- Modify: `CLAUDE.md:421`
- Modify: `docs/tracking/risks-and-decisions.md` (append one row after D196)

**Interfaces:**
- Consumes: the four test files and the final count of 22 from Tasks 1-4.
- Produces: nothing consumed by later tasks (this is the last).

- [ ] **Step 1: Verify the numbers this task is about to write down**

```bash
run-native-tests.bat --profile smoke
P=plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp
sed -n '607,765p' $P | wc -l
sed -n '599,1230p' $P | wc -l
sed -n '96,217p' $P | wc -l
sed -n '1113,1211p' $P | wc -l
```

Expected: `Native tests: 22 passed, 0 failed, 0 not run`, then `159`, `632`, `122`, `99`. If any figure differs, the transport file has changed since this plan was written — re-measure and write the new numbers into the D197 row rather than the ones below.

- [ ] **Step 2: Update the CLAUDE.md count and file list**

In `CLAUDE.md`, replace this fragment:

```
**Native plugin tests**: 16 UE automation tests live in `plugin/UEMCP/Source/UEMCP/Private/Tests/` (`UEMCPTests.cpp`, `MCPServerTransportPolicyTests.cpp`; pretty-name filter
```

with:

```
**Native plugin tests**: 22 UE automation tests live in `plugin/UEMCP/Source/UEMCP/Private/Tests/` (`UEMCPTests.cpp`, `MCPServerTransportPolicyTests.cpp`, `UEMCPBlueprintHelperTests.cpp`, `UEMCPBlueprintHandlerTests.cpp`; pretty-name filter
```

- [ ] **Step 3: Fix the coverage clause in the same sentence**

The clause "not the `*Handlers.cpp` bodies" became false in Task 2. In `CLAUDE.md`, replace:

```
They cover transport intake, the command registry, the response builder and the parsers, not the `*Handlers.cpp` bodies.
```

with:

```
They cover transport intake, the command registry, the response builder, the parsers, the pure Blueprint helpers in `Public/BlueprintHandlerHelpers.h`, and three `BlueprintHandlers.cpp` handlers end-to-end through the registry (`add_blueprint_variable_assignment`, `add_blueprint_timer`, `disconnect_blueprint_pin`, each against an unsaved in-memory Blueprint); the other `*Handlers.cpp` bodies remain uncovered.
```

Do not touch the assertion-count sentence elsewhere in the Testing section — that belongs to WS1.

- [ ] **Step 4: Append the D197 row**

In `docs/tracking/risks-and-decisions.md`, add one row immediately after the `| D196 | … |` row, in the existing `| # | Decision | Rationale / Source |` format (one line, no embedded newlines, inner pipes escaped as `\|`):

```markdown
| D197 | **WS5b closed by measurement; no transport refactor 2026-09-13** — the health-audit remediation design's WS5b rested on the audit's "632-line `ReadOneRequest`" in `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp`. Measured against source, that function is lines **607-765 — 159 lines** — and already delegates every phase it has: `EvaluateReceiveDeadlines`, `ReceiveWithCapturedError`, `ClassifyReceiveAttempt`, `BuildRequestReadResult`, and `FMCPRequestDecoder`. The 632 figure is the span **599-1230**: the audit's `file_metrics` tool mis-detected the start by eight lines (599 is mid-body in the preceding `BuildRequestReadResult`) and ran the end past the function's close at 765 to the closing `};` of the `FMCPRequestDecoder::FImpl` struct that follows it — the same tab-indentation artifact that makes that tool find zero functions in tab-indented C++ and therefore makes the plugin health scores artifacts. The two largest real functions in the file are `ParseHeader` (96-217, **122 lines**) and `FImpl::FinalizeBody` (1113-1211, **99 lines**), neither of which WS5b named, and neither anywhere near the figure that justified the workstream. **Ruling: no transport refactor.** The seven `UEMCP.Transport.*` native tests plus the shared `plugin/UEMCP/Resources/Tests/tcp-transport-cases.json` fixture already pin this function's intake, classification and result mapping, so splitting it would move covered code without adding coverage while touching the one file whose behaviour is contracted across Node and native. WS5a (handler tests) shipped instead: native suite 16 → 22, with `BlueprintHandlers.cpp` gaining its first automated check. Revisit trigger: a real function in this file exceeding ~200 lines, or a transport change that cannot be tested through the existing seven. (closes the design doc's §4 WS5b) | Every number reproducible from the repo: `sed -n '607,765p' <file> \| wc -l` → 159; `sed -n '599,1230p' <file> \| wc -l` → 632; `sed -n '96,217p' <file> \| wc -l` → 122; `sed -n '1113,1211p' <file> \| wc -l` → 99. Figures circulated pre-measurement (~123 and ~120 for the two largest) are superseded by these. WS5a verification: `run-native-tests.bat --profile smoke` reports `Native tests: 22 passed, 0 failed, 0 not run`; `node server/test-anon-namespace-audit.mjs` clean; Node rotation unchanged at 7580/0 across 79 files. Source: `docs/superpowers/specs/2026-09-09-health-audit-remediation-design.md` §4 WS5; plan `docs/superpowers/plans/2026-09-13-health-audit-ws5a-blueprint-handler-tests.md`; tool quirk recorded in the health-auditor reference note. |
```

- [ ] **Step 5: Codename and placeholder scan**

The pre-commit hook scans the staged diff against `.git/info/forbidden-tokens`, but scan first rather than relying on it — the hook is the safety net, not the first line of defence. From the repo root:

```bash
git add CLAUDE.md docs/tracking/risks-and-decisions.md
git diff --cached | grep -n -i -E "$(grep -v -e '^#' -e '^$' -e '^regex:' .git/info/forbidden-tokens | paste -sd'|' -)" || echo "no literal token match"
git diff --cached | grep -n -E "$(grep '^regex:' .git/info/forbidden-tokens | sed 's/^regex://' | paste -sd'|' -)" || echo "no regex token match"
```

The comment and blank lines must be filtered out of the literal list, or the bare `#` from the file's own header matches every heading and every `#include` in the diff. Expected: both commands print their "no … match" line. A real hit means a codename, a machine path or the blocked scratch-directory token reached a tracked file — fix it before committing. Also re-read the two diffs for `path/to/YourProject.uproject` / `<UE_ENGINE_ROOT>` placeholder discipline.

- [ ] **Step 6: Final verification**

```bash
run-native-tests.bat --profile smoke
node server/test-anon-namespace-audit.mjs
cd server && node run-rotation.mjs | tail -3
```

Expected: `Native tests: 22 passed, 0 failed, 0 not run`; audit clean; rotation `7580` passed, `0` failed across 79 files. `test-slash-command-anchors.mjs` reads CLAUDE.md, so a rotation failure here means the edit broke an anchor it depends on.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/tracking/risks-and-decisions.md
git commit -F - <<'MSG'
Record WS5a native coverage in CLAUDE.md and close WS5b by measurement (D197)

CLAUDE.md's native-tests note said 16 tests over two files and claimed they do
not cover the *Handlers.cpp bodies; both clauses are now false. Updated to 22
tests over four files, with the Blueprint handler coverage named.

D197 closes WS5b without a refactor. ReadOneRequest measures 159 lines, not
632; the audit figure spans a mis-detected start and runs past the function to
the end of the decoder struct that follows it. The largest real functions in
that file are 122 and 99 lines, and the seven transport tests plus the shared
cross-language fixture already cover the intake path a split would move.

Follow-up for whoever integrates this: WS5a adds four plugin files, so the team
target project's UEMCP pin and version record need bumping after merge for its
installed plugin source to include them.
MSG
```

---

## Self-review

**1. Spec coverage (§4 WS5a, §6).** Pre-start `git status`/`git log` check → Task 1 Step 1. Extraction into `Public/BlueprintHandlerHelpers.h` with unit tests in `Private/Tests/UEMCPBlueprintHelperTests.cpp`, W-K rule honoured → Task 1. Three handler tests on a Blueprint created in a test package, invoking the assignment, timer and disconnect handlers with JSON params and asserting envelope and graph state → Tasks 2, 3, 4. Verification `run-native-tests.bat` green, `Build.bat` clean, rotation unchanged, anon-namespace audit passes → every task's guard steps. §6 constraints: codename hygiene, no AI attribution, single commit per session-task, fail-loud numeric proof, team-project pin reminder → Global Constraints plus Task 5 Step 7. Spec WS5b → Task 5 D197 (closed by measurement; deviation declared).

**Gap accepted and declared:** the spec's "parameter validation shared by the handlers" has no pure extraction target — see Deviation 1. Nothing else in §4 WS5a or §6 is unmapped. The spec's "worker reports go to `docs/reports/`" is a dispatch convention, not a plan task.

**2. Placeholder scan.** No "TBD", no "implement later", no "add appropriate error handling", no "similar to Task N" — Tasks 3 and 4 restate the full deploy-cycle and guard commands rather than referring back, and each task's Interfaces block lists the exact helper signatures it consumes because its implementer may not have read Task 2. Every code step carries the real C++. Every expected output is a literal string. No private project name, no absolute machine path, no blocked scratch-directory token — `path/to/YourProject.uproject`, `<YourProject>Editor`, `<UE_ENGINE_ROOT>`, "the primary 5.6 target", "the team target project" throughout, verified against this checkout's `.git/info/forbidden-tokens` literals and its one regex.

**3. Type consistency.** `FormatLiteralForPinCategory(const FEdGraphPinType&, const TSharedPtr<FJsonValue>&, FString&, FString&, FString&)` is declared in the Task 1 header, defined in the Task 1 `.cpp`, called from the Task 1 wrapper, and exercised in the Task 1 test with exactly five arguments in that order. `SetSupportedVariableDefault(UObject*, FProperty*, const TSharedPtr<FJsonValue>&, FString&)` is unchanged from the original signature. The Task 2 fixture names — `FFixtureBlueprint`, `CreateFixtureBlueprint`, `AddFixtureVariable`, `DestroyFixtureBlueprint`, `Dispatch`, `IsSuccess`, `ErrorCodeOf`, `ResultOf`, `StringFieldOr`, `FindRole`, `FixtureEventGraph`, `FindFirstNodeOfClass`, `FindNodeByGuid`, `FindFixturePin` — are used under those exact names in Tasks 3 and 4, and `FindFixturePin` takes a `TArray<FString>` of candidate names in all three call sites. `FindFirstNodeOfClass` survives only because Task 2 still uses it for the variable-set node (whose GUID is cross-checked on the next line); Tasks 3 and 4 resolve every node through `FindNodeByGuid` on the id the handler reported, and every string read off a JSON object in those three tasks goes through `StringFieldOr` so an absent optional field cannot turn into a `LogJson` Error that the automation framework scores as a failure. `FFixtureBlueprint::PackagePath` is the field every `blueprint_name` reads. The two test files use different helper namespaces (`UEMCP::Blueprint::HelperTests`, `UEMCP::Blueprint::Tests`) so Unity cannot see a redefinition. Test totals chain 16 → 19 → 20 → 21 → 22 → 22 with no gap.
