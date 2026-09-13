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
