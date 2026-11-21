// Copyright Noah Butcher. All Rights Reserved.
#include "GraphActionAuthoring.h"

#include "Animation/AnimBlueprint.h"
#include "Animation/AnimSequence.h"
#include "Animation/Skeleton.h"
#include "AnimationGraphSchema.h"
#include "AnimGraphNode_SequencePlayer.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "BlueprintActionDatabase.h"
#include "BlueprintActionFilter.h"
#include "BlueprintAssetNodeSpawner.h"
#include "BlueprintHandlerHelpers.h"
#include "BlueprintNodeSpawner.h"
#include "Editor.h"
#include "Editor/Transactor.h"
#include "EdGraph/EdGraph.h"
#include "EdGraphSchema_K2.h"
#include "GameFramework/Pawn.h"
#include "HandlerCommon.h"
#include "InputAction.h"
#include "K2Node_EnhancedInputAction.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/Paths.h"
#include "ScopedTransaction.h"

namespace UEMCP::GraphActionAuthoring
{
using FJson = TSharedPtr<FJsonObject>;
using FValues = TArray<TSharedPtr<FJsonValue>>;

struct FTarget
{
	UBlueprint* Blueprint = nullptr;
	UEdGraph* Graph = nullptr;
	FString Attachment;
	bool bInput = false;

	FJson Describe() const
	{
		auto Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
		Out->SetStringField(TEXT("graph_name"), Graph->GetName());
		Out->SetStringField(TEXT("graph_guid"), Graph->GraphGuid.ToString());
		Out->SetStringField(TEXT("topology_revision"), GraphTopologyRevision(Graph));
		return Out;
	}

	bool Resolve(const FJson& Params, FJson& Response, bool bPlacing)
	{
		FString Project, Path, GraphName, GraphId;
		if (!Params || !Params->TryGetStringField(TEXT("expected_project_file"), Project) || Project.IsEmpty() ||
			!Params->TryGetStringField(TEXT("attachment_id"), Attachment) || Attachment.IsEmpty() ||
			!FPaths::IsSamePath(Project, FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath())))
		{
			BuildErrorResponse(Response, TEXT("Attach to this editor's exact project and rediscover the action"), TEXT("EDITOR_IDENTITY_MISMATCH"));
			return false;
		}
		Params->TryGetStringField(TEXT("asset_path"), Path);
		Params->TryGetStringField(TEXT("graph_name"), GraphName);
		Params->TryGetStringField(TEXT("graph_guid"), GraphId);
		FGuid Guid;
		if (Path.IsEmpty() || (GraphId.IsEmpty() && (GraphName.IsEmpty() || bPlacing)) ||
			(!GraphId.IsEmpty() && (!FGuid::Parse(GraphId, Guid) || !Guid.IsValid())))
		{
			BuildErrorResponse(Response, TEXT("Supply the Blueprint and a graph name or valid graph GUID. Placement requires the GUID."), TEXT("INVALID_PARAMS"));
			return false;
		}
		Blueprint = ResolveBlueprint(Path);
		if (!Blueprint)
		{
			BuildErrorResponse(Response, TEXT("Blueprint could not be loaded"), TEXT("BLUEPRINT_NOT_FOUND"));
			return false;
		}
		TArray<UEdGraph*> Graphs;
		Blueprint->GetAllGraphs(Graphs);
		FValues Choices;
		for (UEdGraph* Candidate : Graphs)
		{
			if (!Candidate || (!GraphName.IsEmpty() && Candidate->GetName() != GraphName) ||
				(Guid.IsValid() && Candidate->GraphGuid != Guid)) continue;
			Graph = Candidate;
			auto Choice = MakeShared<FJsonObject>();
			Choice->SetStringField(TEXT("graph_name"), Graph->GetName());
			Choice->SetStringField(TEXT("graph_guid"), Graph->GraphGuid.ToString());
			Choices.Add(MakeShared<FJsonValueObject>(Choice));
		}
		if (Choices.Num() != 1)
		{
			auto Detail = MakeShared<FJsonObject>();
			Detail->SetArrayField(TEXT("graphs"), Choices);
			BuildErrorResponse(Response, TEXT("Resolve a single graph on the named Blueprint"), Choices.IsEmpty() ? TEXT("GRAPH_NOT_FOUND") : TEXT("AMBIGUOUS_GRAPH"), Detail);
			return false;
		}
		bInput = Blueprint->BlueprintType == BPTYPE_Normal && Blueprint->ParentClass && Blueprint->ParentClass->IsChildOf(APawn::StaticClass()) &&
			Blueprint->UbergraphPages.Contains(Graph) && Graph->Schema == UEdGraphSchema_K2::StaticClass();
		const auto* Anim = Cast<UAnimBlueprint>(Blueprint);
		const bool bAnimation = Anim && Anim->BlueprintType == BPTYPE_Normal && !Anim->bIsTemplate && Anim->TargetSkeleton && Graph->GetFName() == TEXT("AnimGraph") &&
			Blueprint->FunctionGraphs.Contains(Graph) && Graph->GetSchema() && Graph->GetSchema()->IsA<UAnimationGraphSchema>();
		if (Graph->GetOuter() != Blueprint || (!bInput && !bAnimation) || FBlueprintEditorUtils::IsGraphReadOnly(Graph) ||
			!IsWritableAnimPackage(Blueprint->GetOutermost()))
		{
			BuildErrorResponse(Response, TEXT("Choose a writable pawn Event Graph or the top-level AnimGraph"), TEXT("UNSUPPORTED_GRAPH_TARGET"));
			return false;
		}
		return true;
	}

	UClass* NodeClass() const { return bInput ? UK2Node_EnhancedInputAction::StaticClass() : UAnimGraphNode_SequencePlayer::StaticClass(); }
	const TCHAR* Family() const { return bInput ? TEXT("enhanced_input_event") : TEXT("sequence_player"); }
};

struct FAction
{
	UObject* Owner;
	UBlueprintNodeSpawner* Spawner;
	FString Path;
	FString Label;
};

static TArray<FAction> Collect(const FTarget& Target, const FString* ExactPath, const FString& Query, int32 Limit, bool& bIncomplete)
{
	FBlueprintActionFilter Filter;
	Filter.Context.Blueprints.Add(Target.Blueprint);
	Filter.Context.Graphs.Add(Target.Graph);
	TArray<FAction> Actions;
	int32 Evaluated = 0;
	bIncomplete = false;
	const auto& Registry = FBlueprintActionDatabase::Get().GetAllActions();
	auto Visit = [&](UObject* Owner, const auto& Spawners)
	{
		for (UBlueprintNodeSpawner* Spawner : Spawners)
		{
			if (!Spawner || Spawner->NodeClass != Target.NodeClass()) continue;
			FString Path;
			if (Target.bInput)
			{
				if (!Owner->IsA<UInputAction>()) continue;
				Path = Owner->GetPathName();
			}
			else
			{
				const auto* AssetSpawner = Cast<UBlueprintAssetNodeSpawner>(Spawner);
				if (!AssetSpawner) continue;
				const FAssetData& Asset = AssetSpawner->GetAssetData();
				if (Asset.IsValid())
				{
					if (!Asset.IsInstanceOf(UAnimSequence::StaticClass())) continue;
					Path = Asset.GetSoftObjectPath().ToString();
				}
			}
			if (ExactPath && *ExactPath != Path) continue;
			if (!ExactPath && (++Evaluated > 512 || Actions.Num() >= Limit))
			{
				bIncomplete = true;
				return;
			}
			FBlueprintActionInfo Info(Owner, Spawner);
			if (Filter.IsFiltered(Info)) continue;
			const FString Label = Spawner->GetUiSpec(Filter.Context, {}).MenuName.ToString();
			if (Query.IsEmpty() || Label.Contains(Query) || Path.Contains(Query))
				Actions.Add({Owner, Spawner, Path, Label});
		}
	};
	// A loaded asset can own the spawner. Unloaded and empty sequence choices can
	// be registered on the node class. Inspect both keys for an exact lookup.
	if (ExactPath)
	{
		if (UObject* Loaded = ExactPath->IsEmpty() ? nullptr : FSoftObjectPath(*ExactPath).ResolveObject())
			if (const auto* Entries = Registry.Find(FObjectKey(Loaded))) Visit(Loaded, *Entries);
		if (const auto* Entries = Registry.Find(FObjectKey(Target.NodeClass()))) Visit(Target.NodeClass(), *Entries);
	}
	else
	{
		int32 Scanned = 0;
		for (const auto& Entry : Registry)
		{
			if (++Scanned > 32768) { bIncomplete = true; break; }
			auto* Owner = Entry.Key.ResolveObjectPtr();
			if (Owner && (Owner == Target.NodeClass() || (Target.bInput ? Owner->IsA<UInputAction>() : Owner->IsA<UAnimSequence>())))
				Visit(Owner, Entry.Value);
			if (bIncomplete) break;
		}
	}
	Actions.Sort([](const FAction& A, const FAction& B) { return A.Path < B.Path; });
	return Actions;
}

struct FSelection
{
	FString Id, Attachment, BlueprintPath, Path;
	TWeakObjectPtr<UEdGraph> Graph;
	TWeakObjectPtr<UObject> Owner, LoadedSource;
	TWeakObjectPtr<UBlueprintNodeSpawner> Spawner;
};

static TArray<FSelection> Selections;
static FDelegateHandle Added, Removed, Renamed, Updated;
static void Forget(const FString& Path)
{
	Selections.RemoveAll([&](const FSelection& S) { return S.Path == Path; });
}

static void WatchRegistry(IAssetRegistry& Registry)
{
	if (Removed.IsValid()) return;
	const auto ForgetAsset = [](const FAssetData& Asset) { Forget(Asset.GetSoftObjectPath().ToString()); };
	Added = Registry.OnAssetAdded().AddLambda(ForgetAsset);
	Removed = Registry.OnAssetRemoved().AddLambda(ForgetAsset);
	Updated = Registry.OnAssetUpdatedOnDisk().AddLambda(ForgetAsset);
	Renamed = Registry.OnAssetRenamed().AddLambda([](const FAssetData& Asset, const FString& OldPath)
	{
		Forget(OldPath);
		Forget(Asset.GetSoftObjectPath().ToString());
	});
}

void Shutdown()
{
	if (!Removed.IsValid()) return;
	if (auto* Module = FModuleManager::GetModulePtr<FAssetRegistryModule>("AssetRegistry"))
	{
		auto& Registry = Module->Get();
		Registry.OnAssetAdded().Remove(Added);
		Registry.OnAssetRemoved().Remove(Removed);
		Registry.OnAssetUpdatedOnDisk().Remove(Updated);
		Registry.OnAssetRenamed().Remove(Renamed);
	}
	Added.Reset(); Removed.Reset(); Renamed.Reset(); Updated.Reset();
	Selections.Reset();
}

static const UObject* BoundAsset(const UEdGraphNode* Node)
{
	if (const auto* Input = Cast<UK2Node_EnhancedInputAction>(Node)) return Input->InputAction;
	if (const auto* Player = Cast<UAnimGraphNode_SequencePlayer>(Node)) return Player->Node.GetSequence();
	return nullptr;
}

static FJson DescribeNode(UEdGraphNode* Node)
{
	auto Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("node_guid"), Node->NodeGuid.ToString());
	Out->SetStringField(TEXT("node_id"), Node->NodeGuid.ToString());
	Out->SetStringField(TEXT("node_class"), Node->GetClass()->GetPathName());
	Out->SetStringField(TEXT("compile_mode"), LexToString(Node->GetDesiredEnabledState()));
	Out->SetStringField(TEXT("graph_guid"), Node->GetGraph()->GraphGuid.ToString());
	Out->SetStringField(TEXT("graph_name"), Node->GetGraph()->GetName());
	const UObject* Asset = BoundAsset(Node);
	Out->SetStringField(TEXT("source_asset_path"), Asset ? Asset->GetPathName() : FString());
	Out->SetArrayField(TEXT("node_position"), {MakeShared<FJsonValueNumber>(Node->NodePosX), MakeShared<FJsonValueNumber>(Node->NodePosY)});
	FValues Pins;
	for (const UEdGraphPin* Pin : Node->Pins)
		if (Pin) Pins.Add(MakeShared<FJsonValueObject>(PinToJson(Pin)));
	Out->SetArrayField(TEXT("pins"), Pins);
	return Out;
}

static const UEdGraphPin* UniqueOutput(const UEdGraphNode* Node, FName Name)
{
	const UEdGraphPin* Found = nullptr;
	for (const UEdGraphPin* Pin : Node->Pins)
	{
		if (!Pin || Pin->Direction != EGPD_Output || Pin->PinName != Name) continue;
		if (Found || Pin->bOrphanedPin || !Pin->PinId.IsValid()) return nullptr;
		Found = Pin;
	}
	if (Found && Node->Pins.ContainsByPredicate([&](const UEdGraphPin* Other)
		{ return Other && Other != Found && Other->PinId == Found->PinId; })) return nullptr;
	return Found;
}

static bool ValidNode(const FTarget& T, UEdGraphNode* Node, const FString& Path)
{
	if (!Node || Node->GetClass() != T.NodeClass() || !Node->NodeGuid.IsValid() ||
		Node->GetGraph() != T.Graph || !T.Graph->Nodes.Contains(Node) ||
		Node->GetDesiredEnabledState() != ENodeEnabledState::Enabled) return false;
	const UObject* Source = BoundAsset(Node);
	if ((Source ? Source->GetPathName() : FString()) != Path) return false;
	if (T.bInput)
	{
		for (const TCHAR* Name : {TEXT("Triggered"), TEXT("Started"), TEXT("Ongoing"), TEXT("Canceled"), TEXT("Completed")})
		{
			const auto* Exec = UniqueOutput(Node, Name);
			if (!Exec || Exec->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec) return false;
		}
		const auto* Value = UniqueOutput(Node, TEXT("ActionValue"));
		const auto* Input = Cast<UInputAction>(Source);
		if (!Input || !Value) return false;
		const auto& Type = Value->PinType;
		switch (Input->ValueType)
		{
		case EInputActionValueType::Boolean: return Type.PinCategory == UEdGraphSchema_K2::PC_Boolean;
		case EInputActionValueType::Axis1D: return Type.PinCategory == UEdGraphSchema_K2::PC_Real && Type.PinSubCategory == UEdGraphSchema_K2::PC_Double;
		case EInputActionValueType::Axis2D: return Type.PinCategory == UEdGraphSchema_K2::PC_Struct && Type.PinSubCategoryObject == TBaseStructure<FVector2D>::Get();
		case EInputActionValueType::Axis3D: return Type.PinCategory == UEdGraphSchema_K2::PC_Struct && Type.PinSubCategoryObject == TBaseStructure<FVector>::Get();
		default: return false;
		}
	}
	const auto* Pose = UniqueOutput(Node, TEXT("Pose"));
	const auto* Clip = Cast<UAnimSequence>(Source);
	return Pose && UAnimationGraphSchema::IsPosePin(Pose->PinType) && (!Source ||
		(Clip && CastChecked<UAnimBlueprint>(T.Blueprint)->TargetSkeleton->IsCompatibleForEditor(Clip->GetSkeleton())));
}

static FString Remember(const FTarget& Target, const FAction& Action)
{
	FSelection S;
	S.Id = FGuid::NewGuid().ToString();
	S.Graph = Target.Graph;
	S.BlueprintPath = Target.Blueprint->GetPathName();
	S.Attachment = Target.Attachment;
	S.Owner = Action.Owner;
	S.Spawner = Action.Spawner;
	S.Path = Action.Path;
	if (!S.Path.IsEmpty()) S.LoadedSource = FSoftObjectPath(S.Path).ResolveObject();
	// Keep lookup state bounded without retaining packages or editor objects.
	if (Selections.Num() >= 1024) Selections.RemoveAt(0, 128);
	Selections.Add(S);
	return S.Id;
}

static void Find(const FJson& Params, FJson& Response)
{
	FTarget Target;
	if (!Target.Resolve(Params, Response, false)) return;
	FString Source, Query;
	const bool bExact = Params->TryGetStringField(TEXT("source_asset_path"), Source);
	if (bExact && !Source.IsEmpty()) Source = ToObjectPath(Source);
	Params->TryGetStringField(TEXT("query"), Query);
	double Limit = 25;
	if (Params->HasField(TEXT("limit")) && (!Params->TryGetNumberField(TEXT("limit"), Limit) ||
		!FMath::IsWithinInclusive(Limit, 1.0, 100.0) || FMath::TruncToDouble(Limit) != Limit))
	{
		BuildErrorResponse(Response, TEXT("Use an integer limit from 1 to 100"), TEXT("INVALID_PARAMS"));
		return;
	}
	auto& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
	WatchRegistry(Registry);
	bool bIncomplete;
	auto Actions = Collect(Target, bExact ? &Source : nullptr, Query, int32(Limit) + 1, bIncomplete);
	auto Out = Target.Describe();
	Out->SetBoolField(TEXT("registry_loading"), Registry.IsLoadingAssets());
	Out->SetBoolField(TEXT("scan_incomplete"), bIncomplete);
	Out->SetBoolField(TEXT("truncated"), bIncomplete || Actions.Num() > Limit);
	FValues Rows;
	for (int32 I = 0; I < FMath::Min(Actions.Num(), int32(Limit)); ++I)
	{
		const FAction& Action = Actions[I];
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("action_id"), Remember(Target, Action));
		Row->SetStringField(TEXT("family"), Target.Family());
		Row->SetStringField(TEXT("display_name"), Action.Label);
		Row->SetStringField(TEXT("source_asset_path"), Action.Path);
		Row->SetStringField(TEXT("variant"), Action.Path.IsEmpty() ? TEXT("empty") : TEXT("asset"));
		Rows.Add(MakeShared<FJsonValueObject>(Row));
	}
	Out->SetArrayField(TEXT("actions"), Rows);
	FValues Placed;
	if (bExact)
	{
		for (UEdGraphNode* Node : Target.Graph->Nodes)
		{
			if (!Node || Node->GetClass() != Target.NodeClass()) continue;
			const auto* Bound = BoundAsset(Node);
			if ((Bound ? Bound->GetPathName() : FString()) != Source) continue;
			if (Node->GetGraph() != Target.Graph)
			{
				BuildErrorResponse(Response, TEXT("A matching node has inconsistent graph ownership"), TEXT("INCONSISTENT_GRAPH_MEMBERSHIP"), Out);
				return;
			}
			Placed.Add(MakeShared<FJsonValueObject>(DescribeNode(Node)));
		}
	}
	Out->SetArrayField(TEXT("placed_nodes"), Placed);
	BuildSuccessResponse(Response, Out);
}

static void Place(const FJson& Params, FJson& Response)
{
	FTarget Target;
	if (!Target.Resolve(Params, Response, true)) return;
	FString Revision, Id;
	const TArray<TSharedPtr<FJsonValue>>* XY = nullptr;
	if (!Params->TryGetStringField(TEXT("expected_revision"), Revision) || Revision.IsEmpty() ||
		!Params->TryGetStringField(TEXT("action_id"), Id) || Id.IsEmpty() ||
		!Params->TryGetArrayField(TEXT("node_position"), XY) || XY->Num() != 2)
	{
		BuildErrorResponse(Response, TEXT("Supply the selection, current revision and two graph coordinates"), TEXT("INVALID_PARAMS"));
		return;
	}
	double Coordinates[2];
	for (int32 I = 0; I < 2; ++I)
	{
		if ((*XY)[I]->Type != EJson::Number || !(*XY)[I]->TryGetNumber(Coordinates[I]) ||
			!FMath::IsWithinInclusive(Coordinates[I], double(MIN_int32), double(MAX_int32)) ||
			FMath::TruncToDouble(Coordinates[I]) != Coordinates[I])
		{
			BuildErrorResponse(Response, TEXT("Use two integer graph coordinates"), TEXT("INVALID_PARAMS"));
			return;
		}
	}
	const FJson Before = Target.Describe();
	const FSelection* Found = Selections.FindByPredicate([&](const FSelection& S) { return S.Id == Id; });
	const bool bCurrentTarget = Found && Found->Graph.Get() == Target.Graph && Found->BlueprintPath == Target.Blueprint->GetPathName() && Found->Attachment == Target.Attachment;
	if (bCurrentTarget) Before->SetStringField(TEXT("source_asset_path"), Found->Path);
	if (Revision != Before->GetStringField(TEXT("topology_revision")))
	{
		BuildErrorResponse(Response, TEXT("Refresh the target graph before placing"), TEXT("STALE_GRAPH_REVISION"), Before);
		return;
	}
	if (!bCurrentTarget)
	{
		BuildErrorResponse(Response, TEXT("Discover a new action on the current attachment and graph"), TEXT("STALE_GRAPH_ACTION"), Before);
		return;
	}
	const FSelection Selection = *Found;
	bool bIncomplete;
	auto Actions = Collect(Target, &Selection.Path, FString(), 2, bIncomplete);
	if (Actions.Num() != 1 || Actions[0].Owner != Selection.Owner.Get() || Actions[0].Spawner != Selection.Spawner.Get() ||
		Selection.LoadedSource.IsStale() || (Selection.LoadedSource.IsValid() && Selection.LoadedSource.Get() != FSoftObjectPath(Selection.Path).ResolveObject()))
	{
		BuildErrorResponse(Response, TEXT("Source or registry choice changed; rediscover the exact asset"), TEXT("STALE_GRAPH_ACTION"), Before);
		return;
	}
	if (!Target.bInput && !Selection.Path.IsEmpty())
	{
		// A registry template can carry an earlier skeleton tag. Resolve only the
		// selected clip and verify its live skeleton before opening an Undo step.
		auto* Clip = Cast<UAnimSequence>(FSoftObjectPath(Selection.Path).TryLoad());
		if (!Clip || Clip->GetPathName() != Selection.Path || !Clip->GetSkeleton() ||
			!CastChecked<UAnimBlueprint>(Target.Blueprint)->TargetSkeleton->IsCompatibleForEditor(Clip->GetSkeleton()))
		{
			BuildErrorResponse(Response, TEXT("The selected sequence or its current skeleton is incompatible"), TEXT("STALE_GRAPH_ACTION"), Before);
			return;
		}
		Actions = Collect(Target, &Selection.Path, FString(), 2, bIncomplete);
		if (Actions.Num() != 1 || Selection.LoadedSource.IsStale() || !Selections.ContainsByPredicate([&](const FSelection& S) { return S.Id == Id; }) ||
			(Selection.LoadedSource.IsValid() && Selection.LoadedSource.Get() != Clip))
		{
			BuildErrorResponse(Response, TEXT("Asset loading changed the selected registration; rediscover the exact asset"), TEXT("STALE_GRAPH_ACTION"), Before);
			return;
		}
		if (GraphTopologyRevision(Target.Graph) != Revision)
		{
			auto Current = Target.Describe();
			Current->SetStringField(TEXT("source_asset_path"), Selection.Path);
			BuildErrorResponse(Response, TEXT("The target graph changed while resolving the sequence"), TEXT("STALE_GRAPH_REVISION"), Current);
			return;
		}
	}
	UEdGraphNode* ResultNode = nullptr;
	if (Target.bInput)
	{
		TArray<UEdGraph*> Graphs;
		Target.Blueprint->GetAllGraphs(Graphs);
		FValues Matches;
		for (UEdGraph* Graph : Graphs)
		{
			if (!Graph) continue;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node || Node->GetClass() != Target.NodeClass() || BoundAsset(Node) != Actions[0].Owner) continue;
				if (Node->GetGraph() != Graph)
				{
					BuildErrorResponse(Response, TEXT("A matching input event has inconsistent graph ownership"), TEXT("INCONSISTENT_GRAPH_MEMBERSHIP"), Before);
					return;
				}
				ResultNode = Node;
				Matches.Add(MakeShared<FJsonValueObject>(DescribeNode(Node)));
			}
		}
		if (Matches.Num() > 1 || (ResultNode && !ValidNode(Target, ResultNode, Selection.Path)))
		{
			Before->SetArrayField(TEXT("matching_nodes"), Matches);
			const bool bRestrictedMode = Matches.Num() == 1 && ResultNode->GetDesiredEnabledState() != ENodeEnabledState::Enabled;
			BuildErrorResponse(Response, bRestrictedMode
				? TEXT("The existing event has a restricted compile mode. Inspect matching_nodes and enable that event in the Blueprint editor if it should run in all builds.")
				: TEXT("Inspect the existing event bindings before placing this action"), TEXT("CONFLICTING_INPUT_BINDING"), Before);
			return;
		}
	}
	const bool bCreate = !ResultNode;
	if (bCreate)
	{
		if (!CanStartGraphTransaction(Response)) return;
		auto* Package = Target.Blueprint->GetOutermost();
		const bool bWasDirty = Package->IsDirty();
		const auto PreviousNodes = Target.Graph->Nodes;
		FGuid TransactionId;
		bool bValid = false;
		bool bCancelled = false;
		{
			FScopedTransaction Transaction(NSLOCTEXT("UEMCP", "PlaceGraphAction", "Place Blueprint Graph Action"));
			if (!Transaction.IsOutstanding() || !GUndo)
			{
				BuildErrorResponse(Response, TEXT("The editor could not start an Undo transaction"), TEXT("TRANSACTION_UNAVAILABLE"));
				return;
			}
			TransactionId = GUndo->GetContext().TransactionId;
			Target.Blueprint->Modify();
			Target.Graph->Modify();
			ResultNode = Actions[0].Spawner->Invoke(Target.Graph, {}, FVector2D(Coordinates[0], Coordinates[1]));
			bValid = ValidNode(Target, ResultNode, Selection.Path) && !PreviousNodes.Contains(ResultNode) &&
				Target.Graph->Nodes.Num() == PreviousNodes.Num() + 1;
			if (bValid)
			{
				FBlueprintEditorUtils::MarkBlueprintAsModified(Target.Blueprint);
				Target.Graph->NotifyGraphChanged();
			}
			else
			{
				const auto AfterNodes = Target.Graph->Nodes;
				for (UEdGraphNode* AddedNode : AfterNodes)
				{
					if (AddedNode && AddedNode->GetGraph() == Target.Graph && !PreviousNodes.Contains(AddedNode))
						AddedNode->DestroyNode();
				}
				if (Target.Graph->Nodes == PreviousNodes && GraphTopologyRevision(Target.Graph) == Revision)
				{
					Transaction.Cancel();
					bCancelled = true;
				}
			}
		}
		if (!bValid)
		{
			const bool bUndone = !bCancelled && TransactionId.IsValid() && GEditor->Trans->GetUndoContext().TransactionId == TransactionId &&
				GEditor->UndoTransaction(false);
			const bool bRestored = (bCancelled || bUndone) && Target.Graph->Nodes == PreviousNodes && GraphTopologyRevision(Target.Graph) == Revision;
			if (bRestored) Package->SetDirtyFlag(bWasDirty);
			auto Detail = Target.Describe();
			Detail->SetBoolField(TEXT("rollback_verified"), bRestored);
			Detail->SetBoolField(TEXT("redo_history_preserved"), bCancelled);
			BuildErrorResponse(Response, TEXT("Unreal returned an unexpected node or graph change; inspect the reported rollback"), TEXT("PLACEMENT_POSTCONDITION_FAILED"), Detail);
			return;
		}
	}
	auto Out = DescribeNode(ResultNode);
	Out->SetStringField(TEXT("asset_path"), Target.Blueprint->GetPathName());
	Out->SetStringField(TEXT("topology_revision"), GraphTopologyRevision(Target.Graph));
	Out->SetBoolField(TEXT("created"), bCreate);
	Out->SetBoolField(TEXT("reused"), !bCreate);
	FValues Dirty;
	if (Target.Blueprint->GetOutermost()->IsDirty()) Dirty.Add(MakeShared<FJsonValueString>(Target.Blueprint->GetOutermost()->GetName()));
	Out->SetArrayField(TEXT("dirty_packages"), Dirty);
	BuildSuccessResponse(Response, Out);
}

void Register(FMCPCommandRegistry& Registry)
{
	Registry.Register(TEXT("find_graph_actions"), &Find);
	Registry.Register(TEXT("place_graph_action"), &Place);
}
}
