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

#endif // WITH_DEV_AUTOMATION_TESTS
