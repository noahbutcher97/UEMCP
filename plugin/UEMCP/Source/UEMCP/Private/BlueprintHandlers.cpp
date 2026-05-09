// Copyright Optimum Athena. All Rights Reserved.
#include "BlueprintHandlers.h"

#include "BlueprintLookupHelper.h"
#include "LoadAssetPIESafe.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "PropertyHandlerRegistry.h"
#include "TransformParser.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/PrimitiveComponent.h"
#include "Components/StaticMeshComponent.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "EditorAssetLibrary.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/StaticMesh.h"
#include "Factories/BlueprintFactory.h"
#include "GameFramework/Actor.h"
#include "GameFramework/Pawn.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_ExecutionSequence.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_Self.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Materials/MaterialInterface.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	namespace
	{
		// ── Path / lookup helpers ───────────────────────────────────────────────
		//
		// blueprint_name accepts either a bare asset name (legacy convention; kept
		// for back-compat with Epic-template-derived projects) or a fully-qualified
		// /Game/... path. Resolution is delegated to UEMCP::ResolveBlueprintAssetPath
		// which adds an AssetRegistry fallback for projects whose Blueprint content
		// tree doesn't sit under /Game/Blueprints/ (D109).

		/**
		 * Resolve blueprint_name → UBlueprint*, encoding the standard error envelope
		 * for missing/empty params and not-found / ambiguous cases. Returns nullptr
		 * on failure; caller should `return` immediately when nullptr is returned.
		 *
		 * Centralizes the most-frequent failure paths (~80% of BP-write handlers).
		 * Error codes are surfaced as-is from the resolver: BLUEPRINT_NOT_FOUND or
		 * BLUEPRINT_AMBIGUOUS. Callers that need branching can switch on the code.
		 */
		UBlueprint* ResolveBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse, FString* OutName = nullptr)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return nullptr;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return nullptr;
			}
			FString PackagePath, ResolveError, ResolveErrorCode;
			if (!ResolveBlueprintAssetPath(Name, PackagePath, ResolveError, ResolveErrorCode))
			{
				BuildErrorResponse(OutResponse, ResolveError, ResolveErrorCode);
				return nullptr;
			}
			UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *PackagePath);
			if (!BP)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Failed to load Blueprint: %s"), *PackagePath),
					TEXT("BLUEPRINT_LOAD_FAILED"));
				return nullptr;
			}
			if (OutName) *OutName = Name;
			return BP;
		}

		/** Find an SCS_Node by component variable name. nullptr on miss. */
		USCS_Node* FindSCSNode(UBlueprint* Blueprint, const FString& ComponentName)
		{
			if (!Blueprint || !Blueprint->SimpleConstructionScript) return nullptr;
			for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
			{
				if (Node && Node->GetVariableName().ToString() == ComponentName)
				{
					return Node;
				}
			}
			return nullptr;
		}

		// TryReadVector3 / TryReadRotator removed (W-E adoption — use UEMCP::ParseVector3 /
		// ParseRotator from TransformParser.h instead). Output formatters and 2D readers stay
		// local since TransformParser does input parsing only.

		/** Read [x, y] array from params; falls back to (0,0) if absent. */
		FVector2D ReadVector2DOrZero(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field)
		{
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (!Params->TryGetArrayField(Field, Arr) || Arr == nullptr || Arr->Num() < 2)
			{
				return FVector2D::ZeroVector;
			}
			return FVector2D((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber());
		}

		// ── Generic UProperty setter (delegates to PropertyHandlerRegistry — W-E adoption) ─
		//
		// Resolves the property by name, then dispatches by FProperty class via
		// FPropertyHandlerRegistry::Handle. Registry covers Int/Float/Double/Bool/Str/Name
		// scalars + Byte/Enum (oracle-parity name resolution). Same shape used by
		// SetActorPropertyValue; both call sites converged on the registry.

		bool SetUProperty(UObject* Object, const FString& PropertyName,
			const TSharedPtr<FJsonValue>& Value, FString& OutErrorMessage)
		{
			if (!Object)
			{
				OutErrorMessage = TEXT("Invalid object");
				return false;
			}
			FProperty* Property = Object->GetClass()->FindPropertyByName(*PropertyName);
			if (!Property)
			{
				OutErrorMessage = FString::Printf(TEXT("Property not found: %s"), *PropertyName);
				return false;
			}
			if (!UEMCP::FPropertyHandlerRegistry::Get().Handle(Object, Property, Value, OutErrorMessage))
			{
				if (OutErrorMessage.IsEmpty())
				{
					OutErrorMessage = FString::Printf(TEXT("Unsupported property type for '%s'"), *PropertyName);
				}
				return false;
			}
			return true;
		}

		// ── Graph helpers ────────────────────────────────────────────────────────
		//
		// Mirror UnrealMCPCommonUtils::FindOrCreateEventGraph + ConnectGraphNodes
		// + FindPin. Local copies — the oracle helpers live in a separate plugin
		// we don't link against. Behavior preserved 1:1 modulo style.

		UEdGraph* FindOrCreateEventGraph(UBlueprint* Blueprint)
		{
			if (!Blueprint) return nullptr;
			for (UEdGraph* Graph : Blueprint->UbergraphPages)
			{
				if (Graph && Graph->GetName().Contains(TEXT("EventGraph")))
				{
					return Graph;
				}
			}
			// No EventGraph yet — let the editor utility find one (creating if needed).
			return FBlueprintEditorUtils::FindEventGraph(Blueprint);
		}

		UEdGraph* FindGraphByName(UBlueprint* Blueprint, const FString& GraphName)
		{
			if (!Blueprint) return nullptr;
			auto MatchGraph = [&GraphName](UEdGraph* Graph) -> bool
			{
				return Graph && Graph->GetName().Equals(GraphName, ESearchCase::IgnoreCase);
			};
			for (UEdGraph* Graph : Blueprint->UbergraphPages)
			{
				if (MatchGraph(Graph)) return Graph;
			}
			for (UEdGraph* Graph : Blueprint->FunctionGraphs)
			{
				if (MatchGraph(Graph)) return Graph;
			}
			for (UEdGraph* Graph : Blueprint->MacroGraphs)
			{
				if (MatchGraph(Graph)) return Graph;
			}
			for (UEdGraph* Graph : Blueprint->DelegateSignatureGraphs)
			{
				if (MatchGraph(Graph)) return Graph;
			}
			return nullptr;
		}

		UEdGraph* ResolveTargetGraph(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params,
			TSharedPtr<FJsonObject>& OutResponse)
		{
			FString GraphName;
			if (!Params.IsValid() || !Params->TryGetStringField(TEXT("graph_name"), GraphName) || GraphName.IsEmpty()
				|| GraphName.Equals(TEXT("EventGraph"), ESearchCase::IgnoreCase))
			{
				UEdGraph* EventGraph = FindOrCreateEventGraph(Blueprint);
				if (!EventGraph)
				{
					BuildErrorResponse(OutResponse, TEXT("Failed to get event graph"), TEXT("NO_GRAPH"));
				}
				return EventGraph;
			}

			UEdGraph* Graph = FindGraphByName(Blueprint, GraphName);
			if (!Graph)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Blueprint graph not found: %s"), *GraphName),
					TEXT("GRAPH_NOT_FOUND"));
			}
			return Graph;
		}

		FString PinDirectionToString(EEdGraphPinDirection Direction)
		{
			return Direction == EGPD_Input ? TEXT("input") : TEXT("output");
		}

		TSharedPtr<FJsonObject> PinTypeToJson(const FEdGraphPinType& PinType)
		{
			TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
			Obj->SetStringField(TEXT("category"), PinType.PinCategory.ToString());
			Obj->SetStringField(TEXT("subcategory"), PinType.PinSubCategory.ToString());
			Obj->SetStringField(TEXT("container"), UEdGraphSchema_K2::TypeToText(PinType).ToString());
			if (PinType.PinSubCategoryObject.IsValid())
			{
				Obj->SetStringField(TEXT("subcategory_object"), PinType.PinSubCategoryObject->GetName());
			}
			return Obj;
		}

		TSharedPtr<FJsonObject> PinToJson(const UEdGraphPin* Pin)
		{
			TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
			if (!Pin) return Obj;
			Obj->SetStringField(TEXT("pin_id"), Pin->PinId.ToString());
			Obj->SetStringField(TEXT("name"), Pin->PinName.ToString());
			Obj->SetStringField(TEXT("direction"), PinDirectionToString(Pin->Direction));
			Obj->SetStringField(TEXT("category"), Pin->PinType.PinCategory.ToString());
			Obj->SetStringField(TEXT("subcategory"), Pin->PinType.PinSubCategory.ToString());
			if (Pin->PinType.PinSubCategoryObject.IsValid())
			{
				Obj->SetStringField(TEXT("subcategory_object"), Pin->PinType.PinSubCategoryObject->GetName());
			}
			Obj->SetStringField(TEXT("default"), Pin->DefaultValue);
			if (Pin->DefaultObject)
			{
				Obj->SetStringField(TEXT("default_object"), Pin->DefaultObject->GetPathName());
			}
			Obj->SetNumberField(TEXT("link_count"), Pin->LinkedTo.Num());
			return Obj;
		}

		TArray<TSharedPtr<FJsonValue>> PinsToJson(const UEdGraphNode* Node)
		{
			TArray<TSharedPtr<FJsonValue>> Pins;
			if (!Node) return Pins;
			for (const UEdGraphPin* Pin : Node->Pins)
			{
				Pins.Add(MakeShared<FJsonValueObject>(PinToJson(Pin)));
			}
			return Pins;
		}

		TSharedPtr<FJsonObject> NodeResultToJson(const UEdGraphNode* Node, const UEdGraph* Graph)
		{
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			if (!Node) return Result;
			Result->SetStringField(TEXT("node_id"), Node->NodeGuid.ToString());
			Result->SetStringField(TEXT("node_class"), Node->GetClass()->GetName());
			if (Graph)
			{
				Result->SetStringField(TEXT("graph_name"), Graph->GetName());
			}
			Result->SetArrayField(TEXT("pins"), PinsToJson(Node));
			return Result;
		}

		UEdGraphNode* FindNodeByGuid(UEdGraph* Graph, const FString& NodeId)
		{
			if (!Graph) return nullptr;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (Node && Node->NodeGuid.ToString() == NodeId)
				{
					return Node;
				}
			}
			return nullptr;
		}

		bool HasBlueprintMemberVariable(UBlueprint* Blueprint, const FString& VarName)
		{
			if (!Blueprint || VarName.IsEmpty()) return false;
			const FName Name(*VarName);
			for (const FBPVariableDescription& Var : Blueprint->NewVariables)
			{
				if (Var.VarName == Name)
				{
					return true;
				}
			}
			return Blueprint->GeneratedClass && Blueprint->GeneratedClass->FindPropertyByName(Name) != nullptr;
		}

		bool ResolveMathFunctionName(const FString& Operation, const FString& ValueType, FString& OutFunctionName)
		{
			const FString Op = Operation.ToLower();
			const FString Type = ValueType.IsEmpty() ? TEXT("Float") : ValueType;
			if (Op == TEXT("makevector"))
			{
				OutFunctionName = TEXT("MakeVector");
				return true;
			}
			if (Op == TEXT("breakvector"))
			{
				OutFunctionName = TEXT("BreakVector");
				return true;
			}
			if (Op == TEXT("scalevector"))
			{
				OutFunctionName = TEXT("Multiply_VectorFloat");
				return true;
			}

			FString Suffix;
			if (Type.Equals(TEXT("Int"), ESearchCase::IgnoreCase) || Type.Equals(TEXT("Integer"), ESearchCase::IgnoreCase))
			{
				Suffix = TEXT("_IntInt");
			}
			else if (Type.Equals(TEXT("Vector"), ESearchCase::IgnoreCase))
			{
				Suffix = TEXT("_VectorVector");
			}
			else
			{
				Suffix = TEXT("_DoubleDouble");
			}

			if (Op == TEXT("add")) OutFunctionName = TEXT("Add") + Suffix;
			else if (Op == TEXT("subtract")) OutFunctionName = TEXT("Subtract") + Suffix;
			else if (Op == TEXT("multiply")) OutFunctionName = TEXT("Multiply") + Suffix;
			else if (Op == TEXT("less")) OutFunctionName = TEXT("Less") + Suffix;
			else if (Op == TEXT("greater")) OutFunctionName = TEXT("Greater") + Suffix;
			else if (Op == TEXT("lessequal")) OutFunctionName = TEXT("LessEqual") + Suffix;
			else if (Op == TEXT("greaterequal")) OutFunctionName = TEXT("GreaterEqual") + Suffix;
			else return false;

			if (Type.Equals(TEXT("Vector"), ESearchCase::IgnoreCase)
				&& !(Op == TEXT("add") || Op == TEXT("subtract") || Op == TEXT("multiply")))
			{
				return false;
			}
			return true;
		}

		/**
		 * Resolve a pin by name with oracle's 3-tier fallback:
		 * 1) exact match (case-sensitive)
		 * 2) case-insensitive match
		 * 3) first non-exec output pin (only for VariableGet output direction)
		 */
		UEdGraphPin* FindPin(UEdGraphNode* Node, const FString& PinName, EEdGraphPinDirection Direction)
		{
			if (!Node) return nullptr;
			// Tier 1 — exact match
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (Pin && Pin->Direction == Direction && Pin->PinName.ToString() == PinName)
				{
					return Pin;
				}
			}
			// Tier 2 — case-insensitive
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (Pin && Pin->Direction == Direction && Pin->PinName.ToString().Equals(PinName, ESearchCase::IgnoreCase))
				{
					return Pin;
				}
			}
			// Tier 3 — first non-exec output for VariableGet (oracle parity)
			if (Direction == EGPD_Output && Node->IsA<UK2Node_VariableGet>())
			{
				for (UEdGraphPin* Pin : Node->Pins)
				{
					if (Pin && Pin->Direction == EGPD_Output && Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec)
					{
						return Pin;
					}
				}
			}
			return nullptr;
		}

		/**
		 * Apply pin default values from a JSON object — mirrors oracle's
		 * add_blueprint_function_node pin-default coercion (Section 3.4).
		 * Quietly skips pins not found (oracle warns then continues).
		 */
		void ApplyNodePinDefaults(UEdGraphNode* Node, UEdGraph* Graph,
			const TSharedPtr<FJsonObject>& ParamsObj)
		{
			if (!Node || !ParamsObj.IsValid()) return;
			const UEdGraphSchema_K2* K2Schema = Cast<const UEdGraphSchema_K2>(Graph ? Graph->GetSchema() : nullptr);

			for (const TPair<FString, TSharedPtr<FJsonValue>>& Param : ParamsObj->Values)
			{
				const FString& PinName = Param.Key;
				const TSharedPtr<FJsonValue>& PinValue = Param.Value;
				UEdGraphPin* Pin = FindPin(Node, PinName, EGPD_Input);
				if (!Pin) continue;

				// Class reference — only meaningful when value is a string.
				if (PinValue->Type == EJson::String && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Class)
				{
					const FString ClassName = PinValue->AsString();
					UClass* Class = LoadObject<UClass>(nullptr, *ClassName);
					if (!Class)
					{
						const FString EngineClassName = FString::Printf(TEXT("/Script/Engine.%s"), *ClassName);
						Class = LoadObject<UClass>(nullptr, *EngineClassName);
					}
					if (Class && K2Schema)
					{
						K2Schema->TrySetDefaultObject(*Pin, Class);
					}
					continue;
				}

				// Vector struct — array of 3 numbers → "(X=..,Y=..,Z=..)".
				if (PinValue->Type == EJson::Array && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Struct
					&& Pin->PinType.PinSubCategoryObject == TBaseStructure<FVector>::Get())
				{
					const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
					if (PinValue->TryGetArray(Arr) && Arr && Arr->Num() == 3)
					{
						const float X = (*Arr)[0]->AsNumber();
						const float Y = (*Arr)[1]->AsNumber();
						const float Z = (*Arr)[2]->AsNumber();
						Pin->DefaultValue = FString::Printf(TEXT("(X=%f,Y=%f,Z=%f)"), X, Y, Z);
					}
					continue;
				}

				// Scalar coercions by pin category.
				if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Int)
				{
					Pin->DefaultValue = FString::FromInt(FMath::RoundToInt(PinValue->AsNumber()));
				}
				else if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Float
					|| Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Real)
				{
					Pin->DefaultValue = FString::SanitizeFloat(PinValue->AsNumber());
				}
				else if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Boolean)
				{
					Pin->DefaultValue = PinValue->AsBool() ? TEXT("true") : TEXT("false");
				}
				else if (PinValue->Type == EJson::String)
				{
					Pin->DefaultValue = PinValue->AsString();
				}
			}
		}

		/**
		 * Find an existing UK2Node_Event in Graph whose member name matches EventName.
		 * Oracle uses this for dedup before creating a new event node.
		 */
		UK2Node_Event* FindExistingEventNode(UEdGraph* Graph, const FString& EventName)
		{
			if (!Graph) return nullptr;
			const FName Member(*EventName);
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_Event* Ev = Cast<UK2Node_Event>(Node))
				{
					if (Ev->EventReference.GetMemberName() == Member)
					{
						return Ev;
					}
				}
			}
			return nullptr;
		}

		// ═══════════════════════════════════════════════════════════════════════
		// Handlers
		// ═══════════════════════════════════════════════════════════════════════

		// ── 1. create_blueprint ──────────────────────────────────────────────────
		void HandleCreateBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_blueprint requires params.name"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			// §4: optional `path` override (mirrors create_montage / create_material).
			// Default `/Game/Blueprints/` preserves pre-§4 callers; trailing slash
			// normalized so callers passing either form land at the same location.
			FString PackagePath;
			if (!Params->TryGetStringField(TEXT("path"), PackagePath) || PackagePath.IsEmpty())
			{
				PackagePath = TEXT("/Game/Blueprints/");
			}
			if (!PackagePath.EndsWith(TEXT("/")))
			{
				PackagePath += TEXT("/");
			}
			if (UEditorAssetLibrary::DoesAssetExist(PackagePath + Name))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Blueprint already exists: %s"), *Name),
					TEXT("BLUEPRINT_EXISTS"));
				return;
			}

			// Resolve parent class with oracle's auto-A-prefix + Engine/Game module fallbacks.
			// W-G (D144): pre-fold this silently fell back to AActor on a miss
			// — Gauntlet Finding 5.2 + Pattern P2 silent-success-on-edge-case.
			// We now error explicitly when parent_class is provided but unresolvable.
			// parent_class omitted still defaults to AActor (documented behavior).
			UClass* ParentClass = AActor::StaticClass();
			FString ParentName;
			if (Params->TryGetStringField(TEXT("parent_class"), ParentName) && !ParentName.IsEmpty())
			{
				FString ClassName = ParentName;
				if (!ClassName.StartsWith(TEXT("A")))
				{
					ClassName = TEXT("A") + ClassName;
				}
				UClass* Found = nullptr;
				if (ClassName == TEXT("APawn"))      Found = APawn::StaticClass();
				else if (ClassName == TEXT("AActor")) Found = AActor::StaticClass();
				else
				{
					const FString EnginePath = FString::Printf(TEXT("/Script/Engine.%s"), *ClassName);
					Found = LoadClass<AActor>(nullptr, *EnginePath);
					if (!Found)
					{
						const FString GamePath = FString::Printf(TEXT("/Script/Game.%s"), *ClassName);
						Found = LoadClass<AActor>(nullptr, *GamePath);
					}
				}
				if (Found)
				{
					ParentClass = Found;
				}
				else
				{
					TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
					TArray<TSharedPtr<FJsonValue>> AllowedExamples;
					AllowedExamples.Add(MakeShared<FJsonValueString>(TEXT("Pawn")));
					AllowedExamples.Add(MakeShared<FJsonValueString>(TEXT("Actor")));
					AllowedExamples.Add(MakeShared<FJsonValueString>(TEXT("Character")));
					AllowedExamples.Add(MakeShared<FJsonValueString>(TEXT("PlayerController")));
					Detail->SetArrayField (TEXT("allowed_examples"), AllowedExamples);
					Detail->SetStringField(TEXT("provided"),         ParentName);
					Detail->SetStringField(TEXT("attempted_paths"),
						FString::Printf(TEXT("/Script/Engine.%s, /Script/Game.%s"), *ClassName, *ClassName));
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("Unknown parent_class: %s (engine + game module lookups failed)"), *ParentName),
						TEXT("INVALID_PARENT_CLASS"),
						Detail);
					return;
				}
			}

			UBlueprintFactory* Factory = NewObject<UBlueprintFactory>();
			Factory->ParentClass = ParentClass;

			UPackage* Package = CreatePackage(*(PackagePath + Name));
			UBlueprint* NewBP = Cast<UBlueprint>(Factory->FactoryCreateNew(
				UBlueprint::StaticClass(), Package, *Name,
				RF_Standalone | RF_Public, nullptr, GWarn));
			if (!NewBP)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create blueprint"), TEXT("CREATE_FAILED"));
				return;
			}

			FAssetRegistryModule::AssetCreated(NewBP);
			Package->MarkPackageDirty();

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), Name);
			Result->SetStringField(TEXT("path"), PackagePath + Name);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 2. add_component_to_blueprint ─────────────────────────────────────────
		void HandleAddComponentToBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString BPName;
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse, &BPName);
			if (!Blueprint) return;

			FString ComponentType, ComponentName;
			if (!Params->TryGetStringField(TEXT("component_type"), ComponentType))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'component_type' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("component_name"), ComponentName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'component_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			// Flexible class resolution — exact, +Component suffix, U+ prefix, U+name+Component.
			UClass* ComponentClass = LoadClass<UActorComponent>(nullptr, *ComponentType);
			if (!ComponentClass)
			{
				ComponentClass = FindObject<UClass>(nullptr, *ComponentType);
			}
			if (!ComponentClass && !ComponentType.EndsWith(TEXT("Component")))
			{
				const FString WithSuffix = ComponentType + TEXT("Component");
				ComponentClass = FindObject<UClass>(nullptr, *WithSuffix);
				if (!ComponentClass)
				{
					ComponentClass = LoadClass<UActorComponent>(nullptr,
						*FString::Printf(TEXT("/Script/Engine.%s"), *WithSuffix));
				}
			}
			if (!ComponentClass && !ComponentType.StartsWith(TEXT("U")))
			{
				const FString WithPrefix = TEXT("U") + ComponentType;
				ComponentClass = FindObject<UClass>(nullptr, *WithPrefix);
				if (!ComponentClass && !ComponentType.EndsWith(TEXT("Component")))
				{
					const FString Both = TEXT("U") + ComponentType + TEXT("Component");
					ComponentClass = FindObject<UClass>(nullptr, *Both);
				}
			}

			if (!ComponentClass || !ComponentClass->IsChildOf(UActorComponent::StaticClass()))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown component type: %s"), *ComponentType),
					TEXT("UNKNOWN_COMPONENT_TYPE"));
				return;
			}

			USCS_Node* NewNode = Blueprint->SimpleConstructionScript->CreateNode(ComponentClass, *ComponentName);
			if (!NewNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to add component to blueprint"), TEXT("CREATE_FAILED"));
				return;
			}

			// Apply transform if the template is a SceneComponent.
			if (USceneComponent* SceneComp = Cast<USceneComponent>(NewNode->ComponentTemplate))
			{
				FVector Loc(0.0f), Scale(1.0f);
				FRotator Rot(0.0f);
				FString TransformErr;
				if (Params->HasField(TEXT("location")) && UEMCP::ParseVector3(Params, TEXT("location"), Loc, TransformErr))
					SceneComp->SetRelativeLocation(Loc);
				if (Params->HasField(TEXT("rotation")) && UEMCP::ParseRotator(Params, TEXT("rotation"), Rot, TransformErr))
					SceneComp->SetRelativeRotation(Rot);
				if (Params->HasField(TEXT("scale")) && UEMCP::ParseVector3(Params, TEXT("scale"), Scale, TransformErr))
					SceneComp->SetRelativeScale3D(Scale);
			}

			Blueprint->SimpleConstructionScript->AddNode(NewNode);
			// Oracle parity: auto-compile after adding (gotcha documented in tools.yaml).
			FKismetEditorUtilities::CompileBlueprint(Blueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("component_name"), ComponentName);
			Result->SetStringField(TEXT("component_type"), ComponentType);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 3. set_component_property ─────────────────────────────────────────────
		void HandleSetComponentProperty(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString ComponentName, PropertyName;
			if (!Params->TryGetStringField(TEXT("component_name"), ComponentName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'component_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("property_name"), PropertyName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'property_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->HasField(TEXT("property_value")))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'property_value' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			USCS_Node* Node = FindSCSNode(Blueprint, ComponentName);
			if (!Node || !Node->ComponentTemplate)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Component not found: %s"), *ComponentName),
					TEXT("COMPONENT_NOT_FOUND"));
				return;
			}
			UObject* Template = Node->ComponentTemplate;
			TSharedPtr<FJsonValue> Value = Params->Values.FindRef(TEXT("property_value"));
			FProperty* Property = FindFProperty<FProperty>(Template->GetClass(), *PropertyName);
			if (!Property)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Property %s not found on component %s"), *PropertyName, *ComponentName),
					TEXT("PROPERTY_NOT_FOUND"));
				return;
			}

			Template->Modify();
			bool bSuccess = false;
			FString Err;

			// Vector struct (with scalar broadcast) — keep oracle behavior.
			if (FStructProperty* StructProp = CastField<FStructProperty>(Property))
			{
				if (StructProp->Struct == TBaseStructure<FVector>::Get())
				{
					if (Value->Type == EJson::Array)
					{
						const TArray<TSharedPtr<FJsonValue>>& Arr = Value->AsArray();
						if (Arr.Num() == 3)
						{
							FVector Vec(Arr[0]->AsNumber(), Arr[1]->AsNumber(), Arr[2]->AsNumber());
							StructProp->CopySingleValue(StructProp->ContainerPtrToValuePtr<void>(Template), &Vec);
							bSuccess = true;
						}
						else
						{
							Err = FString::Printf(TEXT("Vector property requires 3 values, got %d"), Arr.Num());
						}
					}
					else if (Value->Type == EJson::Number)
					{
						const float V = Value->AsNumber();
						FVector Vec(V, V, V);
						StructProp->CopySingleValue(StructProp->ContainerPtrToValuePtr<void>(Template), &Vec);
						bSuccess = true;
					}
					else
					{
						Err = TEXT("Vector property requires either a single number or array of 3 numbers");
					}
				}
				else if (StructProp->Struct == TBaseStructure<FRotator>::Get() && Value->Type == EJson::Array)
				{
					const TArray<TSharedPtr<FJsonValue>>& Arr = Value->AsArray();
					if (Arr.Num() == 3)
					{
						FRotator Rot(Arr[0]->AsNumber(), Arr[1]->AsNumber(), Arr[2]->AsNumber());
						StructProp->CopySingleValue(StructProp->ContainerPtrToValuePtr<void>(Template), &Rot);
						bSuccess = true;
					}
					else
					{
						Err = FString::Printf(TEXT("Rotator property requires 3 values, got %d"), Arr.Num());
					}
				}
				else
				{
					bSuccess = SetUProperty(Template, PropertyName, Value, Err);
				}
			}
			else
			{
				bSuccess = SetUProperty(Template, PropertyName, Value, Err);
			}

			Template->PostEditChange();

			if (!bSuccess)
			{
				BuildErrorResponse(OutResponse, Err, TEXT("PROPERTY_SET_FAILED"));
				return;
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("component"), ComponentName);
			Result->SetStringField(TEXT("property"), PropertyName);
			Result->SetBoolField(TEXT("success"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 4. compile_blueprint ──────────────────────────────────────────────────
		void HandleCompileBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString BPName;
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse, &BPName);
			if (!Blueprint) return;

			FKismetEditorUtilities::CompileBlueprint(Blueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), BPName);
			Result->SetBoolField(TEXT("compiled"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 5. set_blueprint_property ─────────────────────────────────────────────
		void HandleSetBlueprintProperty(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString PropertyName;
			if (!Params->TryGetStringField(TEXT("property_name"), PropertyName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'property_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->HasField(TEXT("property_value")))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'property_value' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			UObject* CDO = Blueprint->GeneratedClass ? Blueprint->GeneratedClass->GetDefaultObject() : nullptr;
			if (!CDO)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get default object"), TEXT("NO_CDO"));
				return;
			}
			TSharedPtr<FJsonValue> Value = Params->Values.FindRef(TEXT("property_value"));
			FString Err;
			if (!SetUProperty(CDO, PropertyName, Value, Err))
			{
				BuildErrorResponse(OutResponse, Err, TEXT("PROPERTY_SET_FAILED"));
				return;
			}

			// D99 #6: fire PostEditChangeProperty so listeners (RC handles,
			// AssetRegistry tag cache, BP-instancing graph) bust caches before
			// any subsequent cross-transport read. SetUProperty writes raw
			// memory; without this broadcast, RC HTTP READ_ACCESS observes the
			// pre-edit value via cached property handles.
			if (FProperty* Property = CDO->GetClass()->FindPropertyByName(*PropertyName))
			{
				FPropertyChangedEvent Event(Property, EPropertyChangeType::ValueSet);
				CDO->PostEditChangeProperty(Event);
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("property"), PropertyName);
			Result->SetBoolField(TEXT("success"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 6. set_static_mesh_properties ─────────────────────────────────────────
		void HandleSetStaticMeshProperties(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString ComponentName;
			if (!Params->TryGetStringField(TEXT("component_name"), ComponentName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'component_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			USCS_Node* Node = FindSCSNode(Blueprint, ComponentName);
			if (!Node)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Component not found: %s"), *ComponentName),
					TEXT("COMPONENT_NOT_FOUND"));
				return;
			}
			UStaticMeshComponent* MeshComp = Cast<UStaticMeshComponent>(Node->ComponentTemplate);
			if (!MeshComp)
			{
				BuildErrorResponse(OutResponse, TEXT("Component is not a static mesh component"), TEXT("WRONG_COMPONENT_TYPE"));
				return;
			}

			FString MeshPath, MaterialPath;
			if (Params->TryGetStringField(TEXT("static_mesh"), MeshPath) && !MeshPath.IsEmpty())
			{
				// §4.5: PIE-safe asset load (D99 #3 generalization).
				if (UStaticMesh* Mesh = UEMCP::LoadAssetPIESafe<UStaticMesh>(MeshPath))
				{
					MeshComp->SetStaticMesh(Mesh);
				}
			}
			if (Params->TryGetStringField(TEXT("material"), MaterialPath) && !MaterialPath.IsEmpty())
			{
				// §4.5: PIE-safe asset load (D99 #3 generalization).
				if (UMaterialInterface* Mat = UEMCP::LoadAssetPIESafe<UMaterialInterface>(MaterialPath))
				{
					MeshComp->SetMaterial(0, Mat);
				}
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("component"), ComponentName);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 7. set_physics_properties ─────────────────────────────────────────────
		void HandleSetPhysicsProperties(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString ComponentName;
			if (!Params->TryGetStringField(TEXT("component_name"), ComponentName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'component_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			USCS_Node* Node = FindSCSNode(Blueprint, ComponentName);
			if (!Node)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Component not found: %s"), *ComponentName),
					TEXT("COMPONENT_NOT_FOUND"));
				return;
			}
			UPrimitiveComponent* PrimComp = Cast<UPrimitiveComponent>(Node->ComponentTemplate);
			if (!PrimComp)
			{
				BuildErrorResponse(OutResponse, TEXT("Component is not a primitive component"), TEXT("WRONG_COMPONENT_TYPE"));
				return;
			}

			if (Params->HasField(TEXT("simulate_physics")))
			{
				PrimComp->SetSimulatePhysics(Params->GetBoolField(TEXT("simulate_physics")));
			}
			if (Params->HasField(TEXT("mass")))
			{
				PrimComp->SetMassOverrideInKg(NAME_None, Params->GetNumberField(TEXT("mass")));
			}
			if (Params->HasField(TEXT("linear_damping")))
			{
				PrimComp->SetLinearDamping(Params->GetNumberField(TEXT("linear_damping")));
			}
			if (Params->HasField(TEXT("angular_damping")))
			{
				PrimComp->SetAngularDamping(Params->GetNumberField(TEXT("angular_damping")));
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("component"), ComponentName);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 8. set_pawn_properties (per-property results, partial-success aware) ──
		void HandleSetPawnProperties(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString BPName;
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse, &BPName);
			if (!Blueprint) return;

			UObject* CDO = Blueprint->GeneratedClass ? Blueprint->GeneratedClass->GetDefaultObject() : nullptr;
			if (!CDO)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get default object"), TEXT("NO_CDO"));
				return;
			}

			TSharedPtr<FJsonObject> Results = MakeShared<FJsonObject>();
			bool bAnySet = false;

			auto TrySetMapped = [&](const TCHAR* JsonField, const TCHAR* PropName)
			{
				if (!Params->HasField(JsonField)) return;
				TSharedPtr<FJsonValue> V = Params->Values.FindRef(JsonField);
				FString Err;
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				if (SetUProperty(CDO, PropName, V, Err))
				{
					bAnySet = true;
					// D99 #6: per-property PostEditChangeProperty broadcast.
					if (FProperty* Property = CDO->GetClass()->FindPropertyByName(PropName))
					{
						FPropertyChangedEvent Event(Property, EPropertyChangeType::ValueSet);
						CDO->PostEditChangeProperty(Event);
					}
					Entry->SetBoolField(TEXT("success"), true);
				}
				else
				{
					Entry->SetBoolField(TEXT("success"), false);
					Entry->SetStringField(TEXT("error"), Err);
				}
				Results->SetObjectField(PropName, Entry);
			};

			TrySetMapped(TEXT("auto_possess_player"),           TEXT("AutoPossessPlayer"));
			TrySetMapped(TEXT("use_controller_rotation_yaw"),   TEXT("bUseControllerRotationYaw"));
			TrySetMapped(TEXT("use_controller_rotation_pitch"), TEXT("bUseControllerRotationPitch"));
			TrySetMapped(TEXT("use_controller_rotation_roll"),  TEXT("bUseControllerRotationRoll"));
			TrySetMapped(TEXT("can_be_damaged"),                TEXT("bCanBeDamaged"));

			if (Results->Values.Num() == 0)
			{
				BuildErrorResponse(OutResponse, TEXT("No properties specified to set"), TEXT("NO_PROPERTIES"));
				return;
			}
			if (bAnySet)
			{
				FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("blueprint"), BPName);
			Result->SetBoolField(TEXT("success"), bAnySet);
			Result->SetObjectField(TEXT("results"), Results);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 9. add_blueprint_event_node ───────────────────────────────────────────
		void HandleAddBlueprintEventNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString EventName;
			if (!Params->TryGetStringField(TEXT("event_name"), EventName) || EventName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'event_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));

			UEdGraph* EventGraph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!EventGraph) return;

			// Dedup: return existing event GUID if one already exists for this name.
			if (UK2Node_Event* Existing = FindExistingEventNode(EventGraph, EventName))
			{
				TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
				Result->SetStringField(TEXT("node_id"), Existing->NodeGuid.ToString());
				Result->SetStringField(TEXT("graph_name"), EventGraph->GetName());
				Result->SetStringField(TEXT("node_class"), Existing->GetClass()->GetName());
				Result->SetArrayField(TEXT("pins"), PinsToJson(Existing));
				BuildSuccessResponse(OutResponse, Result);
				return;
			}

			// Create new event node — resolve the function on the BP's generated class.
			UFunction* EventFunc = Blueprint->GeneratedClass
				? Blueprint->GeneratedClass->FindFunctionByName(*EventName)
				: nullptr;

			UK2Node_Event* EventNode = NewObject<UK2Node_Event>(EventGraph);
			if (!EventNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create event node"), TEXT("CREATE_FAILED"));
				return;
			}
			if (EventFunc)
			{
				EventNode->EventReference.SetFromField<UFunction>(EventFunc, /*bIsConsideredSelfContext=*/true);
			}
			else
			{
				EventNode->EventReference.SetExternalMember(*EventName, AActor::StaticClass());
			}
			EventNode->bOverrideFunction = true;
			EventNode->NodePosX = NodePos.X;
			EventNode->NodePosY = NodePos.Y;
			EventGraph->AddNode(EventNode);
			EventNode->CreateNewGuid();
			EventNode->PostPlacedNewNode();
			EventNode->AllocateDefaultPins();

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(EventNode, EventGraph));
		}

		// ── 10. add_blueprint_function_node ───────────────────────────────────────
		void HandleAddBlueprintFunctionNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString FunctionName;
			if (!Params->TryGetStringField(TEXT("function_name"), FunctionName) || FunctionName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'function_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));
			FString Target;
			Params->TryGetStringField(TEXT("target"), Target);

			UEdGraph* EventGraph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!EventGraph) return;

			// Resolve target class — try as-is, U-prefixed, common Engine paths.
			UClass* TargetClass = nullptr;
			if (!Target.IsEmpty())
			{
				TargetClass = FindObject<UClass>(nullptr, *Target);
				if (!TargetClass && !Target.StartsWith(TEXT("U")))
				{
					TargetClass = FindObject<UClass>(nullptr, *(TEXT("U") + Target));
				}
				if (!TargetClass)
				{
					TargetClass = LoadClass<UObject>(nullptr,
						*FString::Printf(TEXT("/Script/Engine.%s"), *Target));
				}
			}

			// Resolve the UFunction — walk the target class hierarchy or the BP class.
			UFunction* Function = nullptr;
			// Blueprint->GeneratedClass is TSubclassOf<UObject> in UE 5.6;
			// .Get() to UClass* so the ternary types match TargetClass (UClass*).
			UClass* SearchClass = TargetClass ? TargetClass : Blueprint->GeneratedClass.Get();
			while (SearchClass && !Function)
			{
				Function = SearchClass->FindFunctionByName(*FunctionName);
				if (!Function)
				{
					for (TFieldIterator<UFunction> It(SearchClass); It; ++It)
					{
						if (It->GetName().Equals(FunctionName, ESearchCase::IgnoreCase))
						{
							Function = *It;
							break;
						}
					}
				}
				SearchClass = SearchClass->GetSuperClass();
			}

			if (!Function)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Function not found: %s in target %s"),
						*FunctionName, Target.IsEmpty() ? TEXT("Blueprint") : *Target),
					TEXT("FUNCTION_NOT_FOUND"));
				return;
			}

			UK2Node_CallFunction* FuncNode = NewObject<UK2Node_CallFunction>(EventGraph);
			if (!FuncNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create function call node"), TEXT("CREATE_FAILED"));
				return;
			}
			FuncNode->FunctionReference.SetExternalMember(Function->GetFName(), Function->GetOwnerClass());
			FuncNode->NodePosX = NodePos.X;
			FuncNode->NodePosY = NodePos.Y;
			EventGraph->AddNode(FuncNode);
			FuncNode->CreateNewGuid();
			FuncNode->PostPlacedNewNode();
			FuncNode->AllocateDefaultPins();

			// Apply pin defaults if a `params` object was provided.
			const TSharedPtr<FJsonObject>* PinDefaults = nullptr;
			if (Params->TryGetObjectField(TEXT("params"), PinDefaults) && PinDefaults && PinDefaults->IsValid())
			{
				ApplyNodePinDefaults(FuncNode, EventGraph, *PinDefaults);
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(FuncNode, EventGraph));
		}

		// ── 11. add_blueprint_variable ────────────────────────────────────────────
		void HandleAddBlueprintVariable(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString VarName, VarType;
			if (!Params->TryGetStringField(TEXT("variable_name"), VarName) || VarName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'variable_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("variable_type"), VarType) || VarType.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'variable_type' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			bool bExposed = false;
			if (Params->HasField(TEXT("is_exposed")))
			{
				bExposed = Params->GetBoolField(TEXT("is_exposed"));
			}

			FEdGraphPinType PinType;
			if (VarType == TEXT("Boolean"))
			{
				PinType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
			}
			else if (VarType == TEXT("Integer") || VarType == TEXT("Int"))
			{
				PinType.PinCategory = UEdGraphSchema_K2::PC_Int;
			}
			else if (VarType == TEXT("Float"))
			{
				PinType.PinCategory = UEdGraphSchema_K2::PC_Real;
				PinType.PinSubCategory = UEdGraphSchema_K2::PC_Float;
			}
			else if (VarType == TEXT("String"))
			{
				PinType.PinCategory = UEdGraphSchema_K2::PC_String;
			}
			else if (VarType == TEXT("Vector"))
			{
				PinType.PinCategory = UEdGraphSchema_K2::PC_Struct;
				PinType.PinSubCategoryObject = TBaseStructure<FVector>::Get();
			}
			else
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unsupported variable type: %s"), *VarType),
					TEXT("UNSUPPORTED_TYPE"));
				return;
			}

			FBlueprintEditorUtils::AddMemberVariable(Blueprint, FName(*VarName), PinType);

			if (bExposed)
			{
				for (FBPVariableDescription& Var : Blueprint->NewVariables)
				{
					if (Var.VarName == FName(*VarName))
					{
						Var.PropertyFlags |= CPF_Edit;
						break;
					}
				}
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("variable_name"), VarName);
			Result->SetStringField(TEXT("variable_type"), VarType);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleAddBlueprintFunctionGraph(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString FunctionName;
			if (!Params->TryGetStringField(TEXT("function_name"), FunctionName) || FunctionName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'function_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			if (UEdGraph* Existing = FindGraphByName(Blueprint, FunctionName))
			{
				TArray<UK2Node_FunctionEntry*> EntryNodes;
				Existing->GetNodesOfClass<UK2Node_FunctionEntry>(EntryNodes);
				TSharedPtr<FJsonObject> Result = EntryNodes.Num() > 0
					? NodeResultToJson(EntryNodes[0], Existing)
					: MakeShared<FJsonObject>();
				Result->SetStringField(TEXT("function_name"), FunctionName);
				Result->SetStringField(TEXT("graph_name"), Existing->GetName());
				Result->SetBoolField(TEXT("created"), false);
				BuildSuccessResponse(OutResponse, Result);
				return;
			}

			UEdGraph* FunctionGraph = FBlueprintEditorUtils::CreateNewGraph(
				Blueprint,
				FName(*FunctionName),
				UEdGraph::StaticClass(),
				UEdGraphSchema_K2::StaticClass());
			if (!FunctionGraph)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create function graph"), TEXT("CREATE_FAILED"));
				return;
			}
			FBlueprintEditorUtils::AddFunctionGraph<UClass>(Blueprint, FunctionGraph, false, nullptr);

			TArray<UK2Node_FunctionEntry*> EntryNodes;
			FunctionGraph->GetNodesOfClass<UK2Node_FunctionEntry>(EntryNodes);
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

			TSharedPtr<FJsonObject> Result = EntryNodes.Num() > 0
				? NodeResultToJson(EntryNodes[0], FunctionGraph)
				: MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("function_name"), FunctionName);
			Result->SetStringField(TEXT("graph_name"), FunctionGraph->GetName());
			Result->SetBoolField(TEXT("created"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleAddBlueprintVariableGetNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString VarName;
			if (!Params->TryGetStringField(TEXT("variable_name"), VarName) || VarName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'variable_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!HasBlueprintMemberVariable(Blueprint, VarName))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Blueprint member variable not found: %s"), *VarName),
					TEXT("VARIABLE_NOT_FOUND"));
				return;
			}
			UEdGraph* Graph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!Graph) return;
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));

			UK2Node_VariableGet* GetNode = NewObject<UK2Node_VariableGet>(Graph);
			if (!GetNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create variable get node"), TEXT("CREATE_FAILED"));
				return;
			}
			GetNode->VariableReference.SetSelfMember(FName(*VarName));
			GetNode->NodePosX = NodePos.X;
			GetNode->NodePosY = NodePos.Y;
			Graph->AddNode(GetNode);
			GetNode->CreateNewGuid();
			GetNode->PostPlacedNewNode();
			GetNode->AllocateDefaultPins();
			GetNode->ReconstructNode();

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(GetNode, Graph));
		}

		void HandleAddBlueprintVariableSetNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString VarName;
			if (!Params->TryGetStringField(TEXT("variable_name"), VarName) || VarName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'variable_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!HasBlueprintMemberVariable(Blueprint, VarName))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Blueprint member variable not found: %s"), *VarName),
					TEXT("VARIABLE_NOT_FOUND"));
				return;
			}
			UEdGraph* Graph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!Graph) return;
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));

			UK2Node_VariableSet* SetNode = NewObject<UK2Node_VariableSet>(Graph);
			if (!SetNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create variable set node"), TEXT("CREATE_FAILED"));
				return;
			}
			SetNode->VariableReference.SetSelfMember(FName(*VarName));
			SetNode->NodePosX = NodePos.X;
			SetNode->NodePosY = NodePos.Y;
			Graph->AddNode(SetNode);
			SetNode->CreateNewGuid();
			SetNode->PostPlacedNewNode();
			SetNode->AllocateDefaultPins();
			SetNode->ReconstructNode();

			const TSharedPtr<FJsonObject>* PinDefaults = nullptr;
			if (Params->TryGetObjectField(TEXT("params"), PinDefaults) && PinDefaults && PinDefaults->IsValid())
			{
				ApplyNodePinDefaults(SetNode, Graph, *PinDefaults);
			}

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(SetNode, Graph));
		}

		void HandleAddBlueprintControlNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString NodeKind;
			if (!Params->TryGetStringField(TEXT("node_kind"), NodeKind) || NodeKind.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'node_kind' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			UEdGraph* Graph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!Graph) return;
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));

			UEdGraphNode* Node = nullptr;
			if (NodeKind.Equals(TEXT("Branch"), ESearchCase::IgnoreCase))
			{
				Node = NewObject<UK2Node_IfThenElse>(Graph);
			}
			else if (NodeKind.Equals(TEXT("Sequence"), ESearchCase::IgnoreCase))
			{
				Node = NewObject<UK2Node_ExecutionSequence>(Graph);
			}
			else if (NodeKind.Equals(TEXT("Return"), ESearchCase::IgnoreCase))
			{
				TArray<UK2Node_FunctionEntry*> EntryNodes;
				Graph->GetNodesOfClass<UK2Node_FunctionEntry>(EntryNodes);
				if (EntryNodes.Num() == 0)
				{
					BuildErrorResponse(OutResponse, TEXT("Return nodes require a function graph with an entry node"), TEXT("FUNCTION_GRAPH_INVALID"));
					return;
				}
				UK2Node_FunctionResult* ResultNode = NewObject<UK2Node_FunctionResult>(Graph);
				ResultNode->FunctionReference = EntryNodes[0]->FunctionReference;
				Node = ResultNode;
			}
			else
			{
				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				TArray<TSharedPtr<FJsonValue>> Allowed;
				Allowed.Add(MakeShared<FJsonValueString>(TEXT("Branch")));
				Allowed.Add(MakeShared<FJsonValueString>(TEXT("Sequence")));
				Allowed.Add(MakeShared<FJsonValueString>(TEXT("Return")));
				Detail->SetArrayField(TEXT("allowed_values"), Allowed);
				Detail->SetStringField(TEXT("provided"), NodeKind);
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unsupported node_kind '%s'"), *NodeKind),
					TEXT("UNSUPPORTED_NODE_KIND"),
					Detail);
				return;
			}

			if (!Node)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create control node"), TEXT("CREATE_FAILED"));
				return;
			}
			Node->NodePosX = NodePos.X;
			Node->NodePosY = NodePos.Y;
			Graph->AddNode(Node);
			Node->CreateNewGuid();
			Node->PostPlacedNewNode();
			Node->AllocateDefaultPins();

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(Node, Graph));
		}

		void HandleAddBlueprintMathNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Operation;
			if (!Params->TryGetStringField(TEXT("operation"), Operation) || Operation.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'operation' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString ValueType;
			Params->TryGetStringField(TEXT("value_type"), ValueType);

			FString FunctionName;
			if (!ResolveMathFunctionName(Operation, ValueType, FunctionName))
			{
				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				Detail->SetStringField(TEXT("operation"), Operation);
				Detail->SetStringField(TEXT("value_type"), ValueType);
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unsupported math operation '%s' for value_type '%s'"), *Operation, *ValueType),
					TEXT("UNSUPPORTED_MATH_NODE"),
					Detail);
				return;
			}

			TSharedPtr<FJsonObject> FunctionParams = MakeShared<FJsonObject>();
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Params->Values)
			{
				FunctionParams->SetField(Pair.Key, Pair.Value);
			}
			FunctionParams->SetStringField(TEXT("function_name"), FunctionName);
			FunctionParams->SetStringField(TEXT("target"), TEXT("KismetMathLibrary"));
			HandleAddBlueprintFunctionNode(FunctionParams, OutResponse);
			if (OutResponse.IsValid())
			{
				const TSharedPtr<FJsonObject>* Result = nullptr;
				if (OutResponse->TryGetObjectField(TEXT("result"), Result) && Result && Result->IsValid())
				{
					(*Result)->SetStringField(TEXT("operation"), Operation);
					(*Result)->SetStringField(TEXT("value_type"), ValueType.IsEmpty() ? TEXT("Float") : ValueType);
					(*Result)->SetStringField(TEXT("function_name"), FunctionName);
				}
			}
		}

		// ── 12. add_blueprint_self_reference ──────────────────────────────────────
		void HandleAddBlueprintSelfReference(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));

			UEdGraph* EventGraph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!EventGraph) return;

			UK2Node_Self* SelfNode = NewObject<UK2Node_Self>(EventGraph);
			if (!SelfNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create self node"), TEXT("CREATE_FAILED"));
				return;
			}
			SelfNode->NodePosX = NodePos.X;
			SelfNode->NodePosY = NodePos.Y;
			EventGraph->AddNode(SelfNode);
			SelfNode->CreateNewGuid();
			SelfNode->PostPlacedNewNode();
			SelfNode->AllocateDefaultPins();

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(SelfNode, EventGraph));
		}

		// ── 13. add_blueprint_get_self_component_reference ────────────────────────
		void HandleAddBlueprintGetSelfComponentReference(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString ComponentName;
			if (!Params->TryGetStringField(TEXT("component_name"), ComponentName) || ComponentName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'component_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FVector2D NodePos = ReadVector2DOrZero(Params, TEXT("node_position"));

			UEdGraph* EventGraph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!EventGraph) return;

			UK2Node_VariableGet* GetNode = NewObject<UK2Node_VariableGet>(EventGraph);
			if (!GetNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create get component node"), TEXT("CREATE_FAILED"));
				return;
			}
			GetNode->VariableReference.SetSelfMember(FName(*ComponentName));
			GetNode->NodePosX = NodePos.X;
			GetNode->NodePosY = NodePos.Y;
			EventGraph->AddNode(GetNode);
			GetNode->CreateNewGuid();
			GetNode->PostPlacedNewNode();
			GetNode->AllocateDefaultPins();
			GetNode->ReconstructNode();

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			BuildSuccessResponse(OutResponse, NodeResultToJson(GetNode, EventGraph));
		}

		// ── 14. connect_blueprint_nodes ───────────────────────────────────────────
		void HandleConnectBlueprintNodes(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString SourceId, TargetId, SourcePinName, TargetPinName;
			if (!Params->TryGetStringField(TEXT("source_node_id"), SourceId)
				|| !Params->TryGetStringField(TEXT("target_node_id"), TargetId)
				|| !Params->TryGetStringField(TEXT("source_pin"), SourcePinName)
				|| !Params->TryGetStringField(TEXT("target_pin"), TargetPinName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing required parameter (source_node_id, target_node_id, source_pin, target_pin)"), TEXT("MISSING_PARAMS"));
				return;
			}

			UEdGraph* EventGraph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!EventGraph) return;

			UEdGraphNode* SourceNode = FindNodeByGuid(EventGraph, SourceId);
			UEdGraphNode* TargetNode = FindNodeByGuid(EventGraph, TargetId);

			if (!SourceNode || !TargetNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Source or target node not found"), TEXT("NODE_NOT_FOUND"));
				return;
			}

			UEdGraphPin* SourcePin = FindPin(SourceNode, SourcePinName, EGPD_Output);
			UEdGraphPin* TargetPin = FindPin(TargetNode, TargetPinName, EGPD_Input);
			if (!SourcePin || !TargetPin)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to connect nodes"), TEXT("CONNECT_FAILED"));
				return;
			}

			const UEdGraphSchema_K2* K2Schema = Cast<const UEdGraphSchema_K2>(EventGraph->GetSchema());
			if (K2Schema)
			{
				const FPinConnectionResponse Response = K2Schema->CanCreateConnection(SourcePin, TargetPin);
				if (Response.Response == CONNECT_RESPONSE_DISALLOW)
				{
					TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
					Detail->SetObjectField(TEXT("source_pin"), PinToJson(SourcePin));
					Detail->SetObjectField(TEXT("target_pin"), PinToJson(TargetPin));
					Detail->SetObjectField(TEXT("source_pin_type"), PinTypeToJson(SourcePin->PinType));
					Detail->SetObjectField(TEXT("target_pin_type"), PinTypeToJson(TargetPin->PinType));
					BuildErrorResponse(OutResponse,
						Response.Message.IsEmpty()
							? TEXT("Pins are not compatible")
							: Response.Message.ToString(),
						TEXT("INCOMPATIBLE_PINS"),
						Detail);
					return;
				}
			}
			SourcePin->MakeLinkTo(TargetPin);

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("source_node_id"), SourceId);
			Result->SetStringField(TEXT("target_node_id"), TargetId);
			Result->SetStringField(TEXT("graph_name"), EventGraph->GetName());
			Result->SetObjectField(TEXT("source_pin"), PinToJson(SourcePin));
			Result->SetObjectField(TEXT("target_pin"), PinToJson(TargetPin));
			TSharedPtr<FJsonObject> PinTypes = MakeShared<FJsonObject>();
			PinTypes->SetObjectField(TEXT("source"), PinTypeToJson(SourcePin->PinType));
			PinTypes->SetObjectField(TEXT("target"), PinTypeToJson(TargetPin->PinType));
			Result->SetObjectField(TEXT("pin_types"), PinTypes);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── 15. find_blueprint_nodes ──────────────────────────────────────────────
		void HandleFindBlueprintNodes(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			UBlueprint* Blueprint = ResolveBlueprint(Params, OutResponse);
			if (!Blueprint) return;

			FString NodeType;
			if (!Params->TryGetStringField(TEXT("node_type"), NodeType) || NodeType.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'node_type' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			UEdGraph* EventGraph = ResolveTargetGraph(Blueprint, Params, OutResponse);
			if (!EventGraph) return;

			TArray<TSharedPtr<FJsonValue>> Guids;
			if (NodeType == TEXT("Event"))
			{
				FString EventName;
				if (!Params->TryGetStringField(TEXT("event_name"), EventName) || EventName.IsEmpty())
				{
					BuildErrorResponse(OutResponse, TEXT("Missing 'event_name' parameter for Event node search"), TEXT("MISSING_PARAMS"));
					return;
				}
				const FName Member(*EventName);
				for (UEdGraphNode* Node : EventGraph->Nodes)
				{
					if (UK2Node_Event* Ev = Cast<UK2Node_Event>(Node))
					{
						if (Ev->EventReference.GetMemberName() == Member)
						{
							Guids.Add(MakeShared<FJsonValueString>(Ev->NodeGuid.ToString()));
						}
					}
				}
			}
			else
			{
				// W-G (D144): pre-fold this silently returned [] for any non-Event
				// node_type — Gauntlet Finding 4.1 silent-success-on-edge-case.
				// W-B's Zod enum (`z.enum(['Event'])`) gates this at the JS layer;
				// the explicit C++ error path is defense-in-depth for direct-TCP
				// callers + leaves the handler dispatch valid for future expansion.
				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				TArray<TSharedPtr<FJsonValue>> Allowed;
				Allowed.Add(MakeShared<FJsonValueString>(TEXT("Event")));
				Detail->SetArrayField (TEXT("allowed_values"), Allowed);
				Detail->SetStringField(TEXT("provided"),       NodeType);
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unsupported node_type '%s' (only 'Event' is implemented)"), *NodeType),
					TEXT("UNSUPPORTED_NODE_TYPE"),
					Detail);
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetArrayField(TEXT("node_guids"), Guids);
			Result->SetStringField(TEXT("graph_name"), EventGraph->GetName());
			BuildSuccessResponse(OutResponse, Result);
		}

	} // anonymous namespace

	void RegisterBlueprintHandlers(FMCPCommandRegistry& Registry)
	{
		// Wire-type strings match the conformance oracle (TCP:55557) so migrated
		// callers see only port + envelope changes — no rename churn.
		Registry.Register(TEXT("create_blueprint"),                              &HandleCreateBlueprint);
		Registry.Register(TEXT("add_component_to_blueprint"),                    &HandleAddComponentToBlueprint);
		Registry.Register(TEXT("set_component_property"),                        &HandleSetComponentProperty);
		Registry.Register(TEXT("compile_blueprint"),                             &HandleCompileBlueprint);
		Registry.Register(TEXT("set_blueprint_property"),                        &HandleSetBlueprintProperty);
		Registry.Register(TEXT("set_static_mesh_properties"),                    &HandleSetStaticMeshProperties);
		Registry.Register(TEXT("set_physics_properties"),                        &HandleSetPhysicsProperties);
		Registry.Register(TEXT("set_pawn_properties"),                           &HandleSetPawnProperties);
		Registry.Register(TEXT("add_blueprint_event_node"),                      &HandleAddBlueprintEventNode);
		Registry.Register(TEXT("add_blueprint_function_node"),                   &HandleAddBlueprintFunctionNode);
		Registry.Register(TEXT("add_blueprint_variable"),                        &HandleAddBlueprintVariable);
		Registry.Register(TEXT("add_blueprint_function_graph"),                  &HandleAddBlueprintFunctionGraph);
		Registry.Register(TEXT("add_blueprint_variable_get_node"),               &HandleAddBlueprintVariableGetNode);
		Registry.Register(TEXT("add_blueprint_variable_set_node"),               &HandleAddBlueprintVariableSetNode);
		Registry.Register(TEXT("add_blueprint_control_node"),                    &HandleAddBlueprintControlNode);
		Registry.Register(TEXT("add_blueprint_math_node"),                       &HandleAddBlueprintMathNode);
		Registry.Register(TEXT("add_blueprint_self_reference"),                  &HandleAddBlueprintSelfReference);
		Registry.Register(TEXT("add_blueprint_get_self_component_reference"),    &HandleAddBlueprintGetSelfComponentReference);
		Registry.Register(TEXT("connect_blueprint_nodes"),                       &HandleConnectBlueprintNodes);
		Registry.Register(TEXT("find_blueprint_nodes"),                          &HandleFindBlueprintNodes);
	}
}
