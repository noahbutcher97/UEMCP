#include "AnimBlendProbe.h"
#include "AnimGraphNode_SaveCachedPose.h"
#include "AnimGraphNode_UseCachedPose.h"
#include "BlueprintEditorSettings.h"

#include "Animation/AnimBlueprint.h"
#include "Animation/AnimInstance.h"
#include "Animation/AnimMontage.h"
#include "Animation/AnimNode_StateMachine.h"
#include "AnimGraphNode_Slot.h"
#include "Animation/AnimSequence.h"
#include "Animation/AnimData/IAnimationDataController.h"
#include "Animation/Skeleton.h"
#include "AnimGraphNode_Root.h"
#include "AnimGraphNode_TwoWayBlend.h"
#include "K2Node_CallFunction.h"
#include "K2Node_VariableSet.h"
#include "K2Node_FormatText.h"
#include "K2Node_Variable.h"
#include "Kismet/KismetSystemLibrary.h"
#include "EdGraphSchema_K2.h"
#include "AnimGraphNode_SequencePlayer.h"
#include "Components/SkeletalMeshComponent.h"
#include "Editor.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Editor/Transactor.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphSchema.h"
#include "Engine/SkeletalMesh.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonSerializer.h"

bool UAnimBlendProbe::Seed(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh, UAnimSequence* A, UAnimSequence* B, bool bSeedMontageSlot)
{
	if (!Blueprint || !Mesh || !A || !B || Mesh->GetRefSkeleton().GetNum() < 2) return false;
	auto* Graph = FindObject<UEdGraph>(Blueprint, TEXT("AnimGraph"));
	if (!Graph || !Mesh->GetPathName().StartsWith(TEXT("/Game/InteractiveBlend/")) ||
		!Blueprint->TargetSkeleton || !Blueprint->TargetSkeleton->GetPathName().StartsWith(TEXT("/Game/InteractiveBlend/"))) return false;
	if (bSeedMontageSlot) Blueprint->TargetSkeleton->RegisterSlotNode(TEXT("FixtureMontage"));
	Mesh->SetSkeleton(Blueprint->TargetSkeleton);
	Blueprint->TargetSkeleton->SetPreviewMesh(Mesh);
	Blueprint->SetPreviewMesh(Mesh);
	TArray<UAnimGraphNode_Root*> Roots;
	Graph->GetNodesOfClass(Roots);
	if (Roots.Num() != 1) return false;
	const FName Bone = Mesh->GetRefSkeleton().GetBoneName(1);
	const int32 Index = Mesh->GetSkeleton()->GetReferenceSkeleton().FindBoneIndex(Bone);
	if (Index < 1) return false;
	Mesh->GetSkeleton()->SetBoneTranslationRetargetingMode(Index, EBoneTranslationRetargetingMode::Animation);
	for (UAnimSequence* Sequence : { A, B })
	{
		if (Sequence->GetSkeleton() != Blueprint->TargetSkeleton) return false;
		auto& Data = Sequence->GetController();
		Data.OpenBracket(FText::FromString(TEXT("Seed constant test pose")), false);
		ON_SCOPE_EXIT { Data.CloseBracket(false); };
		Data.SetFrameRate(FFrameRate(30, 1), false);
		Data.SetNumberOfFrames(FFrameNumber(1), false);
		const FVector3f T(Sequence == A ? 10.f : 50.f, 3.f, 7.f);
		if (!Data.AddBoneCurve(Bone, false) || !Data.SetBoneTrackKeys(Bone, { T, T },
			{ FQuat4f::Identity, FQuat4f::Identity }, { FVector3f::OneVector, FVector3f::OneVector }, false)) return false;
		Data.NotifyPopulated();
		FGraphNodeCreator<UAnimGraphNode_SequencePlayer> Creator(*Graph);
		auto* Player = Creator.CreateNode();
		Player->Node.SetSequence(Sequence);
		Player->NodePosX = -600;
		Player->NodePosY = Sequence == A ? 0 : 240;
		Creator.Finalize();
		if (Sequence == A && !Graph->GetSchema()->TryCreateConnection(Player->FindPinChecked(TEXT("Pose")),
			Roots[0]->FindPinChecked(TEXT("Result")))) return false;
	}
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	return true;
}

FString UAnimBlendProbe::Sample(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh, float Input)
{
	if (!Blueprint || !Blueprint->GeneratedClass || !Mesh) return {};
	auto* Component = NewObject<USkeletalMeshComponent>(GetTransientPackage());
	Component->SetSkeletalMesh(Mesh);
	Component->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	Component->SetUpdateAnimationInEditor(true);
	Component->RegisterComponentWithWorld(GEditor->GetEditorWorldContext().World());
	ON_SCOPE_EXIT { Component->DestroyComponent(); };
	Component->SetAnimInstanceClass(Blueprint->GeneratedClass);
	auto* Instance = Component->GetAnimInstance();
	if (!Instance || Instance->GetClass() != Blueprint->GeneratedClass) return {};
	auto* Drive = FindFProperty<FFloatProperty>(Instance->GetClass(), TEXT("Drive"));
	auto* Alpha = FindFProperty<FFloatProperty>(Instance->GetClass(), TEXT("LeanAlpha"));
	if (!Drive || !Alpha) return {};
	Drive->SetPropertyValue_InContainer(Instance, Input);
	for (int32 I = 0; I < 3; ++I)
	{
		Component->TickAnimation(1.f / 30.f, false);
		Component->RefreshBoneTransforms();
	}
	const auto Pose = Component->GetBoneSpaceTransforms();
	if (Pose.Num() < 2) return {};
	const FVector Position = Pose[1].GetTranslation();
	auto Row = MakeShared<FJsonObject>();
	Row->SetStringField(TEXT("bone"), Mesh->GetRefSkeleton().GetBoneName(1).ToString());
	Row->SetStringField(TEXT("space"), TEXT("parent-local"));
	Row->SetStringField(TEXT("class"), Instance->GetClass()->GetPathName());
	Row->SetStringField(TEXT("instance"), Instance->GetPathName());
	Row->SetNumberField(TEXT("ticks"), 3);
	Row->SetNumberField(TEXT("dt"), 1.0 / 30.0);
	Row->SetNumberField(TEXT("drive"), Drive->GetPropertyValue_InContainer(Instance));
	Row->SetNumberField(TEXT("alpha"), Alpha->GetPropertyValue_InContainer(Instance));
	Row->SetNumberField(TEXT("x"), Position.X);
	Row->SetNumberField(TEXT("y"), Position.Y);
	Row->SetNumberField(TEXT("z"), Position.Z);
	FString Result;
	FJsonSerializer::Serialize(Row, TJsonWriterFactory<>::Create(&Result));
	return Result;
}

FString UAnimBlendProbe::SetCompileSavePolicy(bool bEnable)
{
	static TOptional<ESaveOnCompile> Original;
	auto* Settings = GetMutableDefault<UBlueprintEditorSettings>();
	if (bEnable && !Original.IsSet())
	{
		Original = Settings->SaveOnCompile;
		Settings->SaveOnCompile = SoC_Always;
	}
	else if (!bEnable && Original.IsSet())
	{
		Settings->SaveOnCompile = Original.GetValue();
		Original.Reset();
	}
	return StaticEnum<ESaveOnCompile>()->GetNameStringByValue(Settings->SaveOnCompile);
}

FString UAnimBlendProbe::SkeletonSlots(UAnimBlueprint* Blueprint)
{
	if (!Blueprint || !Blueprint->TargetSkeleton) return {};
	TArray<TSharedPtr<FJsonValue>> Rows;
	for (const auto& Group : Blueprint->TargetSkeleton->GetSlotGroups())
	{
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("group"), Group.GroupName.ToString());
		TArray<TSharedPtr<FJsonValue>> Slots;
		for (FName Name : Group.SlotNames) Slots.Add(MakeShared<FJsonValueString>(Name.ToString()));
		Row->SetArrayField(TEXT("slots"), Slots);
		Rows.Add(MakeShared<FJsonValueObject>(Row));
	}
	FString Result;
	FJsonSerializer::Serialize(Rows, TJsonWriterFactory<>::Create(&Result));
	return Result;
}

FString UAnimBlendProbe::SampleSlot(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh, UAnimSequence* Clip, FName Slot)
{
	if (!Blueprint || !Blueprint->GeneratedClass || !Mesh || !Clip || Clip->GetSkeleton() != Mesh->GetSkeleton()) return {};
	auto* Component = NewObject<USkeletalMeshComponent>(GetTransientPackage());
	Component->SetSkeletalMesh(Mesh);
	Component->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	Component->SetUpdateAnimationInEditor(true);
	Component->RegisterComponentWithWorld(GEditor->GetEditorWorldContext().World());
	ON_SCOPE_EXIT { Component->DestroyComponent(); };
	Component->SetAnimInstanceClass(Blueprint->GeneratedClass);
	auto* Instance = Component->GetAnimInstance();
	if (!Instance || Instance->GetClass() != Blueprint->GeneratedClass) return {};
	auto SamplePosition = [&]() -> TSharedPtr<FJsonValue>
	{
		for (int32 Tick = 0; Tick < 3; ++Tick)
		{
			Component->TickAnimation(1.f / 30.f, false);
			Component->RefreshBoneTransforms();
		}
		const auto& Pose = Component->GetBoneSpaceTransforms();
		if (Pose.Num() < 2) return MakeShared<FJsonValueNull>();
		const FVector P = Pose[1].GetTranslation();
		return MakeShared<FJsonValueArray>(TArray<TSharedPtr<FJsonValue>>{
			MakeShared<FJsonValueNumber>(P.X), MakeShared<FJsonValueNumber>(P.Y), MakeShared<FJsonValueNumber>(P.Z)});
	};
	auto Row = MakeShared<FJsonObject>();
	Row->SetStringField(TEXT("class"), Instance->GetClass()->GetPathName());
	Row->SetStringField(TEXT("bone"), Mesh->GetRefSkeleton().GetBoneName(1).ToString());
	Row->SetField(TEXT("before"), SamplePosition());
	auto* Montage = Instance->PlaySlotAnimationAsDynamicMontage(Clip, Slot, 0.f, 0.f, 1.f, 100);
	if (!Montage) return {};
	Row->SetField(TEXT("playing"), SamplePosition());
	Row->SetBoolField(TEXT("active"), Instance->Montage_IsPlaying(Montage));
	Instance->Montage_Stop(0.f, Montage);
	Row->SetField(TEXT("stopped"), SamplePosition());
	FString Result;
	FJsonSerializer::Serialize(Row, TJsonWriterFactory<>::Create(&Result));
	return Result;
}

FString UAnimBlendProbe::SampleStates(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh)
{
	if (!Blueprint || !Blueprint->GeneratedClass || !Mesh) return {};
	auto* Component = NewObject<USkeletalMeshComponent>(GetTransientPackage());
	Component->SetSkeletalMesh(Mesh);
	Component->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	Component->SetUpdateAnimationInEditor(true);
	Component->RegisterComponentWithWorld(GEditor->GetEditorWorldContext().World());
	ON_SCOPE_EXIT { Component->DestroyComponent(); };
	Component->SetAnimInstanceClass(Blueprint->GeneratedClass);
	auto* Instance = Component->GetAnimInstance();
	if (!Instance || Instance->GetClass() != Blueprint->GeneratedClass) return {};
	auto* Drive = FindFProperty<FFloatProperty>(Instance->GetClass(), TEXT("StateDrive"));
	const int32 Bone = Mesh->GetRefSkeleton().FindBoneIndex(TEXT("pelvis"));
	if (!Drive || Bone == INDEX_NONE) return {};
	TArray<TSharedPtr<FJsonValue>> Samples;
	auto SamplePhase = [&](float Value, int32 Frames) -> bool
	{
		Drive->SetPropertyValue_InContainer(Instance, Value);
		for (int32 Frame = 0; Frame < Frames; ++Frame)
		{
			Component->TickAnimation(1.f / 30.f, false);
			Component->RefreshBoneTransforms();
			const auto* Machine = Instance->GetStateMachineInstanceFromName(TEXT("FixtureMovement"));
			const auto* Description = Instance->GetStateMachineInstanceDesc(TEXT("FixtureMovement"));
			if (!Machine || !Description || Description->Transitions.Num() != 1 || Description->States.Num() != 2) return false;
			const auto& Edge = Description->Transitions[0];
			if (!Description->States.IsValidIndex(Edge.PreviousState) || !Description->States.IsValidIndex(Edge.NextState)) return false;
			const auto& Pose = Component->GetBoneSpaceTransforms();
			if (!Pose.IsValidIndex(Bone)) return false;
			auto Row = MakeShared<FJsonObject>();
			Row->SetNumberField(TEXT("frame"), Samples.Num() + 1);
			Row->SetNumberField(TEXT("drive"), Drive->GetPropertyValue_InContainer(Instance));
			Row->SetStringField(TEXT("state"), Machine->GetCurrentStateName().ToString());
			Row->SetBoolField(TEXT("transition_active"), Machine->IsTransitionActive(0));
			Row->SetStringField(TEXT("from"), Description->States[Edge.PreviousState].StateName.ToString());
			Row->SetStringField(TEXT("to"), Description->States[Edge.NextState].StateName.ToString());
			const FVector P = Pose[Bone].GetTranslation();
			Row->SetArrayField(TEXT("position"), {MakeShared<FJsonValueNumber>(P.X), MakeShared<FJsonValueNumber>(P.Y), MakeShared<FJsonValueNumber>(P.Z)});
			Samples.Add(MakeShared<FJsonValueObject>(Row));
		}
		return true;
	};
	if (!SamplePhase(0.25f, 3) || !SamplePhase(0.5f, 2) || !SamplePhase(0.75f, 15)) return {};
	auto Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("class"), Instance->GetClass()->GetPathName());
	Out->SetStringField(TEXT("instance"), Instance->GetPathName());
	Out->SetStringField(TEXT("bone"), Mesh->GetRefSkeleton().GetBoneName(Bone).ToString());
	Out->SetStringField(TEXT("space"), TEXT("parent-local"));
	Out->SetNumberField(TEXT("dt"), 1.0 / 30);
	Out->SetArrayField(TEXT("samples"), Samples);
	FString Json;
	FJsonSerializer::Serialize(Out, TJsonWriterFactory<>::Create(&Json));
	return Json;
}

bool UAnimBlendProbe::IsEditorOpen(UAnimBlueprint* Blueprint)
{
	return GEditor->GetEditorSubsystem<UAssetEditorSubsystem>()->FindEditorForAsset(Blueprint, false) != nullptr;
}

bool UAnimBlendProbe::History(bool Redo)
{
	return Redo ? GEditor->RedoTransaction() : GEditor->UndoTransaction();
}

FString UAnimBlendProbe::Members(UAnimBlueprint* Blueprint)
{
	TArray<TSharedPtr<FJsonValue>> Members;
	for (const FBPVariableDescription& V : Blueprint->NewVariables)
	{
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("name"), V.VarName.ToString());
		Row->SetStringField(TEXT("guid"), V.VarGuid.ToString());
		Row->SetStringField(TEXT("category"), V.VarType.PinCategory.ToString());
		Members.Add(MakeShared<FJsonValueObject>(Row));
	}
	FString Result;
	FJsonSerializer::Serialize(Members, TJsonWriterFactory<>::Create(&Result));
	return Result;
}

bool UAnimBlendProbe::ReconstructAlpha(UAnimBlueprint* Blueprint)
{
	auto* Graph = FindObject<UEdGraph>(Blueprint, TEXT("AnimGraph"));
	if (!Graph) return false;
	TArray<UAnimGraphNode_TwoWayBlend*> Nodes;
	Graph->GetNodesOfClass(Nodes);
	if (Nodes.Num() != 1) return false;
	auto* Node = Nodes[0];
	const int32 Index = Node->ShowPinForProperties.IndexOfByPredicate([](const FOptionalPinFromProperty& P)
	{
		return P.PropertyName == TEXT("Alpha");
	});
	auto* Pin = Node->FindPin(TEXT("Alpha"));
	if (Index == INDEX_NONE || !Pin || Pin->LinkedTo.Num()) return false;
	Node->SetPinVisibility(false, Index);
	Node->SetPinVisibility(true, Index);
	return Node->FindPin(TEXT("Alpha")) != nullptr;
}

FString UAnimBlendProbe::PlantCompileError(UAnimBlueprint* Blueprint)
{
	auto* Graph = FindObject<UEdGraph>(Blueprint, TEXT("EventGraph"));
	if (!Graph) return {};
	TArray<UK2Node_VariableSet*> Setters;
	Graph->GetNodesOfClass(Setters);
	if (Setters.Num() != 1) return {};
	FGraphNodeCreator<UK2Node_CallFunction> Creator(*Graph);
	auto* Call = Creator.CreateNode();
	Call->FunctionReference.SetExternalMember(TEXT("UEMCPMissingFixtureFunction"), UKismetSystemLibrary::StaticClass());
	Creator.Finalize();
	auto* Exec = Call->CreatePin(EGPD_Input, UEdGraphSchema_K2::PC_Exec, UEdGraphSchema_K2::PN_Execute);
	if (!Graph->GetSchema()->TryCreateConnection(Setters[0]->FindPinChecked(TEXT("then")), Exec)) return {};
	return Call->NodeGuid.ToString();
}

bool UAnimBlendProbe::SeedFormatArgument(UAnimBlueprint* Blueprint)
{
	auto* Graph = FBlueprintEditorUtils::FindEventGraph(Blueprint);
	if (!Graph) return false;
	FGraphNodeCreator<UK2Node_FormatText> Producer(*Graph);
	auto* Source = Producer.CreateNode();
	Producer.Finalize();
	FGraphNodeCreator<UK2Node_FormatText> Consumer(*Graph);
	auto* Target = Consumer.CreateNode();
	Consumer.Finalize();
	Target->NodePosX = Source->NodePosX + 320;
	Graph->GetSchema()->TrySetDefaultText(*Target->GetFormatPin(), FText::FromString(TEXT("{User}")));
	auto* Argument = Target->FindPin(TEXT("User"));
	return Argument && Graph->GetSchema()->TryCreateConnection(Source->FindPinChecked(TEXT("Result")), Argument);
}

FString UAnimBlendProbe::Inspect(UAnimBlueprint* Blueprint)
{
	TArray<UEdGraph*> Graphs;
	Blueprint->GetAllGraphs(Graphs);
	TMap<FString, int32> CacheNames;
	for (auto* Graph : Graphs) for (UEdGraphNode* Node : Graph->Nodes)
		if (const auto* Save = Cast<UAnimGraphNode_SaveCachedPose>(Node)) CacheNames.FindOrAdd(Save->CacheName.ToLower())++;
	TArray<TSharedPtr<FJsonValue>> Rows;
	for (auto* Graph : Graphs) for (UEdGraphNode* Node : Graph->Nodes) for (auto* Pin : Node->Pins)
	{
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("graph"), Graph->GetName());
		Row->SetStringField(TEXT("graphId"), Graph->GraphGuid.ToString());
		Row->SetStringField(TEXT("class"), Node->GetClass()->GetName());
		Row->SetBoolField(TEXT("enabled"), Node->IsNodeEnabled());
		if (const auto* Variable = Cast<UK2Node_Variable>(Node))
		{
			Row->SetStringField(TEXT("member"), Variable->VariableReference.GetMemberName().ToString());
			Row->SetStringField(TEXT("member_guid"), Variable->VariableReference.GetMemberGuid().ToString());
		}
		Row->SetStringField(TEXT("node"), Node->NodeGuid.ToString());
		Row->SetNumberField(TEXT("x"), Node->NodePosX);
		Row->SetNumberField(TEXT("y"), Node->NodePosY);
		Row->SetStringField(TEXT("pin"), Pin->PinId.ToString());
		Row->SetStringField(TEXT("name"), Pin->PinName.ToString());
		Row->SetStringField(TEXT("category"), Pin->PinType.PinCategory.ToString());
		Row->SetStringField(TEXT("value"), Pin->DefaultValue);
		if (const auto* Save = Cast<UAnimGraphNode_SaveCachedPose>(Node))
		{
			Row->SetStringField(TEXT("cache_name"), Save->CacheName);
			Row->SetStringField(TEXT("cache_save_guid"), Save->NodeGuid.ToString());
			Row->SetBoolField(TEXT("cache_reference_valid"), CacheNames.FindRef(Save->CacheName.ToLower()) == 1);
		}
		if (const auto* Use = Cast<UAnimGraphNode_UseCachedPose>(Node))
		{
			const auto* StoredName = FindFProperty<FStrProperty>(Use->GetClass(), TEXT("NameOfCache"));
			Row->SetStringField(TEXT("cache_name"), StoredName ? StoredName->GetPropertyValue_InContainer(Use) : FString());
			Row->SetStringField(TEXT("cache_save_guid"), Use->SaveCachedPoseNode.IsValid() ? Use->SaveCachedPoseNode->NodeGuid.ToString() : FString());
			auto LastGraphOuter = [](const UObject* Object)
			{
				const UEdGraph* Last = nullptr;
				for (const UObject* Outer = Object->GetOuter(); Outer; Outer = Outer->GetOuter())
					if (const auto* Candidate = Cast<UEdGraph>(Outer)) Last = Candidate;
				return Last;
			};
			const auto* Referenced = Use->SaveCachedPoseNode.Get();
			Row->SetBoolField(TEXT("cache_reference_valid"), Referenced && Referenced->GetGraph()->Nodes.Contains(Referenced) &&
				CacheNames.FindRef(Referenced->CacheName.ToLower()) == 1 &&
				LastGraphOuter(Referenced) == LastGraphOuter(Use));
		}
		if (const auto* Slot = Cast<UAnimGraphNode_Slot>(Node)) Row->SetStringField(TEXT("slot"), Slot->Node.SlotName.ToString());
		if (const auto* Player = Cast<UAnimGraphNode_SequencePlayer>(Node))
			Row->SetStringField(TEXT("sequence"), GetPathNameSafe(Player->Node.GetSequence()));
		TArray<TSharedPtr<FJsonValue>> Links;
		for (auto* Peer : Pin->LinkedTo) Links.Add(MakeShared<FJsonValueString>(Peer->PinId.ToString()));
		Row->SetArrayField(TEXT("links"), Links);
		Rows.Add(MakeShared<FJsonValueObject>(Row));
	}
	FString Result;
	FJsonSerializer::Serialize(Rows, TJsonWriterFactory<>::Create(&Result));
	return Result;
}

bool UAnimBlendProbe::SetCacheReference(UAnimBlueprint* Blueprint, const FString& UseGuid, const FString& SaveGuid)
{
	if (!Blueprint) return false;
	TArray<UEdGraph*> Graphs;
	Blueprint->GetAllGraphs(Graphs);
	UAnimGraphNode_UseCachedPose* Use = nullptr;
	UAnimGraphNode_SaveCachedPose* Save = nullptr;
	for (auto* Graph : Graphs) for (UEdGraphNode* Node : Graph->Nodes)
	{
		if (Node->NodeGuid.ToString() == UseGuid) Use = Cast<UAnimGraphNode_UseCachedPose>(Node);
		if (Node->NodeGuid.ToString() == SaveGuid) Save = Cast<UAnimGraphNode_SaveCachedPose>(Node);
	}
	if (!Use || (!SaveGuid.IsEmpty() && !Save)) return false;
	Use->SaveCachedPoseNode = Save;
	return true;
}

FString UAnimBlendProbe::SampleCachedPose(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh)
{
	if (!Blueprint || !Blueprint->GeneratedClass || !Mesh) return {};
	auto* Component = NewObject<USkeletalMeshComponent>(GetTransientPackage());
	Component->SetSkeletalMesh(Mesh);
	Component->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	Component->SetUpdateAnimationInEditor(true);
	Component->RegisterComponentWithWorld(GEditor->GetEditorWorldContext().World());
	ON_SCOPE_EXIT { Component->DestroyComponent(); };
	Component->SetAnimInstanceClass(Blueprint->GeneratedClass);
	auto* Instance = Component->GetAnimInstance();
	if (!Instance || Instance->GetClass() != Blueprint->GeneratedClass) return {};
	for (int32 Tick = 0; Tick < 3; ++Tick)
	{
		Component->TickAnimation(1.f / 30.f, false);
		Component->RefreshBoneTransforms();
	}
	const auto& Pose = Component->GetBoneSpaceTransforms();
	if (Pose.Num() < 2) return {};
	const auto P = Pose[1].GetTranslation();
	auto Row = MakeShared<FJsonObject>();
	Row->SetStringField(TEXT("bone"), Mesh->GetRefSkeleton().GetBoneName(1).ToString());
	Row->SetStringField(TEXT("space"), TEXT("parent-local"));
	Row->SetStringField(TEXT("class"), Instance->GetClass()->GetPathName());
	Row->SetStringField(TEXT("instance"), Instance->GetPathName());
	Row->SetNumberField(TEXT("ticks"), 3);
	Row->SetNumberField(TEXT("dt"), 1.0 / 30.0);
	Row->SetNumberField(TEXT("x"), P.X); Row->SetNumberField(TEXT("y"), P.Y); Row->SetNumberField(TEXT("z"), P.Z);
	FString Result;
	FJsonSerializer::Serialize(Row, TJsonWriterFactory<>::Create(&Result));
	return Result;
}
