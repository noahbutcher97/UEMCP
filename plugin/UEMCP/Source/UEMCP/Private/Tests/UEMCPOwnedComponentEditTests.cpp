// Copyright Noah Butcher. All Rights Reserved.
// Owned, unsaved component edits through the real registry. External transactions
// below are test-owned: these cases do not promise command-owned undo records.
#if WITH_DEV_AUTOMATION_TESTS
#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/SceneComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/Guid.h"
#include "ScopedTransaction.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/UObjectGlobals.h"
#include "MCPCommandRegistry.h"

namespace UEMCP::OwnedComponentEdit::Tests
{
	// Never Reset the user's transactor (including its redo stack). Strong refs
	// keep both buffers alive, even if handler/editor callbacks collect garbage.
	class FScopedHistory
	{
		TStrongObjectPtr<UTransactor> Previous;
		TStrongObjectPtr<UTransBuffer> Owned;
	public:
		FScopedHistory() : Previous(GEditor->Trans.Get()),
			Owned(NewObject<UTransBuffer>(GetTransientPackage()))
		{
			Owned->Initialize(8 * 1024 * 1024);
			GEditor->Trans = Owned.Get();
		}
		~FScopedHistory()
		{
			Owned->Reset(FText::FromString(TEXT("Owned component test cleanup")));
			GEditor->Trans = Previous.Get();
		}
		UTransBuffer* Get() const { return Owned.Get(); }
	};

	struct FFixture
	{
		TStrongObjectPtr<UPackage> Package;
		TStrongObjectPtr<UBlueprint> Blueprint;
		FString Path;
		UTransBuffer& History;
		explicit FFixture(UTransBuffer& InHistory) : History(InHistory)
		{
			const FString Leaf = TEXT("BP_OwnedEdit_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
			Path = TEXT("/Game/__UEMCPTests/") + Leaf;
			Package.Reset(CreatePackage(*Path));
			Blueprint.Reset(FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Package.Get(),
				FName(*Leaf), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()));
			if (Blueprint.IsValid() && Blueprint->SimpleConstructionScript)
			{
				USCS_Node* Node = Blueprint->SimpleConstructionScript->CreateNode(USceneComponent::StaticClass(), TEXT("OwnedScene"));
				Blueprint->SimpleConstructionScript->AddNode(Node);
				FAssetRegistryModule::AssetCreated(Blueprint.Get());
			}
		}
		~FFixture()
		{
			// Drop only our references before releasing fixture objects. Registry
			// callbacks still run with the isolated transactor installed.
			History.Reset(FText::FromString(TEXT("Owned fixture cleanup")));
			if (Blueprint.IsValid())
			{
				FAssetRegistryModule::AssetDeleted(Blueprint.Get());
				Blueprint->ClearFlags(RF_Public | RF_Standalone);
				Blueprint->MarkAsGarbage();
			}
			if (Package.IsValid())
			{
				Package->SetDirtyFlag(false);
				Package->ClearFlags(RF_Public | RF_Standalone);
				Package->MarkAsGarbage();
			}
		}
		// Re-resolve after edits and undo; never assert a stale template pointer.
		USceneComponent* Scene() const
		{
			if (!Blueprint.IsValid() || !Blueprint->SimpleConstructionScript) return nullptr;
			for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
			{
				if (Node && Node->GetVariableName() == TEXT("OwnedScene")) return Cast<USceneComponent>(Node->ComponentTemplate);
			}
			return nullptr;
		}
		TSharedPtr<FJsonObject> Params(const TCHAR* Property, const TSharedPtr<FJsonValue>& Value) const
		{
			auto Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("blueprint_name"), Path);
			Result->SetStringField(TEXT("component_name"), TEXT("OwnedScene"));
			Result->SetStringField(TEXT("property_name"), Property);
			Result->SetField(TEXT("property_value"), Value);
			return Result;
		}
	};

	static bool Ready(FAutomationTestBase& Test)
	{
		return Test.TestTrue(TEXT("Editor with idle transaction system required"),
			IsInGameThread() && GEditor && GEditor->Trans && !GEditor->Trans->IsActive() && GUndo == nullptr);
	}
	static TSharedPtr<FJsonValue> Vector(double X, double Y, double Z)
	{
		return MakeShared<FJsonValueArray>(TArray<TSharedPtr<FJsonValue>>{
			MakeShared<FJsonValueNumber>(X), MakeShared<FJsonValueNumber>(Y), MakeShared<FJsonValueNumber>(Z)});
	}
	static void Dispatch(FAutomationTestBase& Test, const TSharedPtr<FJsonObject>& Params, const FString& ExpectedCode = FString())
	{
		TSharedPtr<FJsonObject> Response;
		FMCPCommandRegistry::Get().Dispatch(TEXT("set_component_property"), Params, Response);
		FString Status, Code;
		if (Response.IsValid())
		{
			Response->TryGetStringField(TEXT("status"), Status);
			Response->TryGetStringField(TEXT("code"), Code);
		}
		Test.TestEqual(TEXT("Envelope status"), Status, ExpectedCode.IsEmpty() ? FString(TEXT("success")) : FString(TEXT("error")));
		Test.TestEqual(TEXT("Exact error code"), Code, ExpectedCode);
		if (ExpectedCode.IsEmpty())
		{
			const TSharedPtr<FJsonObject>* Result = nullptr;
			bool Success = false;
			FString Component, Property;
			if (Response.IsValid() && Response->TryGetObjectField(TEXT("result"), Result))
			{
				(*Result)->TryGetBoolField(TEXT("success"), Success);
				(*Result)->TryGetStringField(TEXT("component"), Component);
				(*Result)->TryGetStringField(TEXT("property"), Property);
			}
			Test.TestTrue(TEXT("Result reports success"), Success);
			Test.TestEqual(TEXT("Result component"), Component, FString(TEXT("OwnedScene")));
			Test.TestEqual(TEXT("Result property"), Property, Params->GetStringField(TEXT("property_name")));
		}
	}
	static bool Location(FAutomationTestBase& Test, const FFixture& Fixture, const FVector& Expected)
	{
		USceneComponent* Scene = Fixture.Scene();
		return Test.TestNotNull(TEXT("OwnedScene remains resolvable"), Scene)
			&& Test.TestEqual(TEXT("Live template location"), Scene->GetRelativeLocation(), Expected);
	}
}
using namespace UEMCP::OwnedComponentEdit::Tests;

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FOwnedEditValues, "UEMCP.OwnedComponentEdit.LiveValuesAndErrors",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FOwnedEditValues::RunTest(const FString& Parameters)
{
	if (!Ready(*this)) return false;
	FScopedHistory History; // Include construction and registry teardown callbacks.
	FFixture Fixture(*History.Get());
	if (!TestNotNull(TEXT("Owned scene fixture"), Fixture.Scene())) return false;
	Dispatch(*this, Fixture.Params(TEXT("RelativeLocation"), Vector(12, -23, 34)));
	Location(*this, Fixture, FVector(12, -23, 34));
	Dispatch(*this, Fixture.Params(TEXT("RelativeScale3D"), MakeShared<FJsonValueNumber>(2.5)));
	if (USceneComponent* Scene = Fixture.Scene()) TestEqual(TEXT("Scalar broadcasts to vector"), Scene->GetRelativeScale3D(), FVector(2.5));
	else AddError(TEXT("OwnedScene disappeared after scalar edit"));
	Dispatch(*this, Fixture.Params(TEXT("bVisible"), MakeShared<FJsonValueBoolean>(false)));
	if (USceneComponent* Scene = Fixture.Scene()) TestFalse(TEXT("Boolean property changed on live template"), Scene->IsVisible());
	else AddError(TEXT("OwnedScene disappeared after boolean edit"));
	for (int32 Case = 0; Case < 6; ++Case)
	{
		auto Params = Fixture.Params(TEXT("RelativeLocation"), Vector(90, 91, 92));
		FString Code;
		switch (Case)
		{
		case 0: Params->RemoveField(TEXT("property_value")); Code = TEXT("MISSING_PARAMS"); break;
		case 1: Params->SetStringField(TEXT("component_name"), TEXT("MissingScene")); Code = TEXT("COMPONENT_NOT_FOUND"); break;
		case 2: Params->SetStringField(TEXT("property_name"), TEXT("MissingProperty")); Code = TEXT("PROPERTY_NOT_FOUND"); break;
		case 3: Params->SetArrayField(TEXT("property_value"), { MakeShared<FJsonValueNumber>(1), MakeShared<FJsonValueNumber>(2) }); Code = TEXT("PROPERTY_SET_FAILED"); break;
		case 4: Params->SetStringField(TEXT("property_value"), TEXT("invalid vector")); Code = TEXT("PROPERTY_SET_FAILED"); break;
		default: Params->RemoveField(TEXT("component_name")); Code = TEXT("MISSING_PARAMS"); break;
		}
		Dispatch(*this, Params, Code);
		Location(*this, Fixture, FVector(12, -23, 34));
		if (USceneComponent* Scene = Fixture.Scene())
		{
			TestEqual(TEXT("Rejected edit preserves scale"), Scene->GetRelativeScale3D(), FVector(2.5));
			TestFalse(TEXT("Rejected edit preserves visibility"), Scene->IsVisible());
		}
	}
	TestEqual(TEXT("Commands do not create owned transactions"), History.Get()->GetQueueLength(), 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FOwnedEditUndo, "UEMCP.OwnedComponentEdit.ExternalTransactionUndoRedo",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FOwnedEditUndo::RunTest(const FString& Parameters)
{
	if (!Ready(*this)) return false;
	FScopedHistory History;
	FFixture Fixture(*History.Get());
	if (!TestNotNull(TEXT("Owned scene fixture"), Fixture.Scene())) return false;
	const FVector Before = Fixture.Scene()->GetRelativeLocation();
	{
		FScopedTransaction External(FText::FromString(TEXT("Owned external component edit")));
		Dispatch(*this, Fixture.Params(TEXT("RelativeLocation"), Vector(11, 22, 33)));
	}
	Location(*this, Fixture, FVector(11, 22, 33));
	TestEqual(TEXT("One external undo record"), History.Get()->GetQueueLength(), 1);
	TestTrue(TEXT("External transaction undo succeeds"), History.Get()->Undo());
	Location(*this, Fixture, Before);
	TestTrue(TEXT("External transaction redo succeeds"), History.Get()->Redo());
	Location(*this, Fixture, FVector(11, 22, 33));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FOwnedEditRejectedUndo, "UEMCP.OwnedComponentEdit.RejectedEditPreservesPriorUndo",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FOwnedEditRejectedUndo::RunTest(const FString& Parameters)
{
	if (!Ready(*this)) return false;
	FScopedHistory History;
	FFixture Fixture(*History.Get());
	if (!TestNotNull(TEXT("Owned scene fixture"), Fixture.Scene())) return false;
	const FVector Before = Fixture.Scene()->GetRelativeLocation();
	{
		FScopedTransaction Prior(FText::FromString(TEXT("Owned prior valid edit")));
		Dispatch(*this, Fixture.Params(TEXT("RelativeLocation"), Vector(44, 55, 66)));
	}
	// No external transaction around the rejection: Modify alone must not
	// replace the valid record. Rejections inside transactions are unqualified.
	Dispatch(*this, Fixture.Params(TEXT("RelativeLocation"), MakeShared<FJsonValueString>(TEXT("invalid vector"))), TEXT("PROPERTY_SET_FAILED"));
	Location(*this, Fixture, FVector(44, 55, 66));
	TestEqual(TEXT("Rejected edit adds no undo record"), History.Get()->GetQueueLength(), 1);
	TestTrue(TEXT("Prior valid edit remains undoable"), History.Get()->Undo());
	Location(*this, Fixture, Before);
	TestTrue(TEXT("Prior valid edit remains redoable"), History.Get()->Redo());
	Location(*this, Fixture, FVector(44, 55, 66));
	return true;
}
#endif
