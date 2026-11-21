// Copyright Noah Butcher. All Rights Reserved.
#if WITH_DEV_AUTOMATION_TESTS
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimSequence.h"
#include "Animation/Skeleton.h"
#include "AnimGraphNode_SequencePlayer.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "BlueprintActionDatabase.h"
#include "BlueprintHandlerHelpers.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "EdGraphSchema_K2.h"
#include "Factories/AnimBlueprintFactory.h"
#include "GameFramework/Pawn.h"
#include "InputAction.h"
#include "K2Node_EnhancedInputAction.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "MCPCommandRegistry.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "UObject/StrongObjectPtr.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPGraphActionPlacement, "UEMCP.GraphActions.AssetPlacement",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPGraphActionPlacement::RunTest(const FString&)
{
	if (!TestTrue(TEXT("Idle editor transaction"), GEditor && GEditor->Trans && !GEditor->Trans->IsActive() && !GUndo)) return false;
	const FString Root = TEXT("/Game/__UEMCPTests/Action_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	TArray<UObject*> Assets;
	ON_SCOPE_EXIT
	{
		for (UObject* Asset : Assets)
		{
			FAssetRegistryModule::AssetDeleted(Asset);
			Asset->GetOutermost()->SetDirtyFlag(false);
			Asset->ClearFlags(RF_Public | RF_Standalone);
		}
	};
	auto* Pawn = FKismetEditorUtilities::CreateBlueprint(APawn::StaticClass(), CreatePackage(*(Root + TEXT("/BP_Pawn"))),
		TEXT("BP_Pawn"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
	if (!TestNotNull(TEXT("Pawn"), Pawn) || !TestTrue(TEXT("Event graph"), Pawn->UbergraphPages.Num() == 1)) return false;
	Assets.Add(Pawn);
	FAssetRegistryModule::AssetCreated(Pawn);
	auto* EventGraph = Pawn->UbergraphPages[0].Get();
	auto& Database = FBlueprintActionDatabase::Get();
	auto CreateAction = [&](const TCHAR* Folder)
	{
		auto* Action = NewObject<UInputAction>(CreatePackage(*(Root + Folder + TEXT("/Interact"))), TEXT("Interact"), RF_Public | RF_Standalone | RF_Transactional);
		Assets.Add(Action);
		FAssetRegistryModule::AssetCreated(Action);
		// The targeted refresh exercises the warm registration used in the duplicate reproduction.
		Database.RefreshAssetActions(Action);
		return Action;
	};
	auto* Left = CreateAction(TEXT("/Left"));
	auto* Right = CreateAction(TEXT("/Right"));
	Right->ValueType = EInputActionValueType::Axis2D;
	TStrongObjectPtr<UTransactor> Previous(GEditor->Trans.Get());
	TStrongObjectPtr<UTransBuffer> History(NewObject<UTransBuffer>());
	History->Initialize(8 * 1024 * 1024);
	TGuardValue<decltype(GEditor->Trans)> Isolate(GEditor->Trans, History.Get());

	using FJson = TSharedPtr<FJsonObject>;
	auto Invoke = [&](const TCHAR* Command, const FJson& Args, const TCHAR* ExpectedError = nullptr) -> FJson
	{
		FJson Response;
		UEMCP::FMCPCommandRegistry::Get().Dispatch(Command, Args, Response);
		FString Status, Code, Message;
		if (Response)
		{
			Response->TryGetStringField(TEXT("status"), Status);
			Response->TryGetStringField(TEXT("code"), Code);
			Response->TryGetStringField(TEXT("error"), Message);
		}
		if (ExpectedError)
		{
			TestEqual(FString::Printf(TEXT("%s refusal: %s"), Command, *Message), Code, FString(ExpectedError));
			return nullptr;
		}
		if (!TestEqual(FString::Printf(TEXT("%s: %s %s"), Command, *Code, *Message), Status, FString(TEXT("success")))) return nullptr;
		return Response->GetObjectField(TEXT("result"));
	};
	auto ArgsFor = [](UBlueprint* Blueprint, UEdGraph* Graph)
	{
		auto Args = MakeShared<FJsonObject>();
		Args->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		Args->SetStringField(TEXT("graph_guid"), Graph->GraphGuid.ToString());
		Args->SetStringField(TEXT("attachment_id"), TEXT("owned-automation"));
		Args->SetStringField(TEXT("expected_project_file"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
		return Args;
	};
	auto Find = [&](UBlueprint* Blueprint, UEdGraph* Graph, const FString& Path)
	{
		auto Args = ArgsFor(Blueprint, Graph);
		Args->SetStringField(TEXT("source_asset_path"), Path);
		return Invoke(TEXT("find_graph_actions"), Args);
	};
	auto Id = [&](const FJson& Result) -> FString
	{
		if (!Result) return {};
		const auto& Rows = Result->GetArrayField(TEXT("actions"));
		if (!TestEqual(TEXT("One exact registry choice"), Rows.Num(), 1)) return {};
		return Rows[0]->AsObject()->GetStringField(TEXT("action_id"));
	};
	auto Edit = [&](UBlueprint* Blueprint, UEdGraph* Graph, const FString& IdValue)
	{
		auto Args = ArgsFor(Blueprint, Graph);
		Args->SetStringField(TEXT("expected_revision"), UEMCP::GraphTopologyRevision(Graph));
		Args->SetStringField(TEXT("action_id"), IdValue);
		Args->SetArrayField(TEXT("node_position"), {MakeShared<FJsonValueNumber>(-120), MakeShared<FJsonValueNumber>(170)});
		return Args;
	};
	const FString Start = UEMCP::GraphTopologyRevision(EventGraph);
	const int32 Before = EventGraph->Nodes.Num();
	auto Query = ArgsFor(Pawn, EventGraph);
	Query->SetStringField(TEXT("query"), Root);
	auto Matches = Invoke(TEXT("find_graph_actions"), Query);
	if (!Matches || !TestEqual(TEXT("Two same-named sources"), Matches->GetArrayField(TEXT("actions")).Num(), 2)) return false;
	const FString LeftId = Id(Find(Pawn, EventGraph, Left->GetPathName()));
	const FString RightId = Id(Find(Pawn, EventGraph, Right->GetPathName()));
	if (!TestTrue(TEXT("Distinct exact selections"), !LeftId.IsEmpty() && !RightId.IsEmpty() && LeftId != RightId)) return false;
	auto Request = Edit(Pawn, EventGraph, LeftId);
	auto Created = Invoke(TEXT("place_graph_action"), Request);
	if (!Created || !TestTrue(TEXT("Input event created"), Created->GetBoolField(TEXT("created")))) return false;
	Invoke(TEXT("place_graph_action"), Request, TEXT("STALE_GRAPH_REVISION"));
	auto Reused = Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, LeftId));
	if (!Reused) return false;
	TestTrue(TEXT("Warm retry reused existing event"), Reused->GetBoolField(TEXT("reused")));
	TestEqual(TEXT("Same event GUID on warm retry"), Reused->GetStringField(TEXT("node_guid")), Created->GetStringField(TEXT("node_guid")));
	TestEqual(TEXT("Exactly one event added"), EventGraph->Nodes.Num(), Before + 1);
	auto MatchesLeft = Find(Pawn, EventGraph, Left->GetPathName());
	if (!MatchesLeft) return false;
	TestEqual(TEXT("Exactly one independently discoverable event"), MatchesLeft->GetArrayField(TEXT("placed_nodes")).Num(), 1);
	TestTrue(TEXT("Undo original placement after no-op retry"), History->Undo());
	TestEqual(TEXT("Original graph after Undo"), UEMCP::GraphTopologyRevision(EventGraph), Start);
	TestTrue(TEXT("Redo event placement"), History->Redo());
	if (!Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, RightId))) return false;
	TArray<UK2Node_EnhancedInputAction*> Events;
	EventGraph->GetNodesOfClass(Events);
	if (!TestEqual(TEXT("Two event nodes"), Events.Num(), 2)) return false;
	TestTrue(TEXT("Independent exact references"), (Events[0]->InputAction == Left && Events[1]->InputAction == Right) ||
		(Events[0]->InputAction == Right && Events[1]->InputAction == Left));
	auto* VectorEvent = Events[0]->InputAction == Right ? Events[0] : Events[1];
	auto* ValuePin = VectorEvent->FindPin(TEXT("ActionValue"), EGPD_Output);
	if (!TestNotNull(TEXT("Vector input value pin"), ValuePin)) return false;
	const auto OriginalType = ValuePin->PinType;
	ValuePin->PinType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
	Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, RightId), TEXT("CONFLICTING_INPUT_BINDING"));
	TestEqual(TEXT("Malformed existing type left untouched"), ValuePin->PinType.PinCategory, UEdGraphSchema_K2::PC_Boolean);
	ValuePin->PinType = OriginalType;
	ValuePin->bOrphanedPin = true;
	Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, RightId), TEXT("CONFLICTING_INPUT_BINDING"));
	TestTrue(TEXT("Orphaned existing pin left untouched"), bool(ValuePin->bOrphanedPin));
	ValuePin->bOrphanedPin = false;
	auto* StartedPin = VectorEvent->FindPin(TEXT("Started"), EGPD_Output);
	if (!TestNotNull(TEXT("Started event pin"), StartedPin)) return false;
	const FGuid StartedId = StartedPin->PinId;
	StartedPin->PinId = ValuePin->PinId;
	Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, RightId), TEXT("CONFLICTING_INPUT_BINDING"));
	StartedPin->PinId = StartedId;
	TestEqual(TEXT("Refused malformed binding preserves membership"), EventGraph->Nodes.Num(), Before + 2);
	auto WrongAttachment = Edit(Pawn, EventGraph, LeftId);
	WrongAttachment->SetStringField(TEXT("attachment_id"), TEXT("different-attachment"));
	Invoke(TEXT("place_graph_action"), WrongAttachment, TEXT("STALE_GRAPH_ACTION"));
	auto WrongEditor = Edit(Pawn, EventGraph, LeftId);
	WrongEditor->SetStringField(TEXT("expected_project_file"), TEXT("/Unrelated/Test.uproject"));
	Invoke(TEXT("place_graph_action"), WrongEditor, TEXT("EDITOR_IDENTITY_MISMATCH"));
	const FString OriginalPath = Left->GetPathName();
	auto* OriginalPackage = Left->GetOutermost();
	const FString PriorReplacement = Id(Find(Pawn, EventGraph, OriginalPath));
	FAssetRegistryModule::AssetDeleted(Left);
	if (!TestTrue(TEXT("Retire prior object while its node still holds it"),
		Left->Rename(TEXT("OldInteract"), nullptr, REN_DontCreateRedirectors | REN_NonTransactional))) return false;
	auto* Replacement = NewObject<UInputAction>(OriginalPackage, TEXT("Interact"), RF_Public | RF_Standalone | RF_Transactional);
	Assets.Add(Replacement);
	FAssetRegistryModule::AssetCreated(Replacement);
	Database.RefreshAssetActions(Replacement);
	TestEqual(TEXT("Replacement has identical canonical path"), OriginalPath, Replacement->GetPathName());
	Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, PriorReplacement), TEXT("STALE_GRAPH_ACTION"));
	const FString FreshId = Id(Find(Pawn, EventGraph, OriginalPath));
	auto Fresh = Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, FreshId));
	if (!Fresh || !TestTrue(TEXT("Fresh selection creates binding to replacement"), Fresh->GetBoolField(TEXT("created")))) return false;
	auto* Duplicate = NewObject<UK2Node_EnhancedInputAction>(EventGraph);
	Duplicate->InputAction = Replacement;
	Duplicate->CreateNewGuid();
	Duplicate->AllocateDefaultPins();
	EventGraph->AddNode(Duplicate);
	const int32 ConflictCount = EventGraph->Nodes.Num();
	Invoke(TEXT("place_graph_action"), Edit(Pawn, EventGraph, FreshId), TEXT("CONFLICTING_INPUT_BINDING"));
	TestEqual(TEXT("Conflicting events leave membership intact"), EventGraph->Nodes.Num(), ConflictCount);

	auto* Clip = LoadObject<UAnimSequence>(nullptr, TEXT("/Engine/Tutorial/SubEditors/TutorialAssets/Character/Tutorial_Walk_Fwd.Tutorial_Walk_Fwd"));
	if (!TestNotNull(TEXT("Owned engine clip"), Clip)) return false;
	auto* Factory = NewObject<UAnimBlueprintFactory>();
	Factory->TargetSkeleton = Clip->GetSkeleton();
	auto* Anim = Cast<UAnimBlueprint>(Factory->FactoryCreateNew(UAnimBlueprint::StaticClass(),
		CreatePackage(*(Root + TEXT("/ABP_Player"))), TEXT("ABP_Player"), RF_Public | RF_Standalone | RF_Transactional, nullptr, GWarn));
	if (!TestNotNull(TEXT("Animation Blueprint"), Anim)) return false;
	Assets.Add(Anim);
	FAssetRegistryModule::AssetCreated(Anim);
	auto* AnimGraph = FindObject<UEdGraph>(Anim, TEXT("AnimGraph"));
	if (!TestNotNull(TEXT("Top-level animation graph"), AnimGraph)) return false;
	Database.RefreshAssetActions(Clip);
	const FString ClipId = Id(Find(Anim, AnimGraph, Clip->GetPathName()));
	if (ClipId.IsEmpty()) return false;
	const auto FirstPlayer = Invoke(TEXT("place_graph_action"), Edit(Anim, AnimGraph, ClipId));
	const auto NextPlayer = Invoke(TEXT("place_graph_action"), Edit(Anim, AnimGraph, ClipId));
	if (!FirstPlayer || !NextPlayer) return false;
	TestNotEqual(TEXT("Intentional repeated sequence produces another node"), FirstPlayer->GetStringField(TEXT("node_guid")), NextPlayer->GetStringField(TEXT("node_guid")));
	TArray<UAnimGraphNode_SequencePlayer*> Players;
	AnimGraph->GetNodesOfClass(Players);
	if (!TestEqual(TEXT("Two distinct players"), Players.Num(), 2)) return false;
	TestTrue(TEXT("Both bound to the selected clip"), Players[0]->Node.GetSequence() == Clip && Players[1]->Node.GetSequence() == Clip);
	const FString EmptyId = Id(Find(Anim, AnimGraph, FString()));
	auto Empty = Invoke(TEXT("place_graph_action"), Edit(Anim, AnimGraph, EmptyId));
	if (!Empty) return false;
	TestEqual(TEXT("Empty player remains unbound"), Empty->GetStringField(TEXT("source_asset_path")), FString());
	Factory->TargetSkeleton = LoadObject<USkeleton>(nullptr, TEXT("/Engine/EngineMeshes/SkeletalCube_Skeleton.SkeletalCube_Skeleton"));
	auto* ChangedClip = DuplicateObject<UAnimSequence>(Clip, CreatePackage(*(Root + TEXT("/ChangingClip"))), TEXT("ChangingClip"));
	Assets.Add(ChangedClip);
	FAssetRegistryModule::AssetCreated(ChangedClip);
	Database.RefreshAssetActions(ChangedClip);
	const FString ChangedId = Id(Find(Anim, AnimGraph, ChangedClip->GetPathName()));
	if (ChangedId.IsEmpty() || !TestTrue(TEXT("Undo to retain a pending Redo"), History->Undo())) return false;
	ChangedClip->SetSkeleton(Factory->TargetSkeleton);
	const FString BeforeRefusal = UEMCP::GraphTopologyRevision(AnimGraph);
	Invoke(TEXT("place_graph_action"), Edit(Anim, AnimGraph, ChangedId), TEXT("STALE_GRAPH_ACTION"));
	TestEqual(TEXT("Stale live skeleton leaves graph unchanged"), UEMCP::GraphTopologyRevision(AnimGraph), BeforeRefusal);
	TestTrue(TEXT("Live incompatibility preserves the user's pending Redo"), History->Redo());
	auto* Other = Cast<UAnimBlueprint>(Factory->FactoryCreateNew(UAnimBlueprint::StaticClass(),
		CreatePackage(*(Root + TEXT("/ABP_Other"))), TEXT("ABP_Other"), RF_Public | RF_Standalone | RF_Transactional, nullptr, GWarn));
	if (!TestNotNull(TEXT("Incompatible animation Blueprint"), Other)) return false;
	Assets.Add(Other);
	FAssetRegistryModule::AssetCreated(Other);
	auto* OtherGraph = FindObject<UEdGraph>(Other, TEXT("AnimGraph"));
	if (!TestNotNull(TEXT("Incompatible graph"), OtherGraph)) return false;
	const auto Revision = UEMCP::GraphTopologyRevision(OtherGraph);
	auto Filtered = Find(Other, OtherGraph, Clip->GetPathName());
	if (!Filtered) return false;
	TestEqual(TEXT("Incompatible clip filtered"), Filtered->GetArrayField(TEXT("actions")).Num(), 0);
	Invoke(TEXT("place_graph_action"), Edit(Other, OtherGraph, ClipId), TEXT("STALE_GRAPH_ACTION"));
	TestEqual(TEXT("Foreign selection preserves incompatible graph"), UEMCP::GraphTopologyRevision(OtherGraph), Revision);
	return true;
}
#endif
