// Copyright Noah Butcher. All Rights Reserved.
#include "StateAuthoring.h"

#include "Animation/AnimBlueprint.h"
#include "Animation/AnimBlueprintGeneratedClass.h"
#include "Animation/AnimSequence.h"
#include "AnimationGraphSchema.h"
#include "AnimationStateMachineGraph.h"
#include "AnimationTransitionGraph.h"
#include "AnimGraphNode_SequencePlayer.h"
#include "AnimGraphNode_StateMachine.h"
#include "AnimGraphNode_TransitionResult.h"
#include "AnimStateEntryNode.h"
#include "AnimStateNode.h"
#include "AnimStateTransitionNode.h"
#include "BlueprintHandlerHelpers.h"
#include "HandlerCommon.h"
#include "K2Node_CallFunction.h"
#include "K2Node_VariableGet.h"
#include "Kismet/KismetMathLibrary.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/Kismet2NameValidators.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "ScopedTransaction.h"

namespace UEMCP::StateAuthoring
{
using FParams = TSharedPtr<FJsonObject>;

static FGuid GuidField(const FParams& Params, const TCHAR* Key)
{
	FGuid Id;
	FString Text;
	if (Params && Params->TryGetStringField(Key, Text)) FGuid::Parse(Text, Id);
	return Id;
}

static bool ReadName(const FParams& Params, FString& Name)
{
	// Animation graph titles permit interior spaces ("New State Machine" is
	// UE's own initial graph title). Keep the other object path restrictions.
	static const FString InvalidCharacters = FString(INVALID_OBJECTNAME_CHARACTERS).Replace(TEXT(" "), TEXT(""));
	return Params->TryGetStringField(TEXT("name"), Name) && !Name.IsEmpty() && Name.Len() < NAME_SIZE &&
		FName::IsValidXName(Name, InvalidCharacters) && FName(*Name) != NAME_None &&
		Name.TrimStartAndEnd() == Name;
}

struct FTarget
{
	UAnimBlueprint* BP = nullptr;
	UEdGraph* Graph = nullptr;
	FIntPoint Position = FIntPoint::ZeroValue;

	bool Resolve(const FParams& Params, bool bMachineContents, FParams& Response)
	{
		const FGuid Id = GuidField(Params, TEXT("graph_guid"));
		const TArray<TSharedPtr<FJsonValue>>* XY = nullptr;
		FString Path, Revision;
		if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Path) || !Id.IsValid() ||
			!Params->TryGetStringField(TEXT("expected_revision"), Revision) || Revision.IsEmpty() ||
			!Params->TryGetArrayField(TEXT("node_position"), XY) || XY->Num() != 2)
		{
			BuildErrorResponse(Response, TEXT("Expected asset path, graph GUID, revision and node position"), TEXT("INVALID_PARAMS"));
			return false;
		}
		for (int32 I = 0; I < 2; ++I)
		{
			double V;
			if ((*XY)[I]->Type != EJson::Number || !(*XY)[I]->TryGetNumber(V) ||
				!FMath::IsWithinInclusive(V, double(MIN_int32), double(MAX_int32)) || FMath::TruncToDouble(V) != V)
			{
				BuildErrorResponse(Response, TEXT("Expected two integer graph coordinates"), TEXT("INVALID_PARAMS"));
				return false;
			}
			Position[I] = int32(V);
		}
		BP = LoadObject<UAnimBlueprint>(nullptr, *ToObjectPath(Path));
		UEdGraph* Top = BP ? FindObject<UEdGraph>(BP, TEXT("AnimGraph")) : nullptr;
		if (Top && BP->TargetSkeleton && !BP->bIsTemplate && BP->ParentClass &&
			!Cast<UAnimBlueprintGeneratedClass>(BP->ParentClass.Get()) && Top->GetSchema()->IsA<UAnimationGraphSchema>() &&
			!FBlueprintEditorUtils::IsGraphReadOnly(Top) && IsWritableAnimPackage(BP->GetOutermost()))
		{
			if (!bMachineContents && Id == Top->GraphGuid) Graph = Top;
			if (bMachineContents)
			{
				for (UEdGraphNode* Node : Top->Nodes)
				{
					const auto* Machine = Cast<UAnimGraphNode_StateMachine>(Node);
					if (Machine && Machine->EditorStateMachineGraph && Machine->EditorStateMachineGraph->GraphGuid == Id)
						Graph = Machine->EditorStateMachineGraph;
				}
			}
		}
		if (!Graph || FBlueprintEditorUtils::IsGraphReadOnly(Graph))
		{
			BuildErrorResponse(Response, TEXT("Expected a writable concrete top-level AnimGraph or its directly owned state machine"), TEXT("UNSUPPORTED_GRAPH"));
			return false;
		}
		if (GraphTopologyRevision(Graph) != Revision)
		{
			BuildErrorResponse(Response, TEXT("Read the current graph topology before authoring"), TEXT("STALE_GRAPH"));
			return false;
		}
		return CanStartGraphTransaction(Response);
	}

	FParams Result(const UEdGraphNode* Node, const UEdGraph* Child)
	{
		FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
		Graph->NotifyGraphChanged();
		auto Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("graph_guid"), Graph->GraphGuid.ToString());
		Out->SetStringField(TEXT("node_id"), Node->NodeGuid.ToString());
		Out->SetStringField(TEXT("bound_graph_guid"), Child->GraphGuid.ToString());
		Out->SetStringField(TEXT("bound_graph_name"), Child->GetName());
		Out->SetStringField(TEXT("topology_revision"), GraphTopologyRevision(Graph));
		Out->SetBoolField(TEXT("compiled"), false);
		Out->SetBoolField(TEXT("saved"), false);
		return Out;
	}
};

// Every external edge added by these operations is incident on the new node.
// Its graph is newly owned, so a failed setup can detach both without touching user history.
struct FNewNodeEdit
{
	FTarget& Target;
	bool bDirty;
	EBlueprintStatus Status;
	FScopedTransaction Transaction;

	FNewNodeEdit(FTarget& InTarget, const FText& Title)
		: Target(InTarget), bDirty(Target.BP->GetOutermost()->IsDirty()), Status(Target.BP->Status), Transaction(Title)
	{
		Target.BP->Modify();
		Target.Graph->Modify();
	}
	void Reject(UEdGraphNode* Node, UEdGraph* Child, FParams& Response)
	{
		if (Child) Target.Graph->SubGraphs.Remove(Child);
		Target.Graph->RemoveNode(Node);
		Transaction.Cancel();
		Target.BP->Status = Status;
		Target.BP->GetOutermost()->SetDirtyFlag(bDirty);
		BuildErrorResponse(Response, TEXT("Could not create the requested graph and connections"), TEXT("STATE_AUTHORING_FAILED"));
	}
};

template <typename T>
static T* Place(UEdGraph* Graph, FIntPoint Position)
{
	FGraphNodeCreator<T> Creator(*Graph);
	auto* Node = Creator.CreateNode(false);
	Node->NodePosX = Position.X;
	Node->NodePosY = Position.Y;
	Creator.Finalize();
	return Node;
}

static bool ConnectDirect(UEdGraphPin* From, UEdGraphPin* To)
{
	if (!From || !To || !From->LinkedTo.IsEmpty() || !To->LinkedTo.IsEmpty()) return false;
	const UEdGraphSchema* Schema = To->GetOwningNode()->GetGraph()->GetSchema();
	return Schema->CanCreateConnection(From, To).Response == CONNECT_RESPONSE_MAKE && Schema->TryCreateConnection(From, To)
		&& From->LinkedTo.Contains(To) && To->LinkedTo.Contains(From);
}

static bool NameNewGraph(UEdGraphNode* Node, UEdGraph* Graph, const FString& Name)
{
	// Use the engine's initial-placement naming path. OnRenameNode treats the
	// temporary graph name as a published function and retargets unrelated calls.
	const auto Validator = FNameValidatorFactory::MakeValidator(Node);
	if (!Validator || Validator->IsValid(Name) != EValidatorResult::Ok ||
		!Graph->Rename(*Name, Graph->GetOuter(), REN_Test)) return false;
	FBlueprintEditorUtils::RenameGraphWithSuggestion(Graph, Validator, Name);
	return Graph->GetName().Equals(Name, ESearchCase::CaseSensitive);
}

static void AddMachine(const FParams& Params, FParams& Response)
{
	FTarget Target;
	if (!Target.Resolve(Params, false, Response)) return;
	FString Name;
	if (!ReadName(Params, Name))
	{
		BuildErrorResponse(Response, TEXT("Expected a valid machine name"), TEXT("INVALID_NAME"));
		return;
	}
	TArray<UEdGraph*> Graphs;
	Target.BP->GetAllGraphs(Graphs);
	for (auto* Graph : Graphs)
	{
		if (Graph && Graph->IsA<UAnimationStateMachineGraph>() && Graph->GetFName() == FName(*Name))
		{
			BuildErrorResponse(Response, TEXT("Machine name already exists"), TEXT("DUPLICATE_NAME"));
			return;
		}
	}
	FNewNodeEdit Edit(Target, NSLOCTEXT("UEMCP", "AddAnimMachine", "Add animation state machine"));
	auto* Machine = Place<UAnimGraphNode_StateMachine>(Target.Graph, Target.Position);
	auto* Child = Machine->EditorStateMachineGraph.Get();
	if (!Child || !Child->EntryNode || !NameNewGraph(Machine, Child, Name)) { Edit.Reject(Machine, Child, Response); return; }
	auto Result = Target.Result(Machine, Child);
	Result->SetStringField(TEXT("entry_node_id"), Child->EntryNode->NodeGuid.ToString());
	BuildSuccessResponse(Response, Result);
}

static void AddState(const FParams& Params, FParams& Response)
{
	FTarget Target;
	if (!Target.Resolve(Params, true, Response)) return;
	FString Name, SequencePath;
	bool bInitial = false;
	if (!ReadName(Params, Name) || !Params->TryGetStringField(TEXT("sequence_path"), SequencePath) ||
		!Params->HasTypedField<EJson::Boolean>(TEXT("initial")) || !Params->TryGetBoolField(TEXT("initial"), bInitial))
	{
		BuildErrorResponse(Response, TEXT("Expected state name, sequence path and initial flag"), TEXT("INVALID_PARAMS"));
		return;
	}
	auto* Sequence = LoadObject<UAnimSequence>(nullptr, *ToObjectPath(SequencePath));
	if (!Sequence || Sequence->GetSkeleton() != Target.BP->TargetSkeleton)
	{
		BuildErrorResponse(Response, TEXT("Expected a sequence on the exact target Skeleton"), TEXT("INCOMPATIBLE_SEQUENCE"));
		return;
	}
	for (UEdGraphNode* Node : Target.Graph->Nodes)
	{
		auto* State = Cast<UAnimStateNodeBase>(Node);
		if (State && FName(*State->GetStateName()) == FName(*Name))
		{
			BuildErrorResponse(Response, TEXT("State name already exists in this machine"), TEXT("DUPLICATE_NAME"));
			return;
		}
	}
	auto* Entry = CastChecked<UAnimationStateMachineGraph>(Target.Graph)->EntryNode.Get();
	if (!Entry || Entry->Pins.Num() != 1 || (bInitial && !Entry->Pins[0]->LinkedTo.IsEmpty()))
	{
		BuildErrorResponse(Response, TEXT("Expected an available machine entry"), TEXT("ENTRY_UNAVAILABLE"));
		return;
	}
	FNewNodeEdit Edit(Target, NSLOCTEXT("UEMCP", "AddAnimState", "Add animation state"));
	auto* State = Place<UAnimStateNode>(Target.Graph, Target.Position);
	auto* Child = State->GetBoundGraph();
	if (!Child || !NameNewGraph(State, Child, Name)) { Edit.Reject(State, Child, Response); return; }
	FGraphNodeCreator<UAnimGraphNode_SequencePlayer> PlayerCreator(*Child);
	auto* Player = PlayerCreator.CreateNode(false);
	Player->NodePosX = -260;
	Player->Node.SetSequence(Sequence);
	PlayerCreator.Finalize();
	if (!ConnectDirect(Player->FindPin(TEXT("Pose"), EGPD_Output), State->GetPoseSinkPinInsideState()) ||
		(bInitial && !Target.Graph->GetSchema()->TryCreateConnection(Entry->Pins[0], State->GetInputPin())))
	{
		Edit.Reject(State, Child, Response);
		return;
	}
	auto Result = Target.Result(State, Child);
	Result->SetStringField(TEXT("player_node_id"), Player->NodeGuid.ToString());
	Result->SetBoolField(TEXT("initial"), bInitial);
	BuildSuccessResponse(Response, Result);
}

static void AddTransition(const FParams& Params, FParams& Response)
{
	FTarget Target;
	if (!Target.Resolve(Params, true, Response)) return;
	const FGuid FromId = GuidField(Params, TEXT("from_state_id"));
	const FGuid ToId = GuidField(Params, TEXT("to_state_id"));
	UAnimStateNode* From = nullptr;
	UAnimStateNode* To = nullptr;
	for (UEdGraphNode* Node : Target.Graph->Nodes)
	{
		if (Node && Node->NodeGuid == FromId) From = Cast<UAnimStateNode>(Node);
		if (Node && Node->NodeGuid == ToId) To = Cast<UAnimStateNode>(Node);
	}
	if (!From || !To || From == To)
	{
		BuildErrorResponse(Response, TEXT("Expected distinct source and destination states in this machine"), TEXT("INVALID_TRANSITION"));
		return;
	}
	for (UEdGraphNode* Node : Target.Graph->Nodes)
	{
		auto* Existing = Cast<UAnimStateTransitionNode>(Node);
		if (Existing && Existing->GetPreviousState() == From && Existing->GetNextState() == To)
		{
			BuildErrorResponse(Response, TEXT("Directed transition already exists"), TEXT("DUPLICATE_TRANSITION"));
			return;
		}
	}
	FString Variable, Comparison;
	double Threshold = 0.0;
	double Duration = 0.0;
	if (!Params->TryGetStringField(TEXT("variable"), Variable) || Variable.IsEmpty() || Variable.Len() >= NAME_SIZE ||
		!Params->TryGetStringField(TEXT("comparison"), Comparison) || (Comparison != TEXT("greater") && Comparison != TEXT("less")) ||
		!Params->HasTypedField<EJson::Number>(TEXT("threshold")) || !Params->TryGetNumberField(TEXT("threshold"), Threshold) || !FMath::IsFinite(Threshold) ||
		!Params->HasTypedField<EJson::Number>(TEXT("duration")) || !Params->TryGetNumberField(TEXT("duration"), Duration) ||
		!FMath::IsWithinInclusive(Duration, 0.0, double(MAX_flt)))
	{
		BuildErrorResponse(Response, TEXT("Expected a numeric member comparison, finite threshold and nonnegative blend duration"), TEXT("INVALID_PARAMS"));
		return;
	}
	const FName MemberName(*Variable, FNAME_Find);
	const int32 Index = FBlueprintEditorUtils::FindNewVariableIndex(Target.BP, MemberName);
	if (Index == INDEX_NONE || Target.BP->NewVariables[Index].VarType.PinCategory != UEdGraphSchema_K2::PC_Real ||
		Target.BP->NewVariables[Index].VarType.IsContainer())
	{
		BuildErrorResponse(Response, TEXT("Expected a float or double member of this Animation Blueprint"), TEXT("INVALID_RULE_VARIABLE"));
		return;
	}
	auto* Function = UKismetMathLibrary::StaticClass()->FindFunctionByName(Comparison == TEXT("greater") ? TEXT("Greater_DoubleDouble") : TEXT("Less_DoubleDouble"));
	if (!Function)
	{
		BuildErrorResponse(Response, TEXT("Numeric comparison unavailable in this engine"), TEXT("UNAVAILABLE_ACTION"));
		return;
	}

	FNewNodeEdit Edit(Target, NSLOCTEXT("UEMCP", "AddAnimTransition", "Add animation state transition"));
	auto* Transition = Place<UAnimStateTransitionNode>(Target.Graph, Target.Position);
	auto* Rule = Cast<UAnimationTransitionGraph>(Transition->GetBoundGraph());
	if (!Rule || !Rule->GetResultNode()) { Edit.Reject(Transition, Rule, Response); return; }
	auto* ResultPin = Rule->GetResultNode()->FindPin(TEXT("bCanEnterTransition"), EGPD_Input);
	FGraphNodeCreator<UK2Node_VariableGet> GetterCreator(*Rule);
	auto* Getter = GetterCreator.CreateNode(false);
	Getter->VariableReference.SetSelfMember(MemberName);
	Getter->NodePosX = -480;
	GetterCreator.Finalize();
	FGraphNodeCreator<UK2Node_CallFunction> CompareCreator(*Rule);
	auto* Compare = CompareCreator.CreateNode(false);
	Compare->SetFromFunction(Function);
	Compare->NodePosX = -240;
	CompareCreator.Finalize();
	auto* B = Compare->FindPin(TEXT("B"), EGPD_Input);
	if (!B || !ConnectDirect(Getter->FindPin(MemberName, EGPD_Output), Compare->FindPin(TEXT("A"), EGPD_Input)) ||
		!ConnectDirect(Compare->FindPin(UEdGraphSchema_K2::PN_ReturnValue, EGPD_Output), ResultPin))
	{
		Edit.Reject(Transition, Rule, Response);
		return;
	}
	Rule->GetSchema()->TrySetDefaultValue(*B, FString::Printf(TEXT("%.17g"), Threshold));
	double ActualThreshold = 0.0;
	if (!LexTryParseString(ActualThreshold, *B->DefaultValue) || ActualThreshold != Threshold)
	{
		Edit.Reject(Transition, Rule, Response);
		return;
	}
	Transition->CrossfadeDuration = float(Duration);
	From->Modify();
	To->Modify();
	Transition->CreateConnections(From, To);
	auto Result = Target.Result(Transition, Rule);
	Result->SetStringField(TEXT("from_state_id"), FromId.ToString());
	Result->SetStringField(TEXT("to_state_id"), ToId.ToString());
	Result->SetStringField(TEXT("rule_graph_guid"), Rule->GraphGuid.ToString());
	BuildSuccessResponse(Response, Result);
}

void Register(FMCPCommandRegistry& Registry)
{
	Registry.Register(TEXT("add_anim_state_machine"), &AddMachine);
	Registry.Register(TEXT("add_anim_state"), &AddState);
	Registry.Register(TEXT("add_anim_transition"), &AddTransition);
}
}
