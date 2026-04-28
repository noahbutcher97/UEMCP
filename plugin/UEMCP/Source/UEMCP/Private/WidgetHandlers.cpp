// Copyright Optimum Athena. All Rights Reserved.
#include "WidgetHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetBlueprintGeneratedClass.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Button.h"
#include "Components/CanvasPanel.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/TextBlock.h"
#include "EdGraph/EdGraph.h"
#include "EdGraphSchema_K2.h"
#include "Editor.h"
#include "EditorAssetLibrary.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "K2Node_ComponentBoundEvent.h"
#include "K2Node_Event.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "K2Node_InputAction.h"
#include "K2Node_VariableGet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "BlueprintLookupHelper.h"
#include "UObject/Package.h"
#include "WidgetBlueprint.h"

namespace UEMCP
{
	namespace
	{
		// ── Path + lookup helpers ────────────────────────────────────────────────
		//
		// Widget blueprints live at /Game/Widgets/<name>. UEditorAssetLibrary::LoadAsset
		// resolves the package-path form reliably in editor mode but fails when PIE is
		// active (D99 finding #3 — empirically observed: "Widget Blueprint 'X' not
		// found" in PIE; same path resolves clean PIE-off). Use LoadObject directly
		// with the canonical doubled object-path form, which works regardless of PIE
		// world state. Falls back to the package-path form via LoadObject for any
		// edge case where the doubled form doesn't resolve.

		FString WidgetAssetPath(const FString& BlueprintName)
		{
			return FString::Printf(TEXT("/Game/Widgets/%s"), *BlueprintName);
		}

		UWidgetBlueprint* LoadWidgetBlueprintByName(const FString& BlueprintName, FString& OutError)
		{
			const FString PackagePath = WidgetAssetPath(BlueprintName);
			const FString ObjectPath = FString::Printf(TEXT("/Game/Widgets/%s.%s"), *BlueprintName, *BlueprintName);

			// Canonical doubled form via LoadObject — survives PIE state where
			// UEditorAssetLibrary::LoadAsset can fail to resolve.
			UWidgetBlueprint* WB = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath);
			if (!WB)
			{
				WB = LoadObject<UWidgetBlueprint>(nullptr, *PackagePath);
			}
			if (!WB)
			{
				WB = Cast<UWidgetBlueprint>(UEditorAssetLibrary::LoadAsset(PackagePath));
			}
			if (!WB)
			{
				OutError = FString::Printf(TEXT("Widget Blueprint '%s' not found at %s"), *BlueprintName, *PackagePath);
				return nullptr;
			}
			return WB;
		}

		bool TryReadVector2(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field, FVector2D& Out)
		{
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (!Params->TryGetArrayField(Field, Arr) || Arr == nullptr || Arr->Num() < 2)
			{
				return false;
			}
			Out.X = (*Arr)[0]->AsNumber();
			Out.Y = (*Arr)[1]->AsNumber();
			return true;
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 1. create_umg_widget_blueprint
		// ═══════════════════════════════════════════════════════════════════════

		void HandleCreateUmgWidgetBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_umg_widget_blueprint requires params.name"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName;
			if (!Params->TryGetStringField(TEXT("name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			const FString FullPath = WidgetAssetPath(BlueprintName);
			if (UEditorAssetLibrary::DoesAssetExist(FullPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Widget Blueprint '%s' already exists"), *BlueprintName),
					TEXT("ASSET_EXISTS"));
				return;
			}

			UPackage* Package = CreatePackage(*FullPath);
			if (!Package)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create package"), TEXT("PACKAGE_CREATE_FAILED"));
				return;
			}

			UBlueprint* NewBlueprint = FKismetEditorUtilities::CreateBlueprint(
				UUserWidget::StaticClass(),
				Package,
				FName(*BlueprintName),
				BPTYPE_Normal,
				UWidgetBlueprint::StaticClass(),
				UWidgetBlueprintGeneratedClass::StaticClass(),
				FName("CreateUMGWidget"));

			UWidgetBlueprint* WidgetBlueprint = Cast<UWidgetBlueprint>(NewBlueprint);
			if (!WidgetBlueprint)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create Widget Blueprint"), TEXT("BLUEPRINT_CREATE_FAILED"));
				return;
			}

			if (!WidgetBlueprint->WidgetTree->RootWidget)
			{
				UCanvasPanel* RootCanvas = WidgetBlueprint->WidgetTree->ConstructWidget<UCanvasPanel>(UCanvasPanel::StaticClass());
				WidgetBlueprint->WidgetTree->RootWidget = RootCanvas;
			}

			Package->MarkPackageDirty();
			FAssetRegistryModule::AssetCreated(WidgetBlueprint);
			FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), BlueprintName);
			Result->SetStringField(TEXT("path"), FullPath);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 2. add_text_block_to_widget
		// ═══════════════════════════════════════════════════════════════════════

		void HandleAddTextBlockToWidget(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_text_block_to_widget requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName, WidgetName;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("widget_name"), WidgetName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'widget_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString LoadError;
			UWidgetBlueprint* WidgetBlueprint = LoadWidgetBlueprintByName(BlueprintName, LoadError);
			if (!WidgetBlueprint)
			{
				BuildErrorResponse(OutResponse, LoadError, TEXT("BLUEPRINT_NOT_FOUND"));
				return;
			}

			FString InitialText = TEXT("New Text Block");
			Params->TryGetStringField(TEXT("text"), InitialText);

			FVector2D Position(0.0f, 0.0f);
			if (Params->HasField(TEXT("position")))
			{
				TryReadVector2(Params, TEXT("position"), Position);
			}

			UTextBlock* TextBlock = WidgetBlueprint->WidgetTree->ConstructWidget<UTextBlock>(
				UTextBlock::StaticClass(), FName(*WidgetName));
			if (!TextBlock)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create Text Block widget"), TEXT("WIDGET_CREATE_FAILED"));
				return;
			}
			TextBlock->SetText(FText::FromString(InitialText));

			UCanvasPanel* RootCanvas = Cast<UCanvasPanel>(WidgetBlueprint->WidgetTree->RootWidget);
			if (!RootCanvas)
			{
				BuildErrorResponse(OutResponse, TEXT("Root widget is not a Canvas Panel"), TEXT("ROOT_NOT_CANVAS"));
				return;
			}
			UCanvasPanelSlot* PanelSlot = RootCanvas->AddChildToCanvas(TextBlock);
			if (PanelSlot)
			{
				PanelSlot->SetPosition(Position);
			}

			// WIDGETS-PERF: pure WidgetTree mutation marks the BP dirty but does NOT
			// auto-compile. Pre-fix D83 hitch log (<ProjectName>.log 2026-04-26) recorded
			// 'add_text_block_to_widget ran 2027.1ms' (cold) and '872.2ms' (warm) —
			// dominated by FKismetEditorUtilities::CompileBlueprint regenerating the
			// UWidgetBlueprintGeneratedClass + Slate template. Removing the auto-
			// compile leaves only WidgetTree mutation + dirty mark; the new per-call
			// cost will be re-measured against the same D83 instrumentation post-
			// deployment. Callers batch mutations and invoke `compile_blueprint`
			// (or `bp_compile_and_report`) when they need generated-class properties
			// materialized for downstream lookup. Property-resolving handlers
			// (bind_widget_event, set_text_block_binding) still self-compile because
			// they read FObjectProperty on GeneratedClass.
			FBlueprintEditorUtils::MarkBlueprintAsModified(WidgetBlueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("widget_name"), WidgetName);
			Result->SetStringField(TEXT("text"), InitialText);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 3. add_button_to_widget
		// ═══════════════════════════════════════════════════════════════════════

		void HandleAddButtonToWidget(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_button_to_widget requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName, WidgetName, ButtonText;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("widget_name"), WidgetName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'widget_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("text"), ButtonText))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'text' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString LoadError;
			UWidgetBlueprint* WidgetBlueprint = LoadWidgetBlueprintByName(BlueprintName, LoadError);
			if (!WidgetBlueprint)
			{
				BuildErrorResponse(OutResponse, LoadError, TEXT("BLUEPRINT_NOT_FOUND"));
				return;
			}

			// Construct button via WidgetTree (oracle used NewObject with the CDO as outer,
			// which disturbs hierarchy invariants — ConstructWidget is the supported path).
			UButton* Button = WidgetBlueprint->WidgetTree->ConstructWidget<UButton>(
				UButton::StaticClass(), FName(*WidgetName));
			if (!Button)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create Button widget"), TEXT("WIDGET_CREATE_FAILED"));
				return;
			}

			UTextBlock* ButtonTextBlock = WidgetBlueprint->WidgetTree->ConstructWidget<UTextBlock>(
				UTextBlock::StaticClass(), FName(*(WidgetName + TEXT("_Text"))));
			if (ButtonTextBlock)
			{
				ButtonTextBlock->SetText(FText::FromString(ButtonText));
				Button->AddChild(ButtonTextBlock);
			}

			UCanvasPanel* RootCanvas = Cast<UCanvasPanel>(WidgetBlueprint->WidgetTree->RootWidget);
			if (!RootCanvas)
			{
				BuildErrorResponse(OutResponse, TEXT("Root widget is not a Canvas Panel"), TEXT("ROOT_NOT_CANVAS"));
				return;
			}

			UCanvasPanelSlot* ButtonSlot = RootCanvas->AddChildToCanvas(Button);
			if (ButtonSlot)
			{
				FVector2D Position(0.0f, 0.0f);
				if (TryReadVector2(Params, TEXT("position"), Position))
				{
					ButtonSlot->SetPosition(Position);
				}
			}

			// WIDGETS-PERF: pure WidgetTree mutation — same contract as
			// add_text_block_to_widget. Drops the asymmetric SaveAsset() that
			// the oracle copied; persistence happens on completion handlers
			// (bind_widget_event / set_text_block_binding) or via explicit
			// caller invocation. Pre-fix D83 hitch log (<ProjectName>.log 2026-04-26)
			// recorded 'add_button_to_widget ran 4155.5ms'; that single data
			// point is the worst case in the captured trace, dominated by
			// CompileBlueprint + SaveAsset together. Post-fix per-call cost
			// will be re-measured against the same D83 instrumentation.
			FBlueprintEditorUtils::MarkBlueprintAsModified(WidgetBlueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("success"), true);
			Result->SetStringField(TEXT("widget_name"), WidgetName);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 4. bind_widget_event
		// ═══════════════════════════════════════════════════════════════════════

		void HandleBindWidgetEvent(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("bind_widget_event requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName, WidgetName, EventName;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("widget_name"), WidgetName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'widget_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("event_name"), EventName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'event_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString LoadError;
			UWidgetBlueprint* WidgetBlueprint = LoadWidgetBlueprintByName(BlueprintName, LoadError);
			if (!WidgetBlueprint)
			{
				BuildErrorResponse(OutResponse, LoadError, TEXT("BLUEPRINT_NOT_FOUND"));
				return;
			}

			UEdGraph* EventGraph = FBlueprintEditorUtils::FindEventGraph(WidgetBlueprint);
			if (!EventGraph)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to find event graph"), TEXT("EVENT_GRAPH_NOT_FOUND"));
				return;
			}

			UWidget* Widget = WidgetBlueprint->WidgetTree->FindWidget(FName(*WidgetName));
			if (!Widget)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Widget not found: %s"), *WidgetName),
					TEXT("WIDGET_NOT_FOUND"));
				return;
			}

			// UK2Node_ComponentBoundEvent identifies bindings by DelegatePropertyName +
			// ComponentPropertyName, not by CustomFunctionName / EventReference (the
			// pre-D99-fix lookup never matched, so idempotency-by-search broke). Match
			// against the canonical fields instead.
			const FName DelegatePropName(*EventName);
			const FName WidgetPropName(*WidgetName);

			auto FindExistingBoundEvent = [&]() -> UK2Node_ComponentBoundEvent*
			{
				TArray<UK2Node_ComponentBoundEvent*> All;
				FBlueprintEditorUtils::GetAllNodesOfClass<UK2Node_ComponentBoundEvent>(WidgetBlueprint, All);
				for (UK2Node_ComponentBoundEvent* Node : All)
				{
					if (Node && Node->DelegatePropertyName == DelegatePropName
						&& Node->ComponentPropertyName == WidgetPropName)
					{
						return Node;
					}
				}
				return nullptr;
			};

			UK2Node_ComponentBoundEvent* EventNode = FindExistingBoundEvent();
			if (!EventNode)
			{
				// CreateNewBoundEventForClass returns null and silently fails when
				// the FObjectProperty pointing at the widget instance on the
				// generated class is null. The compiler creates that property from
				// the WidgetTree, so a freshly-added widget needs an explicit
				// recompile before its binding can be wired (this was the D99
				// finding #4 root cause — calling bind_widget_event after add_button
				// never compiled-then-found-property between the two ops).
				if (!WidgetBlueprint->GeneratedClass)
				{
					FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);
				}
				UClass* GenClass = WidgetBlueprint->GeneratedClass;
				FObjectProperty* WidgetProp = GenClass
					? FindFProperty<FObjectProperty>(GenClass, WidgetPropName)
					: nullptr;
				if (!WidgetProp)
				{
					// Recompile once more in case the widget was added since the
					// last compile and isn't yet reified as a generated-class member.
					FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);
					GenClass = WidgetBlueprint->GeneratedClass;
					WidgetProp = GenClass
						? FindFProperty<FObjectProperty>(GenClass, WidgetPropName)
						: nullptr;
				}
				if (!WidgetProp)
				{
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("Widget '%s' has no FObjectProperty on generated class — recompile blueprint and retry"), *WidgetName),
						TEXT("WIDGET_PROPERTY_MISSING"));
					return;
				}

				// UE 5.6: CreateNewBoundEventForClass returns void (was
				// UK2Node_ComponentBoundEvent* in 5.3-). Look up the freshly-
				// created node by its canonical (DelegatePropertyName,
				// ComponentPropertyName) pair via the existing lambda above.
				FKismetEditorUtilities::CreateNewBoundEventForClass(
					Widget->GetClass(), DelegatePropName, WidgetBlueprint, WidgetProp);
				EventNode = FindExistingBoundEvent();

				if (!EventNode)
				{
					BuildErrorResponse(OutResponse,
						TEXT("Failed to create bound event node — verify widget class exposes the named delegate"),
						TEXT("EVENT_CREATE_FAILED"));
					return;
				}

				// Position below existing nodes for legibility.
				float MaxHeight = 0.0f;
				for (UEdGraphNode* Node : EventGraph->Nodes)
				{
					if (Node != EventNode)
					{
						MaxHeight = FMath::Max(MaxHeight, static_cast<float>(Node->NodePosY));
					}
				}
				EventNode->NodePosX = 200;
				EventNode->NodePosY = MaxHeight + 200.0f;
			}

			FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);
			UEditorAssetLibrary::SaveAsset(WidgetAssetPath(BlueprintName), false);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("success"), true);
			Result->SetStringField(TEXT("event_name"), EventName);
			Result->SetStringField(TEXT("widget_name"), WidgetName);
			Result->SetStringField(TEXT("node_id"), EventNode->NodeGuid.ToString());
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 5. set_text_block_binding — FIXED
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Oracle bug (UnrealMCPUMGCommands.cpp:528-534): connected EntryThenPin (exec)
		// to GetVarOutPin (data) — invalid K2 schema connection. Even if the function
		// graph compiled, no FDelegateEditorBinding was added to WidgetBlueprint->Bindings,
		// so UMG had no record of the binding to invoke at runtime.
		//
		// Fix:
		//   1. Add FText member variable for the binding (kept from oracle)
		//   2. Create a PURE function graph (FUNC_BlueprintPure) — UMG bindings must be
		//      pure since they're polled per-frame
		//   3. Place FunctionEntry + VariableGet + FunctionResult nodes
		//   4. Add a "ReturnValue" UDP of FText type to the Result node — this is the
		//      function's actual return value
		//   5. Connect VariableGet output → FunctionResult ReturnValue input (data → data)
		//   6. Register an FDelegateEditorBinding entry pointing the TextBlock's Text
		//      property at the new function — this is what UMG actually consults at runtime
		//   7. Compile

		void HandleSetTextBlockBinding(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("set_text_block_binding requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName, WidgetName, BindingName;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("widget_name"), WidgetName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'widget_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("binding_name"), BindingName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'binding_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString LoadError;
			UWidgetBlueprint* WidgetBlueprint = LoadWidgetBlueprintByName(BlueprintName, LoadError);
			if (!WidgetBlueprint)
			{
				BuildErrorResponse(OutResponse, LoadError, TEXT("BLUEPRINT_NOT_FOUND"));
				return;
			}

			UTextBlock* TextBlock = Cast<UTextBlock>(
				WidgetBlueprint->WidgetTree->FindWidget(FName(*WidgetName)));
			if (!TextBlock)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("TextBlock not found: %s"), *WidgetName),
					TEXT("WIDGET_NOT_FOUND"));
				return;
			}

			// (1) Add the FText member variable (idempotent — AddMemberVariable rejects dupes silently).
			FEdGraphPinType TextPinType;
			TextPinType.PinCategory = UEdGraphSchema_K2::PC_Text;
			TextPinType.PinSubCategory = NAME_None;
			TextPinType.PinSubCategoryObject = nullptr;
			TextPinType.ContainerType = EPinContainerType::None;
			FBlueprintEditorUtils::AddMemberVariable(WidgetBlueprint, FName(*BindingName), TextPinType);

			// (2) Build the getter function graph. Idempotency: if a graph with this name
			// already exists, drop in fresh nodes — but skip a duplicate AddFunctionGraph call
			// (which would re-register the function and emit a Kismet warning).
			const FString FunctionName = FString::Printf(TEXT("Get%s"), *BindingName);
			UEdGraph* ExistingGraph = nullptr;
			for (UEdGraph* Graph : WidgetBlueprint->FunctionGraphs)
			{
				if (Graph && Graph->GetFName() == FName(*FunctionName))
				{
					ExistingGraph = Graph;
					break;
				}
			}

			UEdGraph* FuncGraph = ExistingGraph;
			if (!FuncGraph)
			{
				FuncGraph = FBlueprintEditorUtils::CreateNewGraph(
					WidgetBlueprint,
					FName(*FunctionName),
					UEdGraph::StaticClass(),
					UEdGraphSchema_K2::StaticClass());
				FBlueprintEditorUtils::AddFunctionGraph<UClass>(WidgetBlueprint, FuncGraph, false, nullptr);
			}

			// (3) Find auto-generated entry node + (4) mark pure for UMG binding compatibility.
			TArray<UK2Node_FunctionEntry*> EntryNodes;
			FuncGraph->GetNodesOfClass<UK2Node_FunctionEntry>(EntryNodes);
			if (EntryNodes.Num() == 0)
			{
				BuildErrorResponse(OutResponse, TEXT("Function graph missing entry node"), TEXT("FUNCTION_GRAPH_INVALID"));
				return;
			}
			UK2Node_FunctionEntry* EntryNode = EntryNodes[0];
			EntryNode->AddExtraFlags(FUNC_BlueprintPure | FUNC_Const);
			EntryNode->ReconstructNode();

			// (5) Add the result node + ReturnValue pin (matching property type — FText).
			UK2Node_FunctionResult* ResultNode = NewObject<UK2Node_FunctionResult>(FuncGraph);
			ResultNode->FunctionReference = EntryNode->FunctionReference;
			ResultNode->NodePosX = 400;
			ResultNode->NodePosY = 0;
			ResultNode->CreateNewGuid();
			FuncGraph->AddNode(ResultNode, false, false);
			ResultNode->AllocateDefaultPins();
			UEdGraphPin* ReturnPin = ResultNode->CreateUserDefinedPin(
				FName(TEXT("ReturnValue")), TextPinType, EGPD_Input, false);

			// (6) VariableGet for the binding member.
			UK2Node_VariableGet* GetVarNode = NewObject<UK2Node_VariableGet>(FuncGraph);
			GetVarNode->VariableReference.SetSelfMember(FName(*BindingName));
			GetVarNode->NodePosX = 200;
			GetVarNode->NodePosY = 0;
			GetVarNode->CreateNewGuid();
			FuncGraph->AddNode(GetVarNode, false, false);
			GetVarNode->AllocateDefaultPins();

			// VariableGet's output pin is named after the variable.
			UEdGraphPin* GetVarOut = GetVarNode->FindPin(FName(*BindingName));
			if (GetVarOut && ReturnPin)
			{
				// Data-flow connection (the bug-fix): VarGet output → Result ReturnValue input.
				GetVarOut->MakeLinkTo(ReturnPin);
			}

			// (7) Register the binding so UMG actually invokes the function.
			// Avoid duplicate FDelegateEditorBinding entries on re-call by clearing prior
			// bindings for this widget+property pair before adding the new one.
			const FName TextPropertyName(TEXT("Text"));
			WidgetBlueprint->Bindings.RemoveAll([&](const FDelegateEditorBinding& B)
			{
				return B.ObjectName == WidgetName && B.PropertyName == TextPropertyName;
			});
			FDelegateEditorBinding NewBinding;
			NewBinding.ObjectName = WidgetName;
			NewBinding.PropertyName = TextPropertyName;
			NewBinding.FunctionName = FName(*FunctionName);
			NewBinding.SourcePath = FEditorPropertyPath();
			NewBinding.Kind = EBindingKind::Function;
			WidgetBlueprint->Bindings.Add(NewBinding);

			FBlueprintEditorUtils::MarkBlueprintAsModified(WidgetBlueprint);
			FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);
			UEditorAssetLibrary::SaveAsset(WidgetAssetPath(BlueprintName), false);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("success"), true);
			Result->SetStringField(TEXT("binding_name"), BindingName);
			Result->SetStringField(TEXT("function_name"), FunctionName);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 6. add_widget_to_viewport — FIXED
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Oracle bug (UnrealMCPUMGCommands.cpp:198-237): the handler returned the widget
		// class path with a "use Blueprint nodes instead" note, but never created a
		// widget instance and never called AddToViewport. Misleading success — caller
		// thinks the widget is on screen; nothing happens.
		//
		// Fix: AddToViewport requires a live game world (the editor world has no
		// GameViewportClient.AddToViewport surface for UUserWidget). So we gate on PIE:
		//   - If PIE running: create widget via PIE's PlayerController, AddToViewport(z_order)
		//   - If PIE not running: return typed error NOT_IN_PIE so callers know to
		//     start_pie first instead of getting a misleading success.

		void HandleAddWidgetToViewport(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_widget_to_viewport requires params.blueprint_name"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			int32 ZOrder = 0;
			Params->TryGetNumberField(TEXT("z_order"), ZOrder);

			FString LoadError;
			UWidgetBlueprint* WidgetBlueprint = LoadWidgetBlueprintByName(BlueprintName, LoadError);
			if (!WidgetBlueprint)
			{
				BuildErrorResponse(OutResponse, LoadError, TEXT("BLUEPRINT_NOT_FOUND"));
				return;
			}

			UClass* WidgetClass = WidgetBlueprint->GeneratedClass;
			if (!WidgetClass)
			{
				BuildErrorResponse(OutResponse,
					TEXT("Widget generated class is null — recompile blueprint"),
					TEXT("NO_GENERATED_CLASS"));
				return;
			}

			if (!GEditor || !GEditor->PlayWorld)
			{
				BuildErrorResponse(OutResponse,
					TEXT("Cannot add widget to viewport: PIE is not running. Start PIE first (input-and-pie.start_pie)."),
					TEXT("NOT_IN_PIE"));
				return;
			}

			UWorld* PieWorld = GEditor->PlayWorld;
			APlayerController* PC = PieWorld->GetFirstPlayerController();
			if (!PC)
			{
				BuildErrorResponse(OutResponse,
					TEXT("PIE world has no PlayerController — widget creation requires one"),
					TEXT("NO_PLAYER_CONTROLLER"));
				return;
			}

			UUserWidget* WidgetInstance = CreateWidget<UUserWidget>(PC, WidgetClass, FName(*BlueprintName));
			if (!WidgetInstance)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create widget instance"), TEXT("WIDGET_CREATE_FAILED"));
				return;
			}

			WidgetInstance->AddToViewport(ZOrder);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("blueprint_name"), BlueprintName);
			Result->SetStringField(TEXT("class_path"), WidgetClass->GetPathName());
			Result->SetNumberField(TEXT("z_order"), ZOrder);
			Result->SetBoolField(TEXT("added_to_viewport"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 7. add_blueprint_input_action_node
		// ═══════════════════════════════════════════════════════════════════════
		//
		// This is semantically a BlueprintNodeCommands op (legacy Input Actions, not
		// Enhanced Input). Lives here in WidgetHandlers because the widgets toolset
		// surfaces it as `add_input_action_node` for legacy UI grouping reasons (per
		// tools.yaml widgets: section). The 6 other BP-node handlers belong to
		// M3-blueprints-write; this one stays with widgets to keep that worker's
		// scope file-disjoint from this one.

		void HandleAddBlueprintInputActionNode(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_blueprint_input_action_node requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName, ActionName;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("action_name"), ActionName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'action_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			// D109: project-layout-aware resolution. blueprint_name accepts a bare
			// name (legacy /Game/Blueprints/<name> probe + AssetRegistry fallback)
			// or a fully-qualified /Game/... path. Different from widget blueprints
			// (which live under /Game/Widgets/) — this handler edits the embedded
			// graph of a regular UBlueprint that hosts an Input Action node.
			FString BlueprintPath, ResolveError, ResolveErrorCode;
			if (!ResolveBlueprintAssetPath(BlueprintName, BlueprintPath, ResolveError, ResolveErrorCode))
			{
				BuildErrorResponse(OutResponse, ResolveError, ResolveErrorCode);
				return;
			}
			UBlueprint* Blueprint = Cast<UBlueprint>(UEditorAssetLibrary::LoadAsset(BlueprintPath));
			if (!Blueprint)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Blueprint '%s' could not be loaded from %s"), *BlueprintName, *BlueprintPath),
					TEXT("BLUEPRINT_LOAD_FAILED"));
				return;
			}

			UEdGraph* EventGraph = FBlueprintEditorUtils::FindEventGraph(Blueprint);
			if (!EventGraph)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to find event graph"), TEXT("EVENT_GRAPH_NOT_FOUND"));
				return;
			}

			FVector2D Position(0.0f, 0.0f);
			if (Params->HasField(TEXT("node_position")))
			{
				TryReadVector2(Params, TEXT("node_position"), Position);
			}

			UK2Node_InputAction* InputNode = NewObject<UK2Node_InputAction>(EventGraph);
			if (!InputNode)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create input action node"), TEXT("NODE_CREATE_FAILED"));
				return;
			}
			InputNode->InputActionName = FName(*ActionName);
			InputNode->NodePosX = Position.X;
			InputNode->NodePosY = Position.Y;
			InputNode->CreateNewGuid();
			EventGraph->AddNode(InputNode, false, false);
			InputNode->PostPlacedNewNode();
			InputNode->AllocateDefaultPins();

			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("node_id"), InputNode->NodeGuid.ToString());
			BuildSuccessResponse(OutResponse, Result);
		}

	} // anonymous namespace

	void RegisterWidgetHandlers(FMCPCommandRegistry& Registry)
	{
		// Wire-type strings match the conformance oracle (TCP:55557) exactly so
		// migrated callers see only port + envelope changes — no rename churn.
		// The 2 previously-broken handlers ship CORRECTED behavior under the same
		// type strings (oracle parity is response-shape, not bug-replication).
		Registry.Register(TEXT("create_umg_widget_blueprint"),     &HandleCreateUmgWidgetBlueprint);
		Registry.Register(TEXT("add_text_block_to_widget"),        &HandleAddTextBlockToWidget);
		Registry.Register(TEXT("add_button_to_widget"),            &HandleAddButtonToWidget);
		Registry.Register(TEXT("bind_widget_event"),               &HandleBindWidgetEvent);
		Registry.Register(TEXT("set_text_block_binding"),          &HandleSetTextBlockBinding);
		Registry.Register(TEXT("add_widget_to_viewport"),          &HandleAddWidgetToViewport);
		Registry.Register(TEXT("add_blueprint_input_action_node"), &HandleAddBlueprintInputActionNode);
	}
}
