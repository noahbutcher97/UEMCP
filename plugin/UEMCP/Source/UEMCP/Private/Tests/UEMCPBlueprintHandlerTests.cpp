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
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "Kismet/KismetSystemLibrary.h"
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

	TSharedPtr<FJsonObject> ResultOf(const TSharedPtr<FJsonObject>& Response)
	{
		const TSharedPtr<FJsonObject>* Result = nullptr;
		if (Response.IsValid() && Response->TryGetObjectField(TEXT("result"), Result) && Result)
		{
			return *Result;
		}
		return MakeShared<FJsonObject>();
	}

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

	/**
	 * The node the handler actually reported, looked up by the GUID from its
	 * response. Preferred over picking the first node of a given class in the
	 * graph: a freshly created Actor Blueprint's event graph is not guaranteed
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
	// Capitalized on purpose: the handler lowercases AssignmentKind before acting
	// on it (BlueprintHandlers.cpp:~2570), and the "assignment_kind lowercased"
	// assertion below only proves that if the input isn't already lowercase.
	TSharedPtr<FJsonObject> Assignment = MakeShared<FJsonObject>();
	Assignment->SetStringField(TEXT("kind"), TEXT("Literal"));
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
	UK2Node_VariableSet* SetNode = Cast<UK2Node_VariableSet>(
		FindNodeByGuid(EventGraph, StringFieldOr(SetNodeJson, TEXT("node_id"))));
	if (!SetNode)
	{
		AddError(TEXT("the reported node_id was not found in the event graph"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("set node targets Score"), SetNode->VariableReference.GetMemberName(), FName(TEXT("Score")));

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

	// target_value pin JSON cross-checked against the actual graph pin. link_count
	// is read via HasField + GetNumberField (not a bare GetNumberField) because a
	// missing field would otherwise log a LogJson Error the automation framework
	// scores as a failure, the same trap StringFieldOr exists to avoid for strings.
	TestEqual(TEXT("target pin_id matches the graph pin"), StringFieldOr(TargetPinJson, TEXT("pin_id")), ScorePin->PinId.ToString());
	if (TargetPinJson->HasField(TEXT("link_count")))
	{
		TestEqual(TEXT("target pin link_count"), (int32)TargetPinJson->GetNumberField(TEXT("link_count")), 0);
	}
	else
	{
		AddError(TEXT("target_value pin JSON carried no link_count"));
	}

	// ---- error: unknown target variable ----
	TSharedPtr<FJsonObject> MissingVarParams = MakeShared<FJsonObject>();
	MissingVarParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	MissingVarParams->SetStringField(TEXT("target_variable"), TEXT("NoSuchVariable"));
	MissingVarParams->SetObjectField(TEXT("assignment"), Assignment);
	MissingVarParams->SetBoolField(TEXT("compile"), false);
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
	BadKindParams->SetBoolField(TEXT("compile"), false);

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
	NoAssignment->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("missing assignment code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), NoAssignment)),
		FString(TEXT("MISSING_PARAMS")));

	// ---- error: unresolvable blueprint_name ----
	TSharedPtr<FJsonObject> BadBlueprint = MakeShared<FJsonObject>();
	BadBlueprint->SetStringField(TEXT("blueprint_name"), TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	BadBlueprint->SetStringField(TEXT("target_variable"), TEXT("Score"));
	BadBlueprint->SetObjectField(TEXT("assignment"), Assignment);
	BadBlueprint->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("unresolvable blueprint code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_variable_assignment"), BadBlueprint)),
		FString(TEXT("BLUEPRINT_NOT_FOUND")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}

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
	else
	{
		AddError(TEXT("timer call has no Object pin"));
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
	NoCallback->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("missing callback code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), NoCallback)),
		FString(TEXT("MISSING_PARAMS")));

	// ---- error: non-positive interval ----
	TSharedPtr<FJsonObject> BadInterval = MakeShared<FJsonObject>();
	BadInterval->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	BadInterval->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPFixtureTimerTwo"));
	BadInterval->SetNumberField(TEXT("interval"), 0.0);
	BadInterval->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("non-positive interval code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), BadInterval)),
		FString(TEXT("INVALID_INTERVAL")));

	// ---- error: callback graph missing and creation declined ----
	TSharedPtr<FJsonObject> NoCreate = MakeShared<FJsonObject>();
	NoCreate->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	NoCreate->SetStringField(TEXT("callback_function"), TEXT("OnUEMCPFixtureTimerAbsent"));
	NoCreate->SetNumberField(TEXT("interval"), 1.0);
	NoCreate->SetBoolField(TEXT("create_callback_graph"), false);
	NoCreate->SetBoolField(TEXT("compile"), false);
	TestEqual(TEXT("declined graph creation code"),
		ErrorCodeOf(Dispatch(TEXT("add_blueprint_timer"), NoCreate)),
		FString(TEXT("CALLBACK_GRAPH_NOT_FOUND")));

	DestroyFixtureBlueprint(Fixture);
	return true;
}

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
	// Re-resolved through FindNodeByGuid + FindFixturePin rather than reusing the
	// ThenPin/ExecutePin pointers captured before the dry-run and real-break
	// dispatches (Recommendation 2): today those pointers stay valid, but
	// re-resolving keeps the assertion honest if a future change reconstructs nodes.
	UEdGraphNode* BeginPlayNodeAfterBreak = FindNodeByGuid(EventGraph, BeginPlayId);
	UEdGraphNode* TimerNodeAfterBreak = FindNodeByGuid(EventGraph, TimerNodeId);
	TestNotNull(TEXT("begin play node still present"), BeginPlayNodeAfterBreak);
	TestNotNull(TEXT("timer node still present"), TimerNodeAfterBreak);
	UEdGraphPin* ThenPinAfterBreak = FindFixturePin(BeginPlayNodeAfterBreak, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecutePinAfterBreak = FindFixturePin(TimerNodeAfterBreak, {TEXT("execute")}, EGPD_Input);
	if (!ThenPinAfterBreak || !ExecutePinAfterBreak)
	{
		AddError(TEXT("could not re-resolve then/execute pins after the targeted break"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestFalse(TEXT("link removed from the graph"), ThenPinAfterBreak->LinkedTo.Contains(ExecutePinAfterBreak));
	TestEqual(TEXT("then pin has no links left"), ThenPinAfterBreak->LinkedTo.Num(), 0);
	TestEqual(TEXT("execute pin has no links left"), ExecutePinAfterBreak->LinkedTo.Num(), 0);

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

	// ---- arrange: a second link on BeginPlay.then, via a second timer ----
	// The targeted break above already emptied BeginPlay.then, so this second
	// add_blueprint_timer call reuses the existing ReceiveBeginPlay node
	// (FindOrCreateReceiveBeginPlay finds it by name before creating one) and
	// adds exactly one new link for the untargeted break below to act on.
	TSharedPtr<FJsonObject> TimerTwoParams = MakeShared<FJsonObject>();
	TimerTwoParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	TimerTwoParams->SetStringField(TEXT("callback_function"), TEXT("OnTickTwo"));
	TimerTwoParams->SetNumberField(TEXT("interval"), 2.0);
	TimerTwoParams->SetBoolField(TEXT("insert_on_begin_play"), true);
	TimerTwoParams->SetBoolField(TEXT("create_callback_graph"), true);
	TimerTwoParams->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> TimerTwoResponse = Dispatch(TEXT("add_blueprint_timer"), TimerTwoParams);
	if (!IsSuccess(TimerTwoResponse, Code))
	{
		AddError(FString::Printf(TEXT("second arrange step failed: add_blueprint_timer returned '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> TimerTwoResult = ResultOf(TimerTwoResponse);
	const FString TimerTwoNodeId = StringFieldOr(TimerTwoResult, TEXT("timer_node_id"));
	if (TimerTwoNodeId.IsEmpty() || StringFieldOr(TimerTwoResult, TEXT("begin_play_node_id")) != BeginPlayId)
	{
		AddError(TEXT("second arrange step did not reuse BeginPlay or produced no timer node id"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	UEdGraphNode* TimerTwoNode = FindNodeByGuid(EventGraph, TimerTwoNodeId);
	UEdGraphPin* ThenPinBeforeUntargeted = FindFixturePin(BeginPlayNodeAfterBreak, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecuteTwoPin = FindFixturePin(TimerTwoNode, {TEXT("execute")}, EGPD_Input);
	if (!ThenPinBeforeUntargeted || !ExecuteTwoPin || !ThenPinBeforeUntargeted->LinkedTo.Contains(ExecuteTwoPin))
	{
		AddError(TEXT("second arrange step did not link begin play then to the new timer execute pin"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// ---- act: untargeted break — no target_node_id/target_pin, so the handler
	// takes the Pin->BreakAllPinLinks(true) branch rather than BreakLinkTo
	// (BlueprintHandlers.cpp:~3226-3230) ----
	TSharedPtr<FJsonObject> UntargetedParams = MakeShared<FJsonObject>();
	UntargetedParams->SetStringField(TEXT("blueprint_name"), Fixture.PackagePath);
	UntargetedParams->SetStringField(TEXT("node_id"), BeginPlayId);
	UntargetedParams->SetStringField(TEXT("pin"), TEXT("then"));
	UntargetedParams->SetStringField(TEXT("direction"), TEXT("output"));
	UntargetedParams->SetBoolField(TEXT("dry_run"), false);
	UntargetedParams->SetBoolField(TEXT("compile"), false);

	const TSharedPtr<FJsonObject> UntargetedResponse = Dispatch(TEXT("disconnect_blueprint_pin"), UntargetedParams);
	if (!IsSuccess(UntargetedResponse, Code))
	{
		AddError(FString::Printf(TEXT("untargeted disconnect failed with code '%s'"), *Code));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const TSharedPtr<FJsonObject> UntargetedResult = ResultOf(UntargetedResponse);
	TestEqual(TEXT("untargeted break matched one link"), (int32)UntargetedResult->GetNumberField(TEXT("links_matched")), 1);
	TestEqual(TEXT("untargeted break broke one link"), (int32)UntargetedResult->GetNumberField(TEXT("links_broken")), 1);

	// ---- graph state after the untargeted break, re-resolved per Recommendation 2 ----
	UEdGraphNode* BeginPlayNodeAfterUntargeted = FindNodeByGuid(EventGraph, BeginPlayId);
	UEdGraphNode* TimerTwoNodeAfterUntargeted = FindNodeByGuid(EventGraph, TimerTwoNodeId);
	UEdGraphPin* ThenPinAfterUntargeted = FindFixturePin(BeginPlayNodeAfterUntargeted, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* ExecuteTwoPinAfterUntargeted = FindFixturePin(TimerTwoNodeAfterUntargeted, {TEXT("execute")}, EGPD_Input);
	if (!ThenPinAfterUntargeted || !ExecuteTwoPinAfterUntargeted)
	{
		AddError(TEXT("could not re-resolve then/execute pins after the untargeted break"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	TestEqual(TEXT("then pin has no links after untargeted break"), ThenPinAfterUntargeted->LinkedTo.Num(), 0);
	TestEqual(TEXT("new timer execute pin has no links after untargeted break"), ExecuteTwoPinAfterUntargeted->LinkedTo.Num(), 0);

	DestroyFixtureBlueprint(Fixture);
	return true;
}

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

// =====================================================================================
// add_blueprint_timer's two remaining reachable failures.
//
// NO_GRAPH needs a Blueprint with no event graph. FBlueprintEditorUtils::
// DoesSupportEventGraphs admits only BPTYPE_Normal and BPTYPE_LevelScript, so
// CreateBlueprint gives a BPTYPE_FunctionLibrary none, and FindEventGraph only
// searches — it never creates one — so the handler's FindOrCreateEventGraph returns
// null.
//
// COMPILE_FAILED needs a Blueprint that cannot compile. The first arrangement tried
// here was a planted UK2Node_Event override with an unresolvable EventReference —
// UK2Node_Event::ValidateNodeDuringCompilation is supposed to log an Error for that.
// It was falsified empirically on this UE 5.6 build: with the node confirmed correct
// at the C++ level (bOverrideFunction=true, ResolveMember returning null against both
// AActor and the Blueprint's own generated class), the handler's own compile still
// reported compiled_ok=true, num_errors=0, with no compiler log output at all in the
// test's window — so whatever FBlueprintCompilationManager::CompileSynchronously does
// with a root-set Event node in this configuration, it does not validate it the way a
// direct FKismetCompilerContext::Compile() call would.
//
// The arrangement used instead plants a UK2Node_CallFunction whose FunctionReference
// names a function that exists on no class at all. UK2Node_CallFunction::
// ValidateNodeDuringCompilation (K2Node_CallFunction.cpp) reports "Could not find a
// function named ..." as an Error purely from GetTargetFunction() being null — no
// override-resolution machinery involved — which is deterministic regardless of
// whatever ordering difference explains the first arrangement's silent success. It
// is wired into the exec chain off the fixture's own default ghost ReceiveBeginPlay
// node — FKismetEditorUtilities::CreateBlueprint auto-populates a fresh Actor
// Blueprint's event graph with one, confirmed empirically when a hand-seeded second
// ReceiveBeginPlay was never the node add_blueprint_timer's own
// FindOrCreateReceiveBeginPlay found (FindExistingEventNode's linear search hits the
// pre-existing ghost node first) — so add_blueprint_timer's own
// FindOrCreateReceiveBeginPlay reuses that same ghost node (bBeginPlayCreated stays
// false) rather than creating its own, which is what lets the planted node hang off
// a node the handler will not roll back.
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

	UEdGraph* EventGraph = FixtureEventGraph(Fixture.Blueprint);
	if (!EventGraph)
	{
		AddError(TEXT("fixture Blueprint has no event graph"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}

	// CreateBlueprint auto-populates a fresh Actor Blueprint's event graph with
	// default "ghost" event nodes (ReceiveBeginPlay, ReceiveActorBeginOverlap,
	// ReceiveTick) — confirmed empirically (a hand-seeded second ReceiveBeginPlay
	// node placed here was never the one add_blueprint_timer's own
	// FindOrCreateReceiveBeginPlay found, because FindExistingEventNode's linear
	// search over EventGraph->Nodes hits this pre-existing one first). Using it
	// directly is what makes bBeginPlayCreated false on the dispatch below, which is
	// what keeps it out of RollbackTimerAuthoring's removal list.
	UK2Node_Event* ExistingBeginPlay = nullptr;
	for (UEdGraphNode* Node : EventGraph->Nodes)
	{
		if (UK2Node_Event* Ev = Cast<UK2Node_Event>(Node); Ev && Ev->EventReference.GetMemberName() == FName(TEXT("ReceiveBeginPlay")))
		{
			ExistingBeginPlay = Ev;
			break;
		}
	}
	if (!ExistingBeginPlay)
	{
		AddError(TEXT("fixture Blueprint's event graph has no default ReceiveBeginPlay node"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	const FString ExistingBeginPlayId = ExistingBeginPlay->NodeGuid.ToString();

	// Plant a call-function node whose FunctionReference names a function that exists
	// on no class. UK2Node_CallFunction::ValidateNodeDuringCompilation reports
	// "Could not find a function named ..." as an Error purely from
	// GetTargetFunction() being null.
	UK2Node_CallFunction* BrokenCallNode = NewObject<UK2Node_CallFunction>(EventGraph);
	if (!BrokenCallNode)
	{
		AddError(TEXT("failed to create the planted call-function node"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	BrokenCallNode->FunctionReference.SetExternalMember(
		FName(TEXT("UEMCPFunctionThatDoesNotExist")), UKismetSystemLibrary::StaticClass());
	EventGraph->AddNode(BrokenCallNode);
	BrokenCallNode->CreateNewGuid();
	BrokenCallNode->PostPlacedNewNode();
	BrokenCallNode->AllocateDefaultPins();

	// AllocateDefaultPins only creates pins via CreatePinsForFunctionCall when the
	// function resolves (K2Node_CallFunction.cpp), so an unresolvable
	// FunctionReference yields a pinless node here. Create the exec pin by hand so the
	// node can be wired into the BeginPlay chain rather than left floating.
	UEdGraphPin* BrokenExecPin = BrokenCallNode->CreatePin(EGPD_Input, UEdGraphSchema_K2::PC_Exec, UEdGraphSchema_K2::PN_Execute);
	UEdGraphPin* ExistingThenPin = FindFixturePin(ExistingBeginPlay, {TEXT("then")}, EGPD_Output);
	if (!BrokenExecPin || !ExistingThenPin)
	{
		AddError(TEXT("could not wire the planted node into the existing BeginPlay exec chain"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	ExistingThenPin->MakeLinkTo(BrokenExecPin);
	const FString BrokenNodeId = BrokenCallNode->NodeGuid.ToString();

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
	// The existing ghost BeginPlay is reused, not created, by this dispatch.
	TestEqual(TEXT("detail names the existing begin play node"), StringFieldOr(*Detail, TEXT("begin_play_node_id")), ExistingBeginPlayId);

	const TSharedPtr<FJsonObject>* CompileBlock = nullptr;
	if ((*Detail)->TryGetObjectField(TEXT("compile"), CompileBlock) && CompileBlock)
	{
		TestFalse(TEXT("the compile block did not succeed"), (*CompileBlock)->GetBoolField(TEXT("succeeded")));
		TestTrue(TEXT("the compile block reports at least one error"), NumberFieldOr(*CompileBlock, TEXT("num_errors")) >= 1.0);

		// Matched loosely on purpose: the engine text is "Could not find a function
		// named \"{0}\" in '{1}'.\nMake sure '{2}' has been compiled for @@" and
		// FCompilerResultsLog substitutes the @@ token at report time.
		const TArray<TSharedPtr<FJsonValue>>* Errors = nullptr;
		bool bSawMissingFunction = false;
		if ((*CompileBlock)->TryGetArrayField(TEXT("errors"), Errors) && Errors)
		{
			for (const TSharedPtr<FJsonValue>& Entry : *Errors)
			{
				const TSharedPtr<FJsonObject>* Obj = nullptr;
				bSawMissingFunction |= (Entry.IsValid() && Entry->TryGetObject(Obj) && Obj
					&& StringFieldOr(*Obj, TEXT("message")).Contains(TEXT("Could not find a function named")));
			}
		}
		TestTrue(TEXT("the planted call node is the reported error"), bSawMissingFunction);
	}
	else
	{
		AddError(TEXT("the COMPILE_FAILED detail carried no compile block"));
	}

	// ---- RollbackTimerAuthoring: the handler's own nodes are gone; the pre-existing
	// begin-play node and the planted broken call node — neither authored by the
	// handler — are untouched ----
	const FString TimerNodeId = StringFieldOr(*Detail, TEXT("timer_node_id"));
	const FString SelfNodeId = StringFieldOr(*Detail, TEXT("self_node_id"));
	// Asserted non-empty first: FindNodeByGuid returns null for an empty id, so
	// without this the TestNull calls below could pass on missing fields.
	TestFalse(TEXT("detail names the timer node"), TimerNodeId.IsEmpty());
	TestFalse(TEXT("detail names the self node"), SelfNodeId.IsEmpty());

	TestNull(TEXT("the timer node was rolled back"), FindNodeByGuid(EventGraph, TimerNodeId));
	TestNull(TEXT("the self node was rolled back"), FindNodeByGuid(EventGraph, SelfNodeId));
	TestNotNull(TEXT("the pre-existing begin play node was not rolled back (not handler-created)"),
		FindNodeByGuid(EventGraph, ExistingBeginPlayId));
	TestNotNull(TEXT("the planted broken call node was not rolled back (not handler-authored)"),
		FindNodeByGuid(EventGraph, BrokenNodeId));

	bool bCallbackGraphPresent = false;
	for (UEdGraph* Graph : Fixture.Blueprint->FunctionGraphs)
	{
		bCallbackGraphPresent |= (Graph && Graph->GetName() == CallbackName);
	}
	TestFalse(TEXT("the callback function graph was rolled back"), bCallbackGraphPresent);

	// The exec link from BeginPlay.then into the planted node survives the handler's
	// own node/link removal — confirms rollback did not collaterally break exec
	// fan-out it did not create.
	// Re-resolved through FindNodeByGuid + FindFixturePin rather than reusing the
	// ExistingBeginPlay/BrokenExecPin pointers captured before the compiling
	// add_blueprint_timer dispatch above: this file's own constraints forbid reusing
	// a node or pin pointer across a dispatch that may compile, and this one happens
	// to be safe only because that compile skips garbage collection.
	UEdGraphNode* ExistingBeginPlayAfter = FindNodeByGuid(EventGraph, ExistingBeginPlayId);
	UEdGraphNode* BrokenNodeAfter = FindNodeByGuid(EventGraph, BrokenNodeId);
	UEdGraphPin* ExistingThenPinAfter = FindFixturePin(ExistingBeginPlayAfter, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* BrokenExecPinAfter = FindFixturePin(BrokenNodeAfter, {TEXT("execute")}, EGPD_Input);
	if (ExistingThenPinAfter && BrokenExecPinAfter)
	{
		TestTrue(TEXT("the exec link into the planted node survives rollback"),
			ExistingThenPinAfter->LinkedTo.Contains(BrokenExecPinAfter));
	}
	else
	{
		AddError(TEXT("could not re-resolve the BeginPlay then/execute pins after rollback"));
	}

	DestroyFixtureBlueprint(Fixture);
	return true;
}

// =====================================================================================
// Ghost BeginPlay (BUG-2, bullet 4) on the add_blueprint_timer reuse site. Not a
// red/green pair for every assertion below — a red run with EnsureEventNodeEnabled
// stubbed to always return false showed only one of these assertions actually
// depends on the helper:
//
// (a) enabled_ghost is a wire fact this call reports, and it is the one thing that
//     genuinely fails without the helper (proven empirically: the stubbed run
//     returned success with the field absent).
//
// (b) the node ending up enabled, no longer a ghost, and the compiled class
//     carrying its own ReceiveBeginPlay function all hold even with the helper
//     stubbed out, because UEdGraphPin::MakeLinkTo (EdGraphPin.cpp) already calls
//     UEdGraphPin::ConvertConnectedGhostNodesToRealNodes on both ends of a link —
//     it un-ghosts a connected node as a side effect of the timer's own exec-pin
//     wiring, before compile ever runs. These three assertions therefore guard an
//     engine invariant the timer path depends on, not this helper: FEdGraphUtilities
//     ::CloneGraph excludes disabled nodes of a non-transient graph at compile time
//     (the mechanism BUG-2 bullet 4 names), and that is exactly what would bite this
//     test if MakeLinkTo's auto-conversion ever stopped happening.
//
// The other two BUG-2 bullet-4 reuse sites (add_blueprint_event_node,
// override_blueprint_parent_member) hand back an existing node without linking
// anything to it, so they get no such engine-side rescue — EnsureEventNodeEnabled
// is load-bearing there (see UEMCP.BlueprintHandlers.EventNodeGhostSites).
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
		DestroyFixtureBlueprint(Fixture);
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

	// Break the first timer's exec link before reusing BeginPlay again: an output
	// exec pin accepts only one outgoing connection (a second link compiles to
	// "Exec output pin <Unnamed> cannot have more than one connection", confirmed
	// empirically) — a Blueprint constraint unrelated to ghost-enabling. Without
	// this the second dispatch below would fail to compile for a reason that has
	// nothing to do with what this test is proving.
	UEdGraphPin* ThenPin = FindFixturePin(Ghost, {TEXT("then")}, EGPD_Output);
	UEdGraphPin* FirstExecutePin = FindFixturePin(
		FindNodeByGuid(EventGraph, StringFieldOr(Result, TEXT("timer_node_id"))), {TEXT("execute")}, EGPD_Input);
	if (!ThenPin || !FirstExecutePin)
	{
		AddError(TEXT("could not resolve the first timer's exec link to break it before reusing BeginPlay"));
		DestroyFixtureBlueprint(Fixture);
		return false;
	}
	ThenPin->BreakLinkTo(FirstExecutePin);

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

// =====================================================================================
// The other two BUG-2 bullet-4 reuse sites: add_blueprint_event_node's dedup branch
// and override_blueprint_parent_member's reuse branch both hand back an existing
// event node without linking anything to it, so — unlike add_blueprint_timer — they
// get no engine-side rescue from UEdGraphPin::MakeLinkTo's ghost conversion. The
// reused node stays disabled and FEdGraphUtilities::CloneGraph drops it from the
// compiled class at compile time, so EnsureEventNodeEnabled is load-bearing here.
// =====================================================================================

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
		DestroyFixtureBlueprint(Fixture);
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

		const FString NodeId = Result->GetStringField(TEXT("node_id"));
		UEdGraph* EventGraph = Fixture.Blueprint->UbergraphPages.Num() > 0 ? Fixture.Blueprint->UbergraphPages[0] : nullptr;
		UEdGraphNode* Reused = nullptr;
		if (EventGraph)
		{
			for (UEdGraphNode* Node : EventGraph->Nodes)
			{
				if (Node && Node->NodeGuid.ToString() == NodeId) { Reused = Node; break; }
			}
		}
		if (Reused)
		{
			TestTrue(TEXT("add_blueprint_event_node leaves the reused node enabled"), Reused->IsNodeEnabled());
			TestFalse(TEXT("add_blueprint_event_node leaves no ghost behind"), Reused->IsAutomaticallyPlacedGhostNode());
		}
		else
		{
			AddError(TEXT("add_blueprint_event_node returned a node_id that is not in the event graph"));
		}

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

		const FString NodeId = Result->GetStringField(TEXT("node_id"));
		UEdGraph* EventGraph = Fixture.Blueprint->UbergraphPages.Num() > 0 ? Fixture.Blueprint->UbergraphPages[0] : nullptr;
		UEdGraphNode* Reused = nullptr;
		if (EventGraph)
		{
			for (UEdGraphNode* Node : EventGraph->Nodes)
			{
				if (Node && Node->NodeGuid.ToString() == NodeId) { Reused = Node; break; }
			}
		}
		if (Reused)
		{
			TestTrue(TEXT("override_blueprint_parent_member leaves the reused node enabled"), Reused->IsNodeEnabled());
			TestFalse(TEXT("override_blueprint_parent_member leaves no ghost behind"), Reused->IsAutomaticallyPlacedGhostNode());
		}
		else
		{
			AddError(TEXT("override_blueprint_parent_member returned a node_id that is not in the event graph"));
		}
	}
	else
	{
		AddError(FString::Printf(TEXT("override_blueprint_parent_member failed: %s"), *Code));
	}

	FKismetEditorUtilities::CompileBlueprint(Fixture.Blueprint);
	UClass* Generated = Fixture.Blueprint->GeneratedClass;
	TestNotNull(TEXT("after enabling, the compiled class implements ReceiveBeginPlay"),
		Generated ? Generated->FindFunctionByName(TEXT("ReceiveBeginPlay"), EIncludeSuperFlag::ExcludeSuper) : nullptr);
	TestNotNull(TEXT("after enabling, the compiled class implements ReceiveTick"),
		Generated ? Generated->FindFunctionByName(TEXT("ReceiveTick"), EIncludeSuperFlag::ExcludeSuper) : nullptr);

	DestroyFixtureBlueprint(Fixture);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
