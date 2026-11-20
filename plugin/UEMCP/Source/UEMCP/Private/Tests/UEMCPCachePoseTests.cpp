// Copyright Noah Butcher. All Rights Reserved.
#if WITH_DEV_AUTOMATION_TESTS
#include "CoreMinimal.h"
#include "Animation/AnimBlueprint.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Animation/Skeleton.h"
#include "AnimGraphNode_SaveCachedPose.h"
#include "AnimGraphNode_UseCachedPose.h"
#include "AnimGraphNode_LocalRefPose.h"
#include "AnimGraphNode_Root.h"
#include "AnimGraphNode_StateMachine.h"
#include "AnimStateNode.h"
#include "AnimStateTransitionNode.h"
#include "AnimationStateMachineGraph.h"
#include "AnimationGraph.h"
#include "AnimationGraphSchema.h"
#include "BlueprintHandlerHelpers.h"
#include "CachePoseAuthoring.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "EdGraph/EdGraph.h"
#include "Factories/AnimBlueprintFactory.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "MCPCommandRegistry.h"
#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/UnrealType.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPCachedPoseReferences, "UEMCP.Animation.CachedPoseReferences",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FUEMCPCachedPoseReferences::RunTest(const FString& Parameters)
{
	if (!TestTrue(TEXT("Idle history"), GEditor && GEditor->Trans && !GEditor->Trans->IsActive() && !GUndo)) return false;
	const FString Leaf = TEXT("ABP_Cache_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	auto* Package = CreatePackage(*(TEXT("/Game/__UEMCPTests/") + Leaf));
	auto* Factory = NewObject<UAnimBlueprintFactory>();
	Factory->TargetSkeleton = LoadObject<USkeleton>(nullptr, TEXT("/Engine/EngineMeshes/SkeletalCube_Skeleton.SkeletalCube_Skeleton"));
	if (!TestNotNull(TEXT("Skeleton"), Factory->TargetSkeleton.Get())) return false;
	auto* BP = Cast<UAnimBlueprint>(Factory->FactoryCreateNew(UAnimBlueprint::StaticClass(), Package, FName(*Leaf), RF_Public | RF_Standalone | RF_Transactional, nullptr, GWarn));
	if (!TestNotNull(TEXT("AnimBP"), BP)) return false;
	FAssetRegistryModule::AssetCreated(BP);
	ON_SCOPE_EXIT { FAssetRegistryModule::AssetDeleted(BP); Package->SetDirtyFlag(false); BP->ClearFlags(RF_Public | RF_Standalone); };
	auto* Graph = FindObject<UEdGraph>(BP, TEXT("AnimGraph"));
	if (!TestNotNull(TEXT("Graph"), Graph)) return false;
	TStrongObjectPtr<UTransactor> Prior(GEditor->Trans.Get());
	TStrongObjectPtr<UTransBuffer> History(NewObject<UTransBuffer>());
	History->Initialize(8 * 1024 * 1024);
	TGuardValue<decltype(GEditor->Trans)> PrivateHistory(GEditor->Trans, History.Get());
	auto Invoke = [&](const FString& Op, const FString& Name, const FGuid& SaveId)
	{
		auto Args = MakeShared<FJsonObject>();
		Args->SetStringField(TEXT("asset_path"), BP->GetPathName());
		Args->SetStringField(TEXT("graph_guid"), Graph->GraphGuid.ToString());
		Args->SetStringField(TEXT("expected_revision"), UEMCP::GraphTopologyRevision(Graph));
		Args->SetStringField(TEXT("operation"), Op);
		Args->SetStringField(TEXT("cache_name"), Name);
		Args->SetStringField(TEXT("cache_node_id"), SaveId.ToString());
		TSharedPtr<FJsonObject> Response;
		UEMCP::FMCPCommandRegistry::Get().Dispatch(TEXT("edit_anim_cached_pose"), Args, Response);
		return Response;
	};
	auto Ok = [&](const TSharedPtr<FJsonObject>& Response)
	{
		FString Status, Code, Error;
		if (Response.IsValid())
		{
			Response->TryGetStringField(TEXT("status"), Status);
			Response->TryGetStringField(TEXT("code"), Code);
			Response->TryGetStringField(TEXT("error"), Error);
		}
		return TestTrue(FString::Printf(TEXT("Operation success (code=%s; error=%s)"), *Code, *Error), Status == TEXT("success"));
	};
	const FString Baseline = UEMCP::GraphTopologyRevision(Graph);
	if (!Ok(Invoke(TEXT("create_save"), TEXT("Walk"), FGuid()))) return false;
	UAnimGraphNode_SaveCachedPose* Save = nullptr;
	for (UEdGraphNode* Node : Graph->Nodes) if (auto* Found = Cast<UAnimGraphNode_SaveCachedPose>(Node)) Save = Found;
	if (!TestNotNull(TEXT("Save node"), Save)) return false;
	const FGuid SaveId = Save->NodeGuid;
	TestTrue(TEXT("Undo create"), History->Undo());
	TestEqual(TEXT("Undo original graph"), UEMCP::GraphTopologyRevision(Graph), Baseline);
	TestTrue(TEXT("Redo create"), History->Redo());
	if (!Ok(Invoke(TEXT("create_use"), TEXT(""), SaveId)) || !Ok(Invoke(TEXT("create_use"), TEXT(""), SaveId))) return false;
	TArray<UAnimGraphNode_UseCachedPose*> Users;
	Graph->GetNodesOfClass(Users);
	TestEqual(TEXT("Repeated uses"), Users.Num(), 2);
	const FString BeforeRename = UEMCP::GraphTopologyRevision(Graph);
	if (!Ok(Invoke(TEXT("rename"), TEXT("Stride"), SaveId))) return false;
	const FString Renamed = UEMCP::GraphTopologyRevision(Graph);
	TestNotEqual(TEXT("Rename invalidates revision"), Renamed, BeforeRename);
	auto CheckUsers = [&](const FString& Name)
	{
		for (auto* Use : Users)
		{
			TestTrue(TEXT("Stable Save reference"), Use->SaveCachedPoseNode.Get() == Save);
			auto* Stored = FindFProperty<FStrProperty>(Use->GetClass(), TEXT("NameOfCache"));
			if (TestNotNull(TEXT("Persisted fallback name"), Stored)) TestEqual(TEXT("Effective use name"), Stored->GetPropertyValue_InContainer(Use), Name);
		}
	};
	CheckUsers(TEXT("Stride"));
	TestTrue(TEXT("Undo rename"), History->Undo()); CheckUsers(TEXT("Walk"));
	TestEqual(TEXT("Undo semantic revision"), UEMCP::GraphTopologyRevision(Graph), BeforeRename);
	TestTrue(TEXT("Redo rename"), History->Redo()); CheckUsers(TEXT("Stride"));
	TestEqual(TEXT("Redo semantic revision"), UEMCP::GraphTopologyRevision(Graph), Renamed);
	auto BadReference = Invoke(TEXT("create_use"), TEXT(""), FGuid::NewGuid());
	TestEqual(TEXT("Reject stale Save identity"), BadReference->GetStringField(TEXT("code")), FString(TEXT("STALE_CACHE_REFERENCE")));
	auto* Input = Save->FindPin(TEXT("Pose"), EGPD_Input);
	auto* Output = Users[0]->FindPin(TEXT("Pose"), EGPD_Output);
	if (!TestNotNull(TEXT("Save input"), Input) || !TestNotNull(TEXT("Use output"), Output)) return false;
	auto Connect = [&](UEdGraphPin* From, UEdGraphPin* To, const FString& NameOverride = FString(), const FString& GuidOverride = FString())
	{
		auto Args = MakeShared<FJsonObject>();
		Args->SetStringField(TEXT("blueprint_name"), Package->GetName());
		Args->SetStringField(TEXT("graph_name"), NameOverride.IsEmpty() ? To->GetOwningNode()->GetGraph()->GetName() : NameOverride);
		Args->SetStringField(TEXT("graph_guid"), GuidOverride.IsEmpty() ? To->GetOwningNode()->GetGraph()->GraphGuid.ToString() : GuidOverride);
		Args->SetStringField(TEXT("source_node_id"), From->GetOwningNode()->NodeGuid.ToString());
		Args->SetStringField(TEXT("target_node_id"), To->GetOwningNode()->NodeGuid.ToString());
		Args->SetStringField(TEXT("source_pin"), From->PinName.ToString());
		Args->SetStringField(TEXT("target_pin"), To->PinName.ToString());
		TSharedPtr<FJsonObject> Response;
		UEMCP::FMCPCommandRegistry::Get().Dispatch(TEXT("connect_blueprint_nodes"), Args, Response);
		return Response;
	};
	Package->SetDirtyFlag(false);
	const auto BeforeCycle = UEMCP::GraphTopologyRevision(Graph);
	TestEqual(TEXT("Ordinary wiring rejects implicit cached cycle"), Connect(Output, Input)->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	TestEqual(TEXT("Rejected cycle preserves graph"), UEMCP::GraphTopologyRevision(Graph), BeforeCycle);
	TestFalse(TEXT("Rejected cycle leaves clean package"), Package->IsDirty());
	if (!Ok(Invoke(TEXT("create_save"), TEXT("Other"), FGuid()))) return false;
	UAnimGraphNode_SaveCachedPose* Other = nullptr;
	for (UEdGraphNode* Node : Graph->Nodes) if (auto* Found = Cast<UAnimGraphNode_SaveCachedPose>(Node)) if (Found != Save) Other = Found;
	if (!TestNotNull(TEXT("Other cache"), Other)) return false;
	if (!Ok(Invoke(TEXT("create_use"), TEXT(""), Other->NodeGuid))) return false;
	UAnimGraphNode_UseCachedPose* OtherUse = nullptr;
	for (UEdGraphNode* Node : Graph->Nodes) if (auto* Use = Cast<UAnimGraphNode_UseCachedPose>(Node)) if (Use->SaveCachedPoseNode.Get() == Other) OtherUse = Use;
	if (!TestNotNull(TEXT("Other use"), OtherUse)) return false;
	if (!Ok(Connect(Output, Other->FindPin(TEXT("Pose"), EGPD_Input)))) return false;
	const auto BeforeIndirect = UEMCP::GraphTopologyRevision(Graph);
	TestEqual(TEXT("Indirect cached cycle rejected"), Connect(OtherUse->FindPin(TEXT("Pose"), EGPD_Output), Input)->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	TestEqual(TEXT("Indirect rejection preserves graph"), UEMCP::GraphTopologyRevision(Graph), BeforeIndirect);
	Users[1]->SaveCachedPoseNode.Reset();
	auto Broken = Invoke(TEXT("rename"), TEXT("Bad"), SaveId);
	TestEqual(TEXT("Broken existing reference rejected"), Broken->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	// A broken disconnected Use must not prevent an unrelated, valid pose route.
	FGraphNodeCreator<UAnimGraphNode_LocalRefPose> PoseCreator(*Graph);
	auto* Pose = PoseCreator.CreateNode(); PoseCreator.Finalize();
	TArray<UAnimGraphNode_Root*> Roots; Graph->GetNodesOfClass(Roots);
	if (Roots.Num() == 1) Ok(Connect(Pose->FindPin(TEXT("Pose"), EGPD_Output), Roots[0]->FindPin(TEXT("Result"), EGPD_Input)));
	else AddError(TEXT("Missing root"));
	Users[1]->SaveCachedPoseNode = Save;

	// A machine's dependencies include the pose roots in its state subgraphs.
	FGraphNodeCreator<UAnimGraphNode_StateMachine> MachineCreator(*Graph);
	auto* Machine = MachineCreator.CreateNode(); MachineCreator.Finalize();
	auto* MachineGraph = Machine->EditorStateMachineGraph.Get();
	if (!TestNotNull(TEXT("Nested machine graph"), MachineGraph)) return false;
	FGraphNodeCreator<UAnimStateNode> StateCreator(*MachineGraph);
	auto* State = StateCreator.CreateNode(); StateCreator.Finalize();
	auto* StateGraph = State->GetBoundGraph();
	if (!TestNotNull(TEXT("Nested state graph"), StateGraph)) return false;
	auto* StateSink = State->GetPoseSinkPinInsideState();
	FGraphNodeCreator<UAnimGraphNode_UseCachedPose> NestedCreator(*StateGraph);
	auto* NestedUse = NestedCreator.CreateNode();
	NestedUse->SaveCachedPoseNode = Save;
	auto* Stored = FindFProperty<FStrProperty>(NestedUse->GetClass(), TEXT("NameOfCache"));
	if (!TestNotNull(TEXT("Nested Use persisted name"), Stored)) return false;
	Stored->SetPropertyValue_InContainer(NestedUse, Save->CacheName);
	NestedCreator.Finalize();
	auto* NestedOutput = NestedUse->FindPin(TEXT("Pose"), EGPD_Output);
	auto* MachineOutput = Machine->FindPin(TEXT("Pose"), EGPD_Output);
	if (!TestNotNull(TEXT("State sink"), StateSink) || !TestNotNull(TEXT("Machine output"), MachineOutput) ||
		!TestNotNull(TEXT("Nested Use output"), NestedOutput)) return false;
	if (!Ok(Connect(NestedOutput, StateSink))) return false;
	auto CheckNestedRejection = [&](UEdGraphPin* From, UEdGraphPin* To)
	{
		Package->SetDirtyFlag(false);
		const auto TopBefore = UEMCP::GraphTopologyRevision(Graph);
		const auto StateBefore = UEMCP::GraphTopologyRevision(StateGraph);
		TestEqual(TEXT("Nested cached cycle refused"), Connect(From, To)->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
		TestEqual(TEXT("Nested rejection preserves top graph"), UEMCP::GraphTopologyRevision(Graph), TopBefore);
		TestEqual(TEXT("Nested rejection preserves state graph"), UEMCP::GraphTopologyRevision(StateGraph), StateBefore);
		TestFalse(TEXT("Nested rejection preserves clean package"), Package->IsDirty());
	};
	// First order: the state already uses A, then caller tries Machine -> Save A.
	CheckNestedRejection(MachineOutput, Input);
	NestedOutput->BreakLinkTo(StateSink);
	if (!Ok(Connect(MachineOutput, Input))) return false;
	// Reverse order: Machine -> Save A exists, then caller changes state to Use A.
	CheckNestedRejection(NestedOutput, StateSink);
	FGraphNodeCreator<UAnimGraphNode_LocalRefPose> NestedPoseCreator(*StateGraph);
	auto* IndependentPose = NestedPoseCreator.CreateNode(); NestedPoseCreator.Finalize();
	TestTrue(TEXT("Independent nested route remains supported"), Ok(Connect(IndependentPose->FindPin(TEXT("Pose"), EGPD_Output), StateSink)));
	const auto NestedIdentityBefore = UEMCP::GraphTopologyRevision(StateGraph);
	TestEqual(TEXT("Conflicting graph name refused"), Connect(NestedOutput, StateSink, TEXT("AnimGraph"))->GetStringField(TEXT("code")), FString(TEXT("GRAPH_IDENTITY_MISMATCH")));
	TestEqual(TEXT("Stale graph GUID refused"), Connect(NestedOutput, StateSink, FString(), FGuid::NewGuid().ToString())->GetStringField(TEXT("code")), FString(TEXT("GRAPH_NOT_FOUND")));
	TestEqual(TEXT("Malformed graph GUID refused"), Connect(NestedOutput, StateSink, FString(), TEXT("not-a-guid"))->GetStringField(TEXT("code")), FString(TEXT("INVALID_GRAPH_ID")));
	StateGraph->bEditable = false;
	TestEqual(TEXT("Read-only nested graph refused"), Connect(NestedOutput, StateSink)->GetStringField(TEXT("code")), FString(TEXT("READ_ONLY_GRAPH")));
	StateGraph->bEditable = true;
	TestEqual(TEXT("Identity rejections preserve nested graph"), UEMCP::GraphTopologyRevision(StateGraph), NestedIdentityBefore);
	MachineOutput->BreakLinkTo(Input);
	FGraphNodeCreator<UAnimStateNode> NextStateCreator(*MachineGraph);
	auto* NextState = NextStateCreator.CreateNode(); NextStateCreator.Finalize();
	FGraphNodeCreator<UAnimStateTransitionNode> TransitionCreator(*MachineGraph);
	auto* Transition = TransitionCreator.CreateNode(); TransitionCreator.Finalize();
	Transition->CreateConnections(State, NextState);
	TestNull(TEXT("Ordinary transition has no custom blend graph"), Transition->CustomTransitionGraph.Get());
	if (!Ok(Invoke(TEXT("create_save"), TEXT("WithOrdinaryTransition"), FGuid()))) return false;
	if (!Ok(Invoke(TEXT("rename"), TEXT("WithTransitionRename"), SaveId))) return false;
	FGraphNodeCreator<UAnimStateTransitionNode> SharedCreator(*MachineGraph);
	auto* SharedTransition = SharedCreator.CreateNode(); SharedCreator.Finalize();
	SharedTransition->CreateConnections(NextState, State);
	SharedTransition->UseSharedRules(Transition);
	TestTrue(TEXT("Real shared transition rule graph"), Transition->IsBoundGraphShared());
	auto* RuleGraph = Transition->GetBoundGraph();
	if (!TestNotNull(TEXT("Shared rule graph"), RuleGraph)) return false;
	const auto SharedBefore = UEMCP::GraphTopologyRevision(RuleGraph);
	TestEqual(TEXT("Shared transition GUID wiring rejected"), Connect(Output, Input, RuleGraph->GetName(), RuleGraph->GraphGuid.ToString())->GetStringField(TEXT("code")), FString(TEXT("UNSUPPORTED_GRAPH")));
	TestEqual(TEXT("Shared transition rejection preserves graph"), UEMCP::GraphTopologyRevision(RuleGraph), SharedBefore);

	// Compiler names are Blueprint-wide, including animation layer graphs.
	auto* LayerGraph = FBlueprintEditorUtils::CreateNewGraph(BP, TEXT("CacheLayerFixture"), UAnimationGraph::StaticClass(), UAnimationGraphSchema::StaticClass());
	FBlueprintEditorUtils::AddDomainSpecificGraph(BP, LayerGraph);
	FGraphNodeCreator<UAnimGraphNode_SaveCachedPose> LayerCreator(*LayerGraph);
	auto* LayerSave = LayerCreator.CreateNode(); LayerSave->CacheName = TEXT("LayerOwnedCache"); LayerCreator.Finalize();
	for (const FString& Operation : { FString(TEXT("create_save")), FString(TEXT("rename")) })
	{
		Package->SetDirtyFlag(false);
		const auto TopBefore = UEMCP::GraphTopologyRevision(Graph);
		const auto LayerBefore = UEMCP::GraphTopologyRevision(LayerGraph);
		const int32 BeforeNodes = Graph->Nodes.Num();
		auto Duplicate = Invoke(Operation, TEXT("layerownedcache"), SaveId);
		TestEqual(TEXT("Reject cache-name collision in another layer"), Duplicate->GetStringField(TEXT("code")), FString(TEXT("DUPLICATE_CACHE_NAME")));
		TestEqual(TEXT("Name rejection preserves top graph"), UEMCP::GraphTopologyRevision(Graph), TopBefore);
		TestEqual(TEXT("Name rejection preserves layer graph"), UEMCP::GraphTopologyRevision(LayerGraph), LayerBefore);
		TestEqual(TEXT("Name rejection creates no node"), Graph->Nodes.Num(), BeforeNodes);
		TestFalse(TEXT("Name rejection preserves clean package"), Package->IsDirty());
	}
	FGraphNodeCreator<UAnimGraphNode_UseCachedPose> CrossLayerCreator(*LayerGraph);
	auto* CrossLayerUse = CrossLayerCreator.CreateNode();
	CrossLayerUse->SaveCachedPoseNode = Save;
	Stored->SetPropertyValue_InContainer(CrossLayerUse, Save->CacheName);
	CrossLayerCreator.Finalize();
	bool bSawCrossLayerReference = false;
	for (const auto& Row : UEMCP::ReadCachedPoseNodes(LayerGraph))
	{
		const auto Object = Row->AsObject();
		if (Object->GetStringField(TEXT("node_id")) == CrossLayerUse->NodeGuid.ToString())
		{
			bSawCrossLayerReference = true;
			TestFalse(TEXT("Same Blueprint different-layer reference is reported invalid"), Object->GetBoolField(TEXT("reference_valid")));
		}
	}
	TestTrue(TEXT("Readback includes invalid cross-layer Use"), bSawCrossLayerReference);
	Package->SetDirtyFlag(false);
	const auto CrossLayerTopBefore = UEMCP::GraphTopologyRevision(Graph);
	const auto CrossLayerBefore = UEMCP::GraphTopologyRevision(LayerGraph);
	TestEqual(TEXT("Cross-layer reference rejected before rename"), Invoke(TEXT("rename"), TEXT("MustNotRename"), SaveId)->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	TestEqual(TEXT("Cross-layer rejection preserves top graph"), UEMCP::GraphTopologyRevision(Graph), CrossLayerTopBefore);
	TestEqual(TEXT("Cross-layer rejection preserves layer graph"), UEMCP::GraphTopologyRevision(LayerGraph), CrossLayerBefore);
	TestFalse(TEXT("Cross-layer rejection preserves clean package"), Package->IsDirty());
	TestTrue(TEXT("Unrelated same-layer nested route still accepted"), Ok(Connect(IndependentPose->FindPin(TEXT("Pose"), EGPD_Output), StateSink)));
	CrossLayerUse->SaveCachedPoseNode = LayerSave;
	Stored->SetPropertyValue_InContainer(CrossLayerUse, LayerSave->CacheName);
	FString ValidationError;
	TestTrue(TEXT("Nested states and repaired layer references are legitimate"), UEMCP::ValidateCachedPoseGraph(Graph, ValidationError));
	// Existing duplicate names are ambiguous even with a valid object pointer,
	// because the compiler resolves cached poses by name.
	LayerSave->CacheName = Save->CacheName;
	UAnimGraphNode_SaveCachedPose* ThirdDuplicate = nullptr;
	for (UEdGraphNode* Node : Graph->Nodes)
		if (auto* Candidate = Cast<UAnimGraphNode_SaveCachedPose>(Node))
			if (Candidate != Save && Candidate != Other) ThirdDuplicate = Candidate;
	if (!TestNotNull(TEXT("Third legacy duplicate"), ThirdDuplicate)) return false;
	ThirdDuplicate->CacheName = Save->CacheName;
	Stored->SetPropertyValue_InContainer(CrossLayerUse, LayerSave->CacheName);
	Package->SetDirtyFlag(false);
	const auto AmbiguousTopBefore = UEMCP::GraphTopologyRevision(Graph);
	const auto AmbiguousLayerBefore = UEMCP::GraphTopologyRevision(LayerGraph);
	TestEqual(TEXT("Create Use rejects existing duplicate names"), Invoke(TEXT("create_use"), FString(), SaveId)->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	const auto AmbiguousRoute = Connect(Output, Input);
	TestEqual(TEXT("Referenced route rejects ambiguous name"), AmbiguousRoute->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	TestTrue(TEXT("Route fails specifically for ambiguity"), AmbiguousRoute->GetStringField(TEXT("error")).Contains(TEXT("Ambiguous cached-pose name")));
	TestEqual(TEXT("Ambiguous rejection preserves top graph"), UEMCP::GraphTopologyRevision(Graph), AmbiguousTopBefore);
	TestEqual(TEXT("Ambiguous rejection preserves layer"), UEMCP::GraphTopologyRevision(LayerGraph), AmbiguousLayerBefore);
	TestFalse(TEXT("Ambiguous rejection preserves clean package"), Package->IsDirty());
	for (const auto& Row : UEMCP::ReadCachedPoseNodes(Graph))
	{
		const auto Object = Row->AsObject();
		if (Object->GetStringField(TEXT("cache_node_id")) == SaveId.ToString())
			TestFalse(TEXT("Ambiguous readback reference invalid"), Object->GetBoolField(TEXT("reference_valid")));
	}
	if (!Ok(Invoke(TEXT("rename"), TEXT("RepairedUniqueCache"), SaveId))) return false;
	TestEqual(TEXT("First repair preserves unrelated layer name"), UEMCP::GraphTopologyRevision(LayerGraph), AmbiguousLayerBefore);
	TestEqual(TEXT("First repair leaves other ambiguous Save untouched"), ThirdDuplicate->CacheName, LayerSave->CacheName);
	TestTrue(TEXT("First repair preserves unrelated reference"), CrossLayerUse->SaveCachedPoseNode.Get() == LayerSave);
	TestFalse(TEXT("Three-way set permits progress before full repair"), UEMCP::ValidateCachedPoseGraph(Graph, ValidationError));
	TestEqual(TEXT("Remaining ambiguous Use still refused"), Invoke(TEXT("create_use"), FString(), ThirdDuplicate->NodeGuid)->GetStringField(TEXT("code")), FString(TEXT("INVALID_CACHE_GRAPH")));
	if (!Ok(Invoke(TEXT("rename"), TEXT("ThirdRepairedUniqueCache"), ThirdDuplicate->NodeGuid))) return false;
	TestTrue(TEXT("Successive targeted unique renames repair all ambiguity"), UEMCP::ValidateCachedPoseGraph(Graph, ValidationError));
	return true;
}
#endif
