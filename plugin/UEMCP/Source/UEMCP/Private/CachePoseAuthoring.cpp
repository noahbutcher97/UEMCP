// Copyright Noah Butcher. All Rights Reserved.
#include "CachePoseAuthoring.h"
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimBlueprintGeneratedClass.h"
#include "AnimationGraphSchema.h"
#include "AnimGraphNode_SaveCachedPose.h"
#include "AnimGraphNode_UseCachedPose.h"
#include "BlueprintHandlerHelpers.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraph.h"
#include "HandlerCommon.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "MCPResponseBuilder.h"
#include "ScopedTransaction.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	namespace
	{
		const UEdGraph* OutermostPoseGraph(const UEdGraph* Graph)
		{
			const UEdGraph* Layer = Graph;
			for (const UObject* Outer = Graph->GetOuter(); Outer; Outer = Outer->GetOuter())
				if (const auto* ParentGraph = Cast<UEdGraph>(Outer)) Layer = ParentGraph;
			return Layer;
		}

		FString StoredCacheName(const UAnimGraphNode_UseCachedPose* Use)
		{
			const auto* Property = FindFProperty<FStrProperty>(Use->GetClass(), TEXT("NameOfCache"));
			return Property ? Property->GetPropertyValue_InContainer(Use) : FString();
		}
		void BindUse(UAnimGraphNode_UseCachedPose* Use, UAnimGraphNode_SaveCachedPose* Save)
		{
			Use->SaveCachedPoseNode = Save;
			// GetNodeTitle mutates NameOfCache in UE; write the serialized fallback explicitly
			// so persistence does not depend on whether Slate happened to request a title.
			auto* Property = FindFProperty<FStrProperty>(Use->GetClass(), TEXT("NameOfCache"));
			if (Property) Property->SetPropertyValue_InContainer(Use, Save->CacheName);
		}
		bool Guid(const FJsonObject& Params, const TCHAR* Field, FGuid& Id)
		{
			FString Value;
			return Params.TryGetStringField(Field, Value) && FGuid::Parse(Value, Id) && Id.IsValid();
		}

		bool UniqueSaveName(const UAnimGraphNode_SaveCachedPose* Save, const UAnimGraphNode_SaveCachedPose* RenamedSave = nullptr,
			const FString& RenameName = FString())
		{
			const FString Name = Save == RenamedSave ? RenameName : Save->CacheName;
			TArray<UEdGraph*> Graphs;
			FBlueprintEditorUtils::FindBlueprintForGraph(Save->GetGraph())->GetAllGraphs(Graphs);
			for (const UEdGraph* Graph : Graphs) for (const UEdGraphNode* Node : Graph->Nodes)
			{
				const auto* Other = Cast<UAnimGraphNode_SaveCachedPose>(Node);
				if (!Other || Other == Save) continue;
				const FString OtherName = Other == RenamedSave ? RenameName : Other->CacheName;
				if (Name.Equals(OtherName, ESearchCase::IgnoreCase)) return false;
			}
			return true;
		}
	}
	FString CachedPoseRevision(const UEdGraphNode* Node)
	{
		if (const auto* Save = Cast<UAnimGraphNode_SaveCachedPose>(Node)) return TEXT("save|") + Save->CacheName;
		if (const auto* Use = Cast<UAnimGraphNode_UseCachedPose>(Node))
			return TEXT("use|") + StoredCacheName(Use) + TEXT("|") + (Use->SaveCachedPoseNode.IsValid() ? Use->SaveCachedPoseNode->NodeGuid.ToString() : TEXT("broken"));
		return {};
	}
	TArray<TSharedPtr<FJsonValue>> ReadCachedPoseNodes(const UEdGraph* Graph)
	{
		TArray<TSharedPtr<FJsonValue>> Rows;
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			auto* Save = Cast<UAnimGraphNode_SaveCachedPose>(Node);
			auto* Use = Cast<UAnimGraphNode_UseCachedPose>(Node);
			if (!Save && !Use) continue;
			auto Row = MakeShared<FJsonObject>();
			Row->SetStringField(TEXT("node_id"), Node->NodeGuid.ToString());
			Row->SetStringField(TEXT("graph_guid"), Graph->GraphGuid.ToString());
			Row->SetStringField(TEXT("kind"), Save ? TEXT("save") : TEXT("use"));
			Row->SetStringField(TEXT("cache_name"), Save ? Save->CacheName : StoredCacheName(Use));
			auto* Referenced = Save ? Save : Use->SaveCachedPoseNode.Get();
			Row->SetStringField(TEXT("cache_node_id"), Referenced ? Referenced->NodeGuid.ToString() : FString());
			Row->SetBoolField(TEXT("reference_valid"), Referenced && Referenced->GetGraph()->Nodes.Contains(Referenced) &&
				UniqueSaveName(Referenced) &&
				OutermostPoseGraph(Referenced->GetGraph()) == OutermostPoseGraph(Graph) &&
				FBlueprintEditorUtils::FindBlueprintForGraph(Referenced->GetGraph()) == FBlueprintEditorUtils::FindBlueprintForGraph(Graph));
			Rows.Add(MakeShared<FJsonValueObject>(Row));
		}
		return Rows;
	}
	bool ValidateCachedPoseGraph(UEdGraph* Graph, FString& Error, UEdGraphPin* Source, UEdGraphPin* Target,
		const UAnimGraphNode_SaveCachedPose* RenamedSave, const FString& RenameName)
	{
		auto* BP = FBlueprintEditorUtils::FindBlueprintForGraph(Graph);
		if (!Cast<UAnimBlueprint>(BP)) return true;
		if (Source && Target && (!UAnimationGraphSchema::IsPosePin(Source->PinType) || !UAnimationGraphSchema::IsPosePin(Target->PinType))) return true;
		TArray<UEdGraph*> Graphs;
		BP->GetAllGraphs(Graphs);
		TSet<UEdGraphNode*> Nodes;
		for (auto* G : Graphs) for (UEdGraphNode* Node : G->Nodes) if (Node) Nodes.Add(Node);
		TMap<UEdGraphNode*, uint8> Colors;
		TFunction<bool(UEdGraphNode*)> Visit;
		TFunction<bool(UEdGraph*)> VisitSubgraph = [&](UEdGraph* Subgraph)
		{
			// Ordinary transitions expose an optional null CustomTransitionGraph.
			if (!Subgraph) return true;
			if (!Subgraph->GetSchema())
			{
				Error = TEXT("A pose dependency subgraph has no schema");
				return false;
			}
			if (Subgraph->GetSchema()->IsA<UAnimationGraphSchema>())
			{
				for (UEdGraphNode* Node : Subgraph->Nodes)
					if (auto* AnimNode = Cast<UAnimGraphNode_Base>(Node))
						if (AnimNode->IsNodeRootSet() && !Visit(Node)) return false;
			}
			else
			{
				for (UEdGraph* Child : Subgraph->SubGraphs) if (!VisitSubgraph(Child)) return false;
			}
			return true;
		};
		Visit = [&](UEdGraphNode* Node)
		{
			if (Colors.FindRef(Node) == 1) return false;
			if (Colors.FindRef(Node) == 2) return true;
			Colors.Add(Node, 1);
			if (const auto* Save = Cast<UAnimGraphNode_SaveCachedPose>(Node))
			{
				// A unique targeted rename is the repair path for existing duplicate
				// sets. Other ambiguity may remain until subsequent independent repairs.
				if (!RenamedSave && !UniqueSaveName(Save, RenamedSave, RenameName))
				{
					Error = TEXT("Ambiguous cached-pose name across the Animation Blueprint");
					return false;
				}
			}
			for (UEdGraph* Subgraph : Node->GetSubGraphs()) if (!VisitSubgraph(Subgraph)) return false;
			if (auto* Use = Cast<UAnimGraphNode_UseCachedPose>(Node))
			{
				auto* Save = Use->SaveCachedPoseNode.Get();
				if (!Save || !Nodes.Contains(Save) || OutermostPoseGraph(Save->GetGraph()) != OutermostPoseGraph(Use->GetGraph()))
				{
					Error = TEXT("Broken or cross-layer cached-pose reference; inspect cache_nodes before wiring");
					return false;
				}
				if (!Visit(Save)) return false;
			}
			for (auto* Pin : Node->Pins)
			{
				if (!Pin || Pin->Direction != EGPD_Input || !UAnimationGraphSchema::IsPosePin(Pin->PinType)) continue;
				if (Pin == Target)
				{
					if (Source && !Visit(Source->GetOwningNode())) return false;
				}
				else for (auto* Peer : Pin->LinkedTo) if (Peer && !Visit(Peer->GetOwningNode())) return false;
			}
			Colors.Add(Node, 2);
			return true;
		};
		const bool bValid = Target ? Visit(Target->GetOwningNode()) : [&]()
		{
			for (auto* Node : Nodes) if (!Visit(Node)) return false;
			return true;
		}();
		if (!bValid)
		{
			if (Error.IsEmpty()) Error = TEXT("Pose dependency cycle, including cached-pose references, is not allowed");
			return false;
		}
		return true;
	}
	void HandleEditAnimCachedPose(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response)
	{
		FString Path, Op, Expected, Name;
		FGuid GraphId, CacheId;
		if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Path) || !Params->TryGetStringField(TEXT("operation"), Op) ||
			!Guid(*Params, TEXT("graph_guid"), GraphId) || !Params->TryGetStringField(TEXT("expected_revision"), Expected) ||
			(Op != TEXT("create_save") && Op != TEXT("create_use") && Op != TEXT("rename")))
		{
			BuildErrorResponse(Response, TEXT("Expected asset, graph, revision and create_save/create_use/rename operation"), TEXT("INVALID_PARAMS"));
			return;
		}
		auto* BP = LoadObject<UAnimBlueprint>(nullptr, *ToObjectPath(Path));
		auto* Graph = BP ? FindObject<UEdGraph>(BP, TEXT("AnimGraph")) : nullptr;
		if (!Graph || Graph->GetOuter() != BP || Graph->GraphGuid != GraphId || !BP->TargetSkeleton || BP->bIsTemplate ||
			!BP->ParentClass || Cast<UAnimBlueprintGeneratedClass>(BP->ParentClass.Get()) ||
			!Graph->GetSchema()->IsA<UAnimationGraphSchema>() || FBlueprintEditorUtils::IsGraphReadOnly(Graph))
		{
			BuildErrorResponse(Response, TEXT("Expected writable concrete top-level AnimGraph"), TEXT("UNSUPPORTED_GRAPH"));
			return;
		}
		if (!IsWritableAnimPackage(BP->GetOutermost()))
		{
			BuildErrorResponse(Response, TEXT("Animation package is read-only"), TEXT("READ_ONLY_ASSET"));
			return;
		}
		if (!FindFProperty<FStrProperty>(UAnimGraphNode_UseCachedPose::StaticClass(), TEXT("NameOfCache")))
		{
			BuildErrorResponse(Response, TEXT("This engine does not expose the serialized cached-pose reference name"), TEXT("UNSUPPORTED_ENGINE"));
			return;
		}
		if (Expected != GraphTopologyRevision(Graph))
		{
			BuildErrorResponse(Response, TEXT("Read current topology revision"), TEXT("STALE_GRAPH"));
			return;
		}
		UAnimGraphNode_SaveCachedPose* Save = nullptr;
		if (Op != TEXT("create_save"))
		{
			if (Guid(*Params, TEXT("cache_node_id"), CacheId))
				for (UEdGraphNode* Node : Graph->Nodes) if (Node && Node->NodeGuid == CacheId) Save = Cast<UAnimGraphNode_SaveCachedPose>(Node);
			if (!Save) { BuildErrorResponse(Response, TEXT("Save Cached Pose reference is stale or belongs to another graph"), TEXT("STALE_CACHE_REFERENCE")); return; }
		}
		if (Op != TEXT("create_use"))
		{
			if (!Params->TryGetStringField(TEXT("cache_name"), Name) || Name.TrimStartAndEnd().IsEmpty() || Name.Len() >= NAME_SIZE ||
				Name.Contains(TEXT("\n")) || Name.Contains(TEXT("\r")) || Name.Contains(TEXT("|")))
			{
				BuildErrorResponse(Response, TEXT("Expected a nonempty cache name without line breaks or separators"), TEXT("INVALID_PARAMS"));
				return;
			}
			TArray<UEdGraph*> NameGraphs;
			BP->GetAllGraphs(NameGraphs);
			for (UEdGraph* NameGraph : NameGraphs) for (UEdGraphNode* Node : NameGraph->Nodes)
				if (auto* Other = Cast<UAnimGraphNode_SaveCachedPose>(Node))
					if (Other != Save && Other->CacheName.Equals(Name, ESearchCase::IgnoreCase))
					{
						BuildErrorResponse(Response, TEXT("Cache name must be unique across the Animation Blueprint"), TEXT("DUPLICATE_CACHE_NAME"));
						return;
					}
		}
		FString Error;
		if (!ValidateCachedPoseGraph(Graph, Error, nullptr, nullptr, Op == TEXT("rename") ? Save : nullptr, Name))
		{
			BuildErrorResponse(Response, Error, TEXT("INVALID_CACHE_GRAPH"));
			return;
		}
		double X = 0, Y = 0;
		if (Params->HasField(TEXT("node_position")))
		{
			const TArray<TSharedPtr<FJsonValue>>* Position = nullptr;
			if (!Params->TryGetArrayField(TEXT("node_position"), Position) || Position->Num() != 2 ||
				!(*Position)[0]->TryGetNumber(X) || !(*Position)[1]->TryGetNumber(Y) ||
				!FMath::IsWithinInclusive(X, double(MIN_int32), double(MAX_int32)) || !FMath::IsWithinInclusive(Y, double(MIN_int32), double(MAX_int32)) ||
				X != FMath::TruncToDouble(X) || Y != FMath::TruncToDouble(Y))
			{
				BuildErrorResponse(Response, TEXT("Expected integer graph coordinates"), TEXT("INVALID_PARAMS"));
				return;
			}
		}
		if (!CanStartGraphTransaction(Response)) return;
		UEdGraphNode* Changed = Save;
		{
			FScopedTransaction Transaction(NSLOCTEXT("UEMCP", "EditCachedPose", "Edit cached animation pose"));
			BP->Modify();
			Graph->Modify();
			if (Op == TEXT("create_save"))
			{
				FGraphNodeCreator<UAnimGraphNode_SaveCachedPose> Creator(*Graph);
				Save = Creator.CreateNode();
				Save->SetFlags(RF_Transactional);
				Save->CacheName = Name;
				Save->Node.CachePoseName = FName(*Name);
				Save->NodePosX = int32(X);
				Save->NodePosY = int32(Y);
				Creator.Finalize();
				Changed = Save;
			}
			else if (Op == TEXT("create_use"))
			{
				FGraphNodeCreator<UAnimGraphNode_UseCachedPose> Creator(*Graph);
				auto* Use = Creator.CreateNode();
				Use->SetFlags(RF_Transactional);
				BindUse(Use, Save);
				Use->NodePosX = int32(X);
				Use->NodePosY = int32(Y);
				Creator.Finalize();
				Changed = Use;
			}
			else
			{
				Save->Modify();
				Save->OnRenameNode(Name);
				TArray<UEdGraph*> ReferenceGraphs;
				BP->GetAllGraphs(ReferenceGraphs);
				for (auto* ReferenceGraph : ReferenceGraphs) for (UEdGraphNode* Node : ReferenceGraph->Nodes)
					if (auto* Use = Cast<UAnimGraphNode_UseCachedPose>(Node))
						if (Use->SaveCachedPoseNode.Get() == Save) { Use->Modify(); BindUse(Use, Save); }
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
		}
		auto Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("node_id"), Changed->NodeGuid.ToString());
		Result->SetStringField(TEXT("cache_node_id"), Save->NodeGuid.ToString());
		Result->SetStringField(TEXT("cache_name"), Save->CacheName);
		Result->SetStringField(TEXT("topology_revision"), GraphTopologyRevision(Graph));
		Result->SetArrayField(TEXT("cache_nodes"), ReadCachedPoseNodes(Graph));
		TArray<TSharedPtr<FJsonValue>> Pins;
		for (auto* Pin : Changed->Pins) Pins.Add(MakeShared<FJsonValueObject>(PinToJson(Pin)));
		Result->SetArrayField(TEXT("pins"), Pins);
		Result->SetBoolField(TEXT("compiled"), false);
		Result->SetBoolField(TEXT("saved"), false);
		BuildSuccessResponse(Response, Result);
	}
}
