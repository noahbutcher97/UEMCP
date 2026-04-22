// Copyright Optimum Athena. All Rights Reserved.
#include "GraphTraversalHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "ReflectionWalker.h"

#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "K2Node.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "MaterialGraph/MaterialGraph.h"
#include "MaterialGraph/MaterialGraphNode.h"
#include "MaterialGraph/MaterialGraphNode_Base.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	namespace
	{
		const TCHAR* PinDirectionString(EEdGraphPinDirection Dir)
		{
			switch (Dir)
			{
				case EGPD_Input:  return TEXT("EGPD_Input");
				case EGPD_Output: return TEXT("EGPD_Output");
				default:          return TEXT("EGPD_Unknown");
			}
		}

		TSharedPtr<FJsonObject> SerializeMaterialGraphNode(UEdGraphNode* Node)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Node) return Out;

			Out->SetStringField(TEXT("node_guid"),  Node->NodeGuid.ToString(EGuidFormats::Digits));
			Out->SetStringField(TEXT("class_name"), Node->GetClass()->GetName());

			// Material-specific: the wrapping UMaterialGraphNode has a MaterialExpression pointer.
			// Expose its class + display name so callers can filter without another round-trip.
			if (UMaterialGraphNode* MatNode = Cast<UMaterialGraphNode>(Node))
			{
				if (MatNode->MaterialExpression)
				{
					Out->SetStringField(TEXT("expression_class"), MatNode->MaterialExpression->GetClass()->GetName());
					Out->SetStringField(TEXT("expression_name"),  MatNode->MaterialExpression->GetName());
				}
			}

			TArray<TSharedPtr<FJsonValue>> Pins;
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin) continue;
				TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
				P->SetStringField(TEXT("pin_id"),    Pin->PinId.ToString());
				P->SetStringField(TEXT("name"),      Pin->PinName.ToString());
				P->SetStringField(TEXT("direction"), PinDirectionString(Pin->Direction));
				P->SetStringField(TEXT("pin_category"), Pin->PinType.PinCategory.ToString());

				TArray<TSharedPtr<FJsonValue>> LinkedTo;
				for (UEdGraphPin* LP : Pin->LinkedTo)
				{
					if (!LP || !LP->GetOwningNodeUnchecked()) continue;
					TSharedPtr<FJsonObject> L = MakeShared<FJsonObject>();
					L->SetStringField(TEXT("node_guid"), LP->GetOwningNodeUnchecked()->NodeGuid.ToString(EGuidFormats::Digits));
					L->SetStringField(TEXT("pin_id"),    LP->PinId.ToString());
					LinkedTo.Add(MakeShared<FJsonValueObject>(L));
				}
				P->SetArrayField(TEXT("linked_to"), LinkedTo);
				Pins.Add(MakeShared<FJsonValueObject>(P));
			}
			Out->SetArrayField(TEXT("pins"), Pins);

			return Out;
		}

		UMaterial* ResolveMaterial(const FString& Path)
		{
			if (UMaterial* Mat = LoadObject<UMaterial>(nullptr, *Path))
			{
				return Mat;
			}
			const FSoftObjectPath Soft(Path);
			if (UObject* Obj = Soft.TryLoad())
			{
				return Cast<UMaterial>(Obj);
			}
			return nullptr;
		}

		void HandleGetMaterialGraph(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_material_graph requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_material_graph requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UMaterial* Material = ResolveMaterial(AssetPath);
			if (!Material)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve UMaterial at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Cast through the editor-only wrapper graph. Material's source-of-truth is
			// Material->Expressions (the UMaterialExpression array), but the editor exposes
			// a wrapping UMaterialGraph with UEdGraphNode pins for visual editing — we walk
			// the graph form so pin/edge topology matches what the user sees in the editor.
			UMaterialGraph* Graph = Material->MaterialGraph;
			if (!Graph)
			{
				BuildErrorResponse(OutResponse,
					TEXT("Material has no editor MaterialGraph — likely cooked or stripped"),
					TEXT("NO_GRAPH"));
				return;
			}

			TArray<TSharedPtr<FJsonValue>> Nodes;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node) continue;
				Nodes.Add(MakeShared<FJsonValueObject>(SerializeMaterialGraphNode(Node)));
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),    Material->GetPathName());
			Result->SetStringField(TEXT("shape_version"), TEXT("material-graph-v1"));
			Result->SetStringField(TEXT("shape_note"),
				TEXT("Node pins are UMaterialExpression-typed (not K2Node). Pin directions and linked_to follow UEdGraphPin semantics — same as Oracle-A. Expression class/name surfaced alongside node_guid."));
			Result->SetArrayField(TEXT("nodes"), Nodes);

			BuildSuccessResponse(OutResponse, Result);
		}

		// ── Event dispatcher walker ────────────────────────────

		UBlueprint* ResolveBlueprint(const FString& Path)
		{
			if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *Path))
			{
				return BP;
			}
			const FSoftObjectPath Soft(Path);
			if (UObject* Obj = Soft.TryLoad())
			{
				return Cast<UBlueprint>(Obj);
			}
			return nullptr;
		}

		void HandleGetEventDispatchers(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_event_dispatchers requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_event_dispatchers requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UBlueprint* BP = ResolveBlueprint(AssetPath);
			if (!BP)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve UBlueprint at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Event dispatchers in BP terminology = FMulticastDelegateProperty declared as a
			// BlueprintAssignable var on the generated class. Iterate directly rather than via
			// the author-time UBlueprint::DelegateSignatureGraphs (which only covers ones with
			// visual graphs and misses inherited ones).
			UClass* GenClass = BP->GeneratedClass;
			if (!GenClass)
			{
				BuildErrorResponse(OutResponse,
					TEXT("Blueprint has no GeneratedClass — compile required before walking dispatchers"),
					TEXT("NOT_COMPILED"));
				return;
			}

			TArray<TSharedPtr<FJsonValue>> Dispatchers;
			for (TFieldIterator<FMulticastDelegateProperty> It(GenClass, EFieldIteratorFlags::IncludeSuper); It; ++It)
			{
				FMulticastDelegateProperty* DelegateProp = *It;
				if (!DelegateProp) continue;
				// Only surface Blueprint-assignable delegates — skip internal ones.
				const bool bAssignable = (DelegateProp->PropertyFlags & CPF_BlueprintAssignable) != 0;
				if (!bAssignable) continue;

				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("name"),       DelegateProp->GetName());
				Entry->SetStringField(TEXT("owner_class"), DelegateProp->GetOwnerClass() ? DelegateProp->GetOwnerClass()->GetPathName() : TEXT(""));

				// Signature parameters via the delegate's SignatureFunction.
				TArray<TSharedPtr<FJsonValue>> SigParams;
				if (UFunction* Sig = DelegateProp->SignatureFunction)
				{
					for (TFieldIterator<FProperty> PIt(Sig); PIt && (PIt->PropertyFlags & CPF_Parm) != 0; ++PIt)
					{
						SigParams.Add(MakeShared<FJsonValueObject>(SerializeProperty(*PIt)));
					}
				}
				Entry->SetArrayField(TEXT("signature_params"), SigParams);

				// Flag surface — callers may want to know if it's net-replicated etc.
				Entry->SetArrayField(TEXT("flags"), TArray<TSharedPtr<FJsonValue>>{
					MakeShared<FJsonValueString>(TEXT("BlueprintAssignable"))
				});

				Dispatchers.Add(MakeShared<FJsonValueObject>(Entry));
			}

			// Binding-site survey: scan UbergraphPages for K2Nodes that bind/unbind/call delegates.
			TArray<TSharedPtr<FJsonValue>> BindingSites;
			for (UEdGraph* Graph : BP->UbergraphPages)
			{
				if (!Graph) continue;
				for (UEdGraphNode* Node : Graph->Nodes)
				{
					if (!Node) continue;
					const FString ClassName = Node->GetClass()->GetName();
					// Simple class-name heuristic — covers K2Node_AddDelegate, K2Node_RemoveDelegate,
					// K2Node_ClearDelegate, K2Node_CallDelegate, K2Node_CreateDelegate.
					if (ClassName.Contains(TEXT("Delegate")))
					{
						TSharedPtr<FJsonObject> Site = MakeShared<FJsonObject>();
						Site->SetStringField(TEXT("node_guid"),  Node->NodeGuid.ToString(EGuidFormats::Digits));
						Site->SetStringField(TEXT("node_class"), ClassName);
						Site->SetStringField(TEXT("graph"),      Graph->GetName());
						BindingSites.Add(MakeShared<FJsonValueObject>(Site));
					}
				}
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),     BP->GetPathName());
			Result->SetArrayField(TEXT("dispatchers"),     Dispatchers);
			Result->SetArrayField(TEXT("binding_sites"),   BindingSites);
			Result->SetNumberField(TEXT("num_dispatchers"),   Dispatchers.Num());
			Result->SetNumberField(TEXT("num_binding_sites"), BindingSites.Num());

			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterGraphTraversalHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("get_material_graph"),    &HandleGetMaterialGraph);
		Registry.Register(TEXT("get_event_dispatchers"), &HandleGetEventDispatchers);
	}
}
