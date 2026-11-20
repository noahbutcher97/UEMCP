// Copyright Noah Butcher. All Rights Reserved.
#include "AnimSlotInsertion.h"
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimBlueprintGeneratedClass.h"
#include "Animation/Skeleton.h"
#include "AnimationGraphSchema.h"
#include "AnimGraphNode_Slot.h"
#include "AnimGraphNode_LinkedInputPose.h"
#include "AnimGraphNode_LinkedAnimGraphBase.h"
#include "AnimGraphNode_LocalToComponentSpace.h"
#include "AnimGraphNode_ComponentToLocalSpace.h"
#include "Editor.h"
#include "BlueprintHandlerHelpers.h"
#include "CompileDiagnosticHandler.h"
#include "EdGraph/EdGraph.h"
#include "HandlerCommon.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "MCPResponseBuilder.h"
#include "ScopedTransaction.h"

namespace UEMCP
{
	namespace
	{
		bool ReadSlotGuid(const FJsonObject& Params, const TCHAR* Key, FGuid& Guid)
		{
			FString Text;
			return Params.TryGetStringField(Key, Text) && FGuid::Parse(Text, Guid) && Guid.IsValid();
		}

		UEdGraphPin* FindLocalPoseEndpoint(UEdGraph* Graph, const FGuid& NodeId, const FGuid& PinId, EEdGraphPinDirection Direction)
		{
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node || Node->NodeGuid != NodeId) continue;
				if (!Node->IsA<UAnimGraphNode_Base>() || Node->IsA<UAnimGraphNode_LinkedInputPose>() ||
					Node->IsA<UAnimGraphNode_LinkedAnimGraphBase>() || Node->IsA<UAnimGraphNode_LocalToComponentSpace>() ||
					Node->IsA<UAnimGraphNode_ComponentToLocalSpace>()) return nullptr;
				for (UEdGraphPin* Pin : Node->Pins)
				{
					if (Pin && Pin->PinId == PinId && Pin->Direction == Direction && !Pin->bOrphanedPin && !Pin->bHidden &&
						UAnimationGraphSchema::IsLocalSpacePosePin(Pin->PinType) && !HasConnectionBinding(Pin)) return Pin;
				}
			}
			return nullptr;
		}

		bool AllGraphSlotsRegistered(UAnimBlueprint* Blueprint)
		{
			TArray<UEdGraph*> Graphs;
			Blueprint->GetAllGraphs(Graphs);
			for (const auto* Graph : Graphs)
			{
				TArray<UAnimGraphNode_Slot*> Slots;
				Graph->GetNodesOfClass(Slots);
				for (const auto* Slot : Slots)
					if (!Blueprint->TargetSkeleton->ContainsSlotName(Slot->Node.SlotName)) return false;
			}
			return true;
		}

		bool SolePoseEdge(UEdGraphPin* A, UEdGraphPin* B)
		{
			return A && B && A->LinkedTo.Num() == 1 && A->LinkedTo[0] == B && B->LinkedTo.Num() == 1 && B->LinkedTo[0] == A;
		}

		TSharedPtr<FJsonValue> SlotEdge(const FString& From, const FString& To)
		{
			auto Edge = MakeShared<FJsonObject>();
			Edge->SetStringField(TEXT("source_pin_id"), From);
			Edge->SetStringField(TEXT("target_pin_id"), To);
			return MakeShared<FJsonValueObject>(Edge);
		}
	}

	void InsertAnimSlot(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response,
		TFunctionRef<bool(const UEdGraphSchema*, UEdGraphPin*, UEdGraphPin*)> Connect)
	{
		FGuid GraphId, FromNode, FromPin, ToNode, ToPin;
		FString Path, SlotText, Revision, Mode;
		bool bCompile = false;
		if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Path) || Path.IsEmpty() ||
			!Params->TryGetStringField(TEXT("slot_name"), SlotText) || SlotText.IsEmpty() || SlotText.Len() >= NAME_SIZE ||
			!Params->TryGetStringField(TEXT("expected_revision"), Revision) ||
			!Params->TryGetStringField(TEXT("mode"), Mode) || (Mode != TEXT("preview") && Mode != TEXT("apply")) ||
			(Params->HasField(TEXT("compile")) && (!Params->HasTypedField<EJson::Boolean>(TEXT("compile")) || !Params->TryGetBoolField(TEXT("compile"), bCompile))) ||
			!ReadSlotGuid(*Params, TEXT("graph_guid"), GraphId) || !ReadSlotGuid(*Params, TEXT("source_node_id"), FromNode) ||
			!ReadSlotGuid(*Params, TEXT("source_pin_id"), FromPin) || !ReadSlotGuid(*Params, TEXT("target_node_id"), ToNode) ||
			!ReadSlotGuid(*Params, TEXT("target_pin_id"), ToPin))
		{
			BuildErrorResponse(Response, TEXT("Expected valid graph and edge IDs, revision, existing slot and preview/apply mode"), TEXT("INVALID_PARAMS"));
			return;
		}
		auto* BP = LoadObject<UAnimBlueprint>(nullptr, *ToObjectPath(Path));
		auto* Graph = BP ? FindObject<UEdGraph>(BP, TEXT("AnimGraph")) : nullptr;
		if (!Graph || Graph->GetOuter() != BP || Graph->GraphGuid != GraphId || !Graph->GetSchema()->IsA<UAnimationGraphSchema>() ||
			!BP->TargetSkeleton || BP->bIsTemplate || !BP->ParentClass || Cast<UAnimBlueprintGeneratedClass>(BP->ParentClass.Get()) ||
			FBlueprintEditorUtils::IsGraphReadOnly(Graph))
		{
			BuildErrorResponse(Response, TEXT("Expected the writable top-level graph of a concrete AnimBlueprint"), TEXT("UNSUPPORTED_GRAPH"));
			return;
		}
		auto* Package = BP->GetOutermost();
		if (!IsWritableAnimPackage(Package))
		{
			BuildErrorResponse(Response, TEXT("Animation Blueprint package is read-only"), TEXT("READ_ONLY_ASSET"));
			return;
		}
		const auto Before = GraphTopologyRevision(Graph);
		if (Before != Revision)
		{
			BuildErrorResponse(Response, TEXT("Read current graph topology and slot state"), TEXT("STALE_GRAPH"));
			return;
		}
		const FName SlotName(*SlotText, FNAME_Find);
		if (SlotName.IsNone() || !BP->TargetSkeleton->ContainsSlotName(SlotName))
		{
			BuildErrorResponse(Response, TEXT("Slot must already exist on the target Skeleton"), TEXT("UNKNOWN_SLOT"));
			return;
		}
		// Compiling any existing unregistered Slot would register it on the Skeleton.
		if (bCompile && !AllGraphSlotsRegistered(BP))
		{
			BuildErrorResponse(Response, TEXT("Compilation would register another Skeleton slot"), TEXT("UNREGISTERED_SLOT"));
			return;
		}
		auto* A = FindLocalPoseEndpoint(Graph, FromNode, FromPin, EGPD_Output);
		auto* B = FindLocalPoseEndpoint(Graph, ToNode, ToPin, EGPD_Input);
		if (!SolePoseEdge(A, B) || A->GetOwningNode() == B->GetOwningNode())
		{
			BuildErrorResponse(Response, TEXT("Expected the sole reciprocal, unbound local-space pose edge"), TEXT("INVALID_POSE_EDGE"));
			return;
		}
		double X = (double(A->GetOwningNode()->NodePosX) + B->GetOwningNode()->NodePosX) / 2;
		double Y = (double(A->GetOwningNode()->NodePosY) + B->GetOwningNode()->NodePosY) / 2;
		if (Params->HasField(TEXT("node_position")))
		{
			const TArray<TSharedPtr<FJsonValue>>* P = nullptr;
			if (!Params->TryGetArrayField(TEXT("node_position"), P) || P->Num() != 2 || !(*P)[0]->TryGetNumber(X) || !(*P)[1]->TryGetNumber(Y) ||
				!FMath::IsWithinInclusive(X, double(MIN_int32), double(MAX_int32)) || !FMath::IsWithinInclusive(Y, double(MIN_int32), double(MAX_int32)) ||
				X != FMath::TruncToDouble(X) || Y != FMath::TruncToDouble(Y))
			{
				BuildErrorResponse(Response, TEXT("Expected two integer graph coordinates"), TEXT("INVALID_PARAMS"));
				return;
			}
		}
		auto Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("asset_path"), Package->GetName());
		Result->SetStringField(TEXT("graph_guid"), GraphId.ToString());
		Result->SetStringField(TEXT("slot_name"), SlotName.ToString());
		Result->SetStringField(TEXT("before_revision"), Before);
		Result->SetArrayField(TEXT("removed_edges"), {SlotEdge(FromPin.ToString(), ToPin.ToString())});
		Result->SetBoolField(TEXT("saved"), false);
		Result->SetBoolField(TEXT("applied"), Mode == TEXT("apply"));
		Result->SetBoolField(TEXT("compiled"), false);
		if (Mode == TEXT("preview"))
		{
			Result->SetArrayField(TEXT("planned_edges"), {SlotEdge(FromPin.ToString(), TEXT("$slot.Source")), SlotEdge(TEXT("$slot.Pose"), ToPin.ToString())});
			Result->SetStringField(TEXT("topology_revision"), Before);
			BuildSuccessResponse(Response, Result);
			return;
		}
		{
			if (!CanStartGraphTransaction(Response)) return;
			const bool bWasDirty = Package->IsDirty();
			const auto PriorStatus = BP->Status;
			FScopedTransaction Tx(NSLOCTEXT("UEMCP", "InsertAnimSlot", "Insert montage Slot"));
			BP->Modify();
			Graph->Modify();
			A->GetOwningNode()->Modify();
			B->GetOwningNode()->Modify();
			FGraphNodeCreator<UAnimGraphNode_Slot> Creator(*Graph);
			auto* Slot = Creator.CreateNode(false);
			Slot->Node.SlotName = SlotName;
			Slot->NodePosX = int32(X);
			Slot->NodePosY = int32(Y);
			Creator.Finalize();
			auto* Input = Slot->FindPin(TEXT("Source"), EGPD_Input);
			auto* Output = Slot->FindPin(TEXT("Pose"), EGPD_Output);
			A->BreakLinkTo(B);
			if (!Input || !Output || !Connect(Graph->GetSchema(), A, Input) || !Connect(Graph->GetSchema(), Output, B) ||
				!SolePoseEdge(A, Input) || !SolePoseEdge(Output, B))
			{
				Slot->BreakAllNodeLinks();
				Graph->RemoveNode(Slot);
				A->MakeLinkTo(B);
				BP->Status = PriorStatus;
				Tx.Cancel();
				Graph->NotifyGraphChanged();
				Package->SetDirtyFlag(bWasDirty);
				BuildErrorResponse(Response, TEXT("Slot connection failed; original edge restored"), TEXT("SLOT_CONNECT_FAILED"));
				return;
			}
			Result->SetStringField(TEXT("node_id"), Slot->NodeGuid.ToString());
			Result->SetArrayField(TEXT("added_edges"), {SlotEdge(FromPin.ToString(), Input->PinId.ToString()), SlotEdge(Output->PinId.ToString(), ToPin.ToString())});
			FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
			Graph->NotifyGraphChanged();
		}
		if (bCompile)
		{
			auto Diagnostics = BuildBlueprintCompileDiagnosticResult(BP, Path, /*bSkipSave=*/true);
			const bool bCompiledOk = Diagnostics->GetBoolField(TEXT("compiled_ok"));
			Result->SetObjectField(TEXT("compilation"), Diagnostics);
			Result->SetBoolField(TEXT("compiled"), bCompiledOk);
			Result->SetStringField(TEXT("outcome"), bCompiledOk ? TEXT("applied_and_compiled") : TEXT("applied_compile_failed"));
		}
		else Result->SetStringField(TEXT("outcome"), TEXT("applied_compile_deferred"));
		Result->SetStringField(TEXT("topology_revision"), GraphTopologyRevision(Graph));
		BuildSuccessResponse(Response, Result);
	}

	void HandleInsertAnimSlot(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response)
	{
		InsertAnimSlot(Params, Response, [](const UEdGraphSchema* Schema, UEdGraphPin* A, UEdGraphPin* B)
		{
			return Schema->CanCreateConnection(A, B).Response == CONNECT_RESPONSE_MAKE && Schema->TryCreateConnection(A, B);
		});
	}
}
