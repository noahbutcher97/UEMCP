// Copyright Optimum Athena. All Rights Reserved.
#include "EdgeCaseHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Blueprint/WidgetTree.h"
#include "Components/PanelWidget.h"
#include "Components/Widget.h"
#include "EdGraph/EdGraph.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/Blueprint.h"
#include "Engine/Selection.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "LevelEditorViewport.h"
#include "Modules/ModuleManager.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UObjectIterator.h"
#include "WidgetBlueprint.h"

namespace UEMCP
{
	namespace
	{
		// ── get_editor_state ──────────────────────────────────

		void HandleGetEditorState(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!GEditor)
			{
				BuildErrorResponse(OutResponse, TEXT("GEditor is null — not running in editor context"), TEXT("NO_EDITOR"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();

			// Current world / level info
			if (UWorld* World = GEditor->GetEditorWorldContext().World())
			{
				Result->SetStringField(TEXT("world_path"), World->GetPathName());
				Result->SetStringField(TEXT("world_name"), World->GetName());
			}

			// Selected actors
			TArray<TSharedPtr<FJsonValue>> Selected;
			if (USelection* Sel = GEditor->GetSelectedActors())
			{
				TArray<UObject*> SelObjs;
				Sel->GetSelectedObjects(SelObjs);
				for (UObject* Obj : SelObjs)
				{
					if (AActor* Actor = Cast<AActor>(Obj))
					{
						TSharedPtr<FJsonObject> ActorEntry = MakeShared<FJsonObject>();
						ActorEntry->SetStringField(TEXT("name"),  Actor->GetName());
						ActorEntry->SetStringField(TEXT("class"), Actor->GetClass()->GetPathName());
						ActorEntry->SetStringField(TEXT("path"),  Actor->GetPathName());
						Selected.Add(MakeShared<FJsonValueObject>(ActorEntry));
					}
				}
			}
			Result->SetArrayField(TEXT("selected_actors"), Selected);
			Result->SetNumberField(TEXT("num_selected"),   Selected.Num());

			// Viewport — active level-editor viewport's camera location/rotation/FOV if available
			if (GCurrentLevelEditingViewportClient)
			{
				const FVector   Loc = GCurrentLevelEditingViewportClient->GetViewLocation();
				const FRotator  Rot = GCurrentLevelEditingViewportClient->GetViewRotation();
				const float     FOV = GCurrentLevelEditingViewportClient->ViewFOV;

				TSharedPtr<FJsonObject> Viewport = MakeShared<FJsonObject>();
				TArray<TSharedPtr<FJsonValue>> LocArr;
				LocArr.Add(MakeShared<FJsonValueNumber>(Loc.X));
				LocArr.Add(MakeShared<FJsonValueNumber>(Loc.Y));
				LocArr.Add(MakeShared<FJsonValueNumber>(Loc.Z));
				Viewport->SetArrayField(TEXT("location"), LocArr);

				TArray<TSharedPtr<FJsonValue>> RotArr;
				RotArr.Add(MakeShared<FJsonValueNumber>(Rot.Pitch));
				RotArr.Add(MakeShared<FJsonValueNumber>(Rot.Yaw));
				RotArr.Add(MakeShared<FJsonValueNumber>(Rot.Roll));
				Viewport->SetArrayField(TEXT("rotation"), RotArr);

				Viewport->SetNumberField(TEXT("fov"), FOV);
				Result->SetObjectField(TEXT("viewport"), Viewport);
			}

			// PIE status
			Result->SetBoolField(TEXT("pie_running"), GEditor->IsPlaySessionInProgress());

			BuildSuccessResponse(OutResponse, Result);
		}

		// ── start_pie / stop_pie / is_pie_running ─────────────

		void HandleStartPie(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!GEditor)
			{
				BuildErrorResponse(OutResponse, TEXT("GEditor is null"), TEXT("NO_EDITOR"));
				return;
			}
			if (GEditor->IsPlaySessionInProgress())
			{
				BuildErrorResponse(OutResponse, TEXT("PIE session already running"), TEXT("ALREADY_RUNNING"));
				return;
			}

			// Request a standard PIE session. FRequestPlaySessionParams gives us control over
			// viewport vs standalone; for now start-in-viewport matches the tools.yaml default
			// ("mode: viewport"). Advanced modes (new-window, mobile preview) deferred to a
			// follow-on amendment.
			FRequestPlaySessionParams PlayParams;
			// Leave SessionDestination empty → plays in editor viewport by default.

			FString Mode;
			if (Params.IsValid() && Params->TryGetStringField(TEXT("mode"), Mode))
			{
				if (Mode.Equals(TEXT("standalone"), ESearchCase::IgnoreCase))
				{
					PlayParams.SessionDestination = EPlaySessionDestinationType::NewProcess;
				}
				else if (Mode.Equals(TEXT("new_window"), ESearchCase::IgnoreCase))
				{
					PlayParams.SessionDestination = EPlaySessionDestinationType::InProcess;
				}
				// default / "viewport" → leave default
			}

			GEditor->RequestPlaySession(PlayParams);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("requested"), true);
			Result->SetStringField(TEXT("mode"), Mode.IsEmpty() ? TEXT("viewport") : Mode);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleStopPie(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!GEditor)
			{
				BuildErrorResponse(OutResponse, TEXT("GEditor is null"), TEXT("NO_EDITOR"));
				return;
			}
			if (!GEditor->IsPlaySessionInProgress() && !GEditor->PlayWorld)
			{
				TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
				Result->SetBoolField(TEXT("was_running"), false);
				BuildSuccessResponse(OutResponse, Result);
				return;
			}

			GEditor->RequestEndPlayMap();

			// Note: PIE teardown is async — the world may tear down after we return.
			// Handoff §Biggest-load-bearing-unknowns (4) flags this as a known risk.
			// We return success based on the request being issued, not completion.
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("was_running"),   true);
			Result->SetBoolField(TEXT("requested_stop"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleIsPieRunning(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("running"), GEditor && GEditor->IsPlaySessionInProgress());
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── execute_console_command ────────────────────────────

		void HandleExecuteConsoleCommand(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("execute_console_command requires params.command"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Command;
			if (!Params->TryGetStringField(TEXT("command"), Command) || Command.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("execute_console_command requires non-empty command"), TEXT("MISSING_PARAMS"));
				return;
			}

			UWorld* World = nullptr;
			if (GEditor)
			{
				World = GEditor->PlayWorld ? GEditor->PlayWorld.Get() : GEditor->GetEditorWorldContext().World();
			}
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("No UWorld available to execute command against"), TEXT("NO_WORLD"));
				return;
			}

			const bool bOk = GEngine->Exec(World, *Command);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("executed"), bOk);
			Result->SetStringField(TEXT("command"), Command);
			Result->SetStringField(TEXT("world"),   World->GetName());
			BuildSuccessResponse(OutResponse, Result);
		}

		// ── get_widget_blueprint ──────────────────────────────

		TSharedPtr<FJsonObject> SerializeWidget(UWidget* Widget)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Widget) return Out;
			Out->SetStringField(TEXT("name"),  Widget->GetName());
			Out->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
			return Out;
		}

		void WalkWidgetTree(UWidget* Root, const TSharedRef<FJsonObject>& RootJson, UWidgetTree* Tree)
		{
			if (!Root) return;
			TArray<TSharedPtr<FJsonValue>> Children;

			// UPanelWidget is the common base for widgets-with-children, but we use the
			// generic UWidgetTree::ForEachWidget... pattern by casting to panel.
			if (UPanelWidget* Panel = Cast<UPanelWidget>(Root))
			{
				for (int32 i = 0; i < Panel->GetChildrenCount(); ++i)
				{
					UWidget* Child = Panel->GetChildAt(i);
					TSharedRef<FJsonObject> ChildJson = MakeShared<FJsonObject>();
					ChildJson->SetStringField(TEXT("name"),  Child ? Child->GetName() : TEXT(""));
					ChildJson->SetStringField(TEXT("class"), Child ? Child->GetClass()->GetName() : TEXT(""));
					WalkWidgetTree(Child, ChildJson, Tree);
					Children.Add(MakeShared<FJsonValueObject>(ChildJson));
				}
			}
			RootJson->SetArrayField(TEXT("children"), Children);
		}

		void HandleGetWidgetBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_widget_blueprint requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_widget_blueprint requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UObject* Loaded = nullptr;
			if (UObject* Obj = LoadObject<UObject>(nullptr, *AssetPath))
			{
				Loaded = Obj;
			}
			else
			{
				const FSoftObjectPath Soft(AssetPath);
				Loaded = Soft.TryLoad();
			}
			UWidgetBlueprint* WBP = Cast<UWidgetBlueprint>(Loaded);
			if (!WBP)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset at '%s' is not a UWidgetBlueprint"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),   WBP->GetPathName());
			Result->SetStringField(TEXT("parent_class"), WBP->ParentClass ? WBP->ParentClass->GetPathName() : TEXT(""));

			if (WBP->WidgetTree && WBP->WidgetTree->RootWidget)
			{
				TSharedRef<FJsonObject> RootJson = MakeShared<FJsonObject>();
				RootJson->SetStringField(TEXT("name"),  WBP->WidgetTree->RootWidget->GetName());
				RootJson->SetStringField(TEXT("class"), WBP->WidgetTree->RootWidget->GetClass()->GetName());
				WalkWidgetTree(WBP->WidgetTree->RootWidget, RootJson, WBP->WidgetTree);
				Result->SetObjectField(TEXT("root_widget"), RootJson);
			}
			else
			{
				// Empty widget tree is valid (newly-created WBP) — emit null, don't error.
				Result->SetField(TEXT("root_widget"), MakeShared<FJsonValueNull>());
			}

			BuildSuccessResponse(OutResponse, Result);
		}

		// ── get_asset_references ──────────────────────────────

		void HandleGetAssetReferences(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_asset_references requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_asset_references requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
			IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();

			// AssetPath may be either a package name (`/Game/...`) or full object path
			// (`/Game/....X.X_C`). GetReferencers expects a package name. Strip the object
			// suffix if present.
			FString PackageName = AssetPath;
			int32 DotIdx;
			if (PackageName.FindChar('.', DotIdx))
			{
				PackageName.LeftInline(DotIdx);
			}

			TArray<FName> Referencers;
			TArray<FName> Dependencies;
			AssetRegistry.GetReferencers(FName(*PackageName), Referencers);
			AssetRegistry.GetDependencies(FName(*PackageName), Dependencies);

			TArray<TSharedPtr<FJsonValue>> RefArr;
			for (FName R : Referencers)
			{
				RefArr.Add(MakeShared<FJsonValueString>(R.ToString()));
			}
			TArray<TSharedPtr<FJsonValue>> DepArr;
			for (FName D : Dependencies)
			{
				DepArr.Add(MakeShared<FJsonValueString>(D.ToString()));
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),       AssetPath);
			Result->SetStringField(TEXT("package_name"),     PackageName);
			Result->SetArrayField(TEXT("referencers"),       RefArr);
			Result->SetArrayField(TEXT("dependencies"),      DepArr);
			Result->SetNumberField(TEXT("num_referencers"),  RefArr.Num());
			Result->SetNumberField(TEXT("num_dependencies"), DepArr.Num());

			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterEdgeCaseHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("get_editor_state"),        &HandleGetEditorState);
		Registry.Register(TEXT("start_pie"),               &HandleStartPie);
		Registry.Register(TEXT("stop_pie"),                &HandleStopPie);
		Registry.Register(TEXT("is_pie_running"),          &HandleIsPieRunning);
		Registry.Register(TEXT("execute_console_command"), &HandleExecuteConsoleCommand);
		Registry.Register(TEXT("get_widget_blueprint"),    &HandleGetWidgetBlueprint);
		Registry.Register(TEXT("get_asset_references"),    &HandleGetAssetReferences);
	}
}
