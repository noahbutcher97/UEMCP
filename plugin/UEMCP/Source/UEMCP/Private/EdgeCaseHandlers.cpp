// Copyright Optimum Athena. All Rights Reserved.
#include "EdgeCaseHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Blueprint/WidgetTree.h"
#include "Components/PanelWidget.h"
#include "Components/SceneComponent.h"
#include "Components/Widget.h"
#include "EdGraph/EdGraph.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/Blueprint.h"
#include "Engine/Engine.h"
#include "Engine/Level.h"
#include "Engine/Selection.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "LevelEditorViewport.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"
#include "UObject/Package.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UObjectIterator.h"
#include "UObject/UnrealType.h"
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
				// W-G (D144): pre-fold this silently fell through to viewport
				// for any unrecognized mode (Gauntlet Findings 4.3 + 4.7,
				// silent-success-on-edge-case). W-B's Zod enum already gates
				// this at the JS layer; the explicit C++ error path is
				// defense-in-depth for callers that bypass the JS schema
				// (e.g. direct TCP wire calls).
				if (Mode.Equals(TEXT("standalone"), ESearchCase::IgnoreCase))
				{
					PlayParams.SessionDestination = EPlaySessionDestinationType::NewProcess;
				}
				else if (Mode.Equals(TEXT("new_window"), ESearchCase::IgnoreCase))
				{
					PlayParams.SessionDestination = EPlaySessionDestinationType::InProcess;
				}
				else if (!Mode.Equals(TEXT("viewport"), ESearchCase::IgnoreCase))
				{
					TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
					TArray<TSharedPtr<FJsonValue>> Allowed;
					Allowed.Add(MakeShared<FJsonValueString>(TEXT("viewport")));
					Allowed.Add(MakeShared<FJsonValueString>(TEXT("standalone")));
					Allowed.Add(MakeShared<FJsonValueString>(TEXT("new_window")));
					Detail->SetArrayField (TEXT("allowed_values"), Allowed);
					Detail->SetStringField(TEXT("provided"),       Mode);
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("Invalid PIE mode '%s'"), *Mode),
						TEXT("INVALID_PIE_MODE"),
						Detail);
					return;
				}
				// "viewport" (explicit) → leave SessionDestination default
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

		// ── PIE runtime observation ───────────────────────────

		TArray<TSharedPtr<FJsonValue>> PIEVec3ToJson(const FVector& V)
		{
			TArray<TSharedPtr<FJsonValue>> Arr;
			Arr.Add(MakeShared<FJsonValueNumber>(V.X));
			Arr.Add(MakeShared<FJsonValueNumber>(V.Y));
			Arr.Add(MakeShared<FJsonValueNumber>(V.Z));
			return Arr;
		}

		TArray<TSharedPtr<FJsonValue>> PIERotatorToJson(const FRotator& R)
		{
			TArray<TSharedPtr<FJsonValue>> Arr;
			Arr.Add(MakeShared<FJsonValueNumber>(R.Pitch));
			Arr.Add(MakeShared<FJsonValueNumber>(R.Yaw));
			Arr.Add(MakeShared<FJsonValueNumber>(R.Roll));
			return Arr;
		}

		TSharedPtr<FJsonObject> TransformToJson(const FTransform& Transform)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetArrayField(TEXT("location"), PIEVec3ToJson(Transform.GetLocation()));
			Out->SetArrayField(TEXT("rotation"), PIERotatorToJson(Transform.Rotator()));
			Out->SetArrayField(TEXT("scale"), PIEVec3ToJson(Transform.GetScale3D()));
			return Out;
		}

		FString NetModeToString(ENetMode NetMode)
		{
			switch (NetMode)
			{
			case NM_Standalone: return TEXT("Standalone");
			case NM_DedicatedServer: return TEXT("DedicatedServer");
			case NM_ListenServer: return TEXT("ListenServer");
			case NM_Client: return TEXT("Client");
			default: return TEXT("Unknown");
			}
		}

		TArray<FWorldContext*> GetActivePIEWorldContexts()
		{
			TArray<FWorldContext*> Contexts;
			if (!GEngine)
			{
				return Contexts;
			}
			for (FWorldContext& Context : GEngine->GetWorldContexts())
			{
				if (Context.WorldType == EWorldType::PIE && Context.World())
				{
					Contexts.Add(&Context);
				}
			}
			return Contexts;
		}

		TSharedPtr<FJsonObject> SerializePIEWorldContext(const FWorldContext& Context, bool bIsDefault)
		{
			UWorld* World = Context.World();
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetNumberField(TEXT("pie_instance"), Context.PIEInstance);
			Out->SetStringField(TEXT("world_name"), World ? World->GetName() : TEXT(""));
			Out->SetStringField(TEXT("world_path"), World ? World->GetPathName() : TEXT(""));
			Out->SetStringField(TEXT("net_mode"), World ? NetModeToString(World->GetNetMode()) : TEXT("Unknown"));
			Out->SetBoolField(TEXT("is_default"), bIsDefault);
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializePIEWorldContexts(const TArray<FWorldContext*>& Contexts)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			for (int32 Index = 0; Index < Contexts.Num(); ++Index)
			{
				if (Contexts[Index])
				{
					Out.Add(MakeShared<FJsonValueObject>(SerializePIEWorldContext(*Contexts[Index], Index == 0)));
				}
			}
			return Out;
		}

		void HandleGetPIESessionState(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			const TArray<FWorldContext*> Contexts = GetActivePIEWorldContexts();

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("pie_running"), GEditor && GEditor->IsPlaySessionInProgress());
			Result->SetNumberField(TEXT("active_context_count"), Contexts.Num());
			Result->SetNumberField(TEXT("default_pie_instance"), Contexts.Num() > 0 && Contexts[0] ? Contexts[0]->PIEInstance : -1);
			Result->SetArrayField(TEXT("contexts"), SerializePIEWorldContexts(Contexts));
			BuildSuccessResponse(OutResponse, Result);
		}

		bool SelectPIEWorld(
			const TSharedPtr<FJsonObject>& Params,
			UWorld*& OutWorld,
			TSharedPtr<FJsonObject>& OutWorldJson,
			TSharedPtr<FJsonObject>& OutErrorDetail,
			FString& OutErrorCode,
			FString& OutErrorMessage)
		{
			OutWorld = nullptr;
			OutWorldJson = nullptr;
			OutErrorDetail = nullptr;
			OutErrorCode.Empty();
			OutErrorMessage.Empty();

			const TArray<FWorldContext*> Contexts = GetActivePIEWorldContexts();
			if (Contexts.Num() == 0)
			{
				OutErrorDetail = MakeShared<FJsonObject>();
				OutErrorDetail->SetBoolField(TEXT("pie_running"), false);
				OutErrorDetail->SetArrayField(TEXT("contexts"), SerializePIEWorldContexts(Contexts));
				OutErrorCode = TEXT("PIE_NOT_RUNNING");
				OutErrorMessage = TEXT("PIE is not running; start PIE before reading runtime actor state");
				return false;
			}

			bool bHasPIEInstance = false;
			double PIEInstanceNumber = 0.0;
			if (Params.IsValid())
			{
				bHasPIEInstance = Params->TryGetNumberField(TEXT("pie_instance"), PIEInstanceNumber);
			}

			FString WorldPath;
			const bool bHasWorldPath = Params.IsValid() && Params->TryGetStringField(TEXT("world_path"), WorldPath) && !WorldPath.IsEmpty();

			if (bHasPIEInstance)
			{
				const int32 RequestedPIEInstance = static_cast<int32>(PIEInstanceNumber);
				for (FWorldContext* Context : Contexts)
				{
					if (Context && Context->PIEInstance == RequestedPIEInstance && Context->World())
					{
						OutWorld = Context->World();
						OutWorldJson = SerializePIEWorldContext(*Context, Context == Contexts[0]);
						return true;
					}
				}
				OutErrorDetail = MakeShared<FJsonObject>();
				OutErrorDetail->SetNumberField(TEXT("pie_instance"), RequestedPIEInstance);
				OutErrorDetail->SetArrayField(TEXT("contexts"), SerializePIEWorldContexts(Contexts));
				OutErrorCode = TEXT("PIE_WORLD_NOT_FOUND");
				OutErrorMessage = FString::Printf(TEXT("PIE world instance %d was not found"), RequestedPIEInstance);
				return false;
			}

			if (bHasWorldPath)
			{
				for (FWorldContext* Context : Contexts)
				{
					UWorld* World = Context ? Context->World() : nullptr;
					if (!World)
					{
						continue;
					}
					if (World->GetPathName() == WorldPath || World->GetName() == WorldPath || FPackageName::GetShortName(World->GetPathName()) == WorldPath)
					{
						OutWorld = World;
						OutWorldJson = SerializePIEWorldContext(*Context, Context == Contexts[0]);
						return true;
					}
				}
				OutErrorDetail = MakeShared<FJsonObject>();
				OutErrorDetail->SetStringField(TEXT("world_path"), WorldPath);
				OutErrorDetail->SetArrayField(TEXT("contexts"), SerializePIEWorldContexts(Contexts));
				OutErrorCode = TEXT("PIE_WORLD_NOT_FOUND");
				OutErrorMessage = FString::Printf(TEXT("PIE world '%s' was not found"), *WorldPath);
				return false;
			}

			if (Contexts.Num() > 1)
			{
				OutErrorDetail = MakeShared<FJsonObject>();
				OutErrorDetail->SetArrayField(TEXT("contexts"), SerializePIEWorldContexts(Contexts));
				OutErrorCode = TEXT("AMBIGUOUS_PIE_WORLD");
				OutErrorMessage = TEXT("Multiple PIE worlds are active; provide pie_instance or world_path");
				return false;
			}

			OutWorld = Contexts[0]->World();
			OutWorldJson = SerializePIEWorldContext(*Contexts[0], true);
			return OutWorld != nullptr;
		}

		FString GetShortLevelName(AActor* Actor)
		{
			if (!Actor || !Actor->GetLevel())
			{
				return TEXT("");
			}
			return FPackageName::GetShortName(Actor->GetLevel()->GetOutermost()->GetName());
		}

		FString ActorNameFromObjectPath(const FString& ObjectPath)
		{
			FString Tail = ObjectPath;
			int32 DotIdx = INDEX_NONE;
			if (Tail.FindLastChar(TEXT('.'), DotIdx))
			{
				Tail = Tail.Mid(DotIdx + 1);
			}
			int32 ColonIdx = INDEX_NONE;
			if (Tail.FindLastChar(TEXT(':'), ColonIdx))
			{
				Tail = Tail.Mid(ColonIdx + 1);
			}
			return Tail;
		}

		struct FRuntimeActorResolution
		{
			AActor* Actor = nullptr;
			FString MatchedBy;
			TArray<AActor*> AmbiguousCandidates;
			TArray<FString> SearchedLevels;
		};

		FRuntimeActorResolution ResolveRuntimeActor(UWorld* World, const TSharedPtr<FJsonObject>& ActorRef)
		{
			FRuntimeActorResolution Result;
			if (!World || !ActorRef.IsValid())
			{
				return Result;
			}

			FString Name;
			FString Label;
			FString ObjectPath;
			FString EditorObjectPath;
			FString LevelName;
			ActorRef->TryGetStringField(TEXT("name"), Name);
			ActorRef->TryGetStringField(TEXT("label"), Label);
			ActorRef->TryGetStringField(TEXT("object_path"), ObjectPath);
			ActorRef->TryGetStringField(TEXT("editor_object_path"), EditorObjectPath);
			ActorRef->TryGetStringField(TEXT("level_name"), LevelName);

			auto WalkActors = [&](TFunctionRef<void(AActor*)> Visitor)
			{
				for (ULevel* Level : World->GetLevels())
				{
					if (!Level)
					{
						continue;
					}
					const FString FullLevelName = Level->GetOutermost()->GetName();
					const FString ShortLevelName = FPackageName::GetShortName(FullLevelName);
					if (!LevelName.IsEmpty() && FullLevelName != LevelName && ShortLevelName != LevelName)
					{
						continue;
					}
					Result.SearchedLevels.AddUnique(ShortLevelName);
					for (AActor* Actor : Level->Actors)
					{
						if (IsValid(Actor))
						{
							Visitor(Actor);
						}
					}
				}
			};

			if (!ObjectPath.IsEmpty())
			{
				WalkActors([&](AActor* Actor)
				{
					if (!Result.Actor && Actor->GetPathName() == ObjectPath)
					{
						Result.Actor = Actor;
						Result.MatchedBy = TEXT("object_path");
					}
				});
				if (Result.Actor)
				{
					return Result;
				}
			}

			auto MatchSingle = [&](const FString& Candidate, const FString& MatchKind)
			{
				if (Candidate.IsEmpty() || Result.Actor || Result.AmbiguousCandidates.Num() > 0)
				{
					return;
				}
				TArray<AActor*> Matches;
				WalkActors([&](AActor* Actor)
				{
					if (MatchKind == TEXT("name") && Actor->GetName() == Candidate)
					{
						Matches.Add(Actor);
					}
					else if (MatchKind == TEXT("label") && Actor->GetActorLabel() == Candidate)
					{
						Matches.Add(Actor);
					}
				});
				if (Matches.Num() == 1)
				{
					Result.Actor = Matches[0];
					Result.MatchedBy = MatchKind;
				}
				else if (Matches.Num() > 1)
				{
					Result.AmbiguousCandidates = Matches;
					Result.MatchedBy = MatchKind;
				}
			};

			MatchSingle(Name, TEXT("name"));
			MatchSingle(Label, TEXT("label"));
			MatchSingle(ActorNameFromObjectPath(EditorObjectPath), TEXT("editor_object_path"));
			return Result;
		}

		TArray<TSharedPtr<FJsonValue>> ActorCandidatesToJson(const TArray<AActor*>& Actors)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			for (AActor* Actor : Actors)
			{
				if (!IsValid(Actor))
				{
					continue;
				}
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("name"), Actor->GetName());
				Entry->SetStringField(TEXT("label"), Actor->GetActorLabel());
				Entry->SetStringField(TEXT("object_path"), Actor->GetPathName());
				Entry->SetStringField(TEXT("level"), GetShortLevelName(Actor));
				Out.Add(MakeShared<FJsonValueObject>(Entry));
			}
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeResolvedActor(AActor* Actor, const FString& MatchedBy)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetStringField(TEXT("matched_by"), MatchedBy);
			Out->SetStringField(TEXT("name"), Actor ? Actor->GetName() : TEXT(""));
			Out->SetStringField(TEXT("label"), Actor ? Actor->GetActorLabel() : TEXT(""));
			Out->SetStringField(TEXT("object_path"), Actor ? Actor->GetPathName() : TEXT(""));
			Out->SetStringField(TEXT("class"), Actor && Actor->GetClass() ? Actor->GetClass()->GetPathName() : TEXT(""));
			Out->SetStringField(TEXT("level"), GetShortLevelName(Actor));
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeSceneComponentState(USceneComponent* Component)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Component)
			{
				return Out;
			}
			Out->SetStringField(TEXT("name"), Component->GetName());
			Out->SetStringField(TEXT("class"), Component->GetClass() ? Component->GetClass()->GetPathName() : TEXT(""));
			Out->SetObjectField(TEXT("relative_transform"), TransformToJson(Component->GetRelativeTransform()));
			Out->SetObjectField(TEXT("world_transform"), TransformToJson(Component->GetComponentTransform()));
			return Out;
		}

		bool ComponentMatchesFilter(UActorComponent* Component, const TSet<FString>& Filter)
		{
			if (!Component)
			{
				return false;
			}
			return Filter.Num() == 0 || Filter.Contains(Component->GetName());
		}

		void SetSimplePropertyValue(TSharedPtr<FJsonObject> Out, UObject* Object, FProperty* Property)
		{
			if (!Out.IsValid() || !Object || !Property)
			{
				return;
			}
			const void* ValuePtr = Property->ContainerPtrToValuePtr<void>(Object);
			if (FNumericProperty* Numeric = CastField<FNumericProperty>(Property))
			{
				if (Numeric->IsInteger())
				{
					Out->SetNumberField(Property->GetName(), static_cast<double>(Numeric->GetSignedIntPropertyValue(ValuePtr)));
				}
				else
				{
					Out->SetNumberField(Property->GetName(), Numeric->GetFloatingPointPropertyValue(ValuePtr));
				}
			}
			else if (FBoolProperty* Bool = CastField<FBoolProperty>(Property))
			{
				Out->SetBoolField(Property->GetName(), Bool->GetPropertyValue(ValuePtr));
			}
			else if (FStrProperty* Str = CastField<FStrProperty>(Property))
			{
				Out->SetStringField(Property->GetName(), Str->GetPropertyValue(ValuePtr));
			}
			else if (FNameProperty* Name = CastField<FNameProperty>(Property))
			{
				Out->SetStringField(Property->GetName(), Name->GetPropertyValue(ValuePtr).ToString());
			}
			else if (FTextProperty* Text = CastField<FTextProperty>(Property))
			{
				Out->SetStringField(Property->GetName(), Text->GetPropertyValue(ValuePtr).ToString());
			}
		}

		TSharedPtr<FJsonObject> SerializeSelectedProperties(AActor* Actor, const TArray<TSharedPtr<FJsonValue>>* PropertyNames)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Actor || !PropertyNames)
			{
				return Out;
			}
			for (const TSharedPtr<FJsonValue>& Entry : *PropertyNames)
			{
				FString PropertyName;
				if (!Entry.IsValid() || !Entry->TryGetString(PropertyName) || PropertyName.IsEmpty())
				{
					continue;
				}
				if (FProperty* Property = Actor->GetClass()->FindPropertyByName(FName(*PropertyName)))
				{
					SetSimplePropertyValue(Out, Actor, Property);
				}
			}
			return Out;
		}

		void HandleGetPIEActorState(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_pie_actor_state requires params.actor_ref"), TEXT("MISSING_PARAMS"));
				return;
			}

			TSharedPtr<FJsonObject> ActorRef;
			if (!Params->TryGetObjectField(TEXT("actor_ref"), ActorRef) || !ActorRef.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_pie_actor_state requires params.actor_ref"), TEXT("MISSING_PARAMS"));
				return;
			}

			UWorld* World = nullptr;
			TSharedPtr<FJsonObject> WorldJson;
			TSharedPtr<FJsonObject> ErrorDetail;
			FString ErrorCode;
			FString ErrorMessage;
			if (!SelectPIEWorld(Params, World, WorldJson, ErrorDetail, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode, ErrorDetail);
				return;
			}

			const FRuntimeActorResolution Resolution = ResolveRuntimeActor(World, ActorRef);
			if (Resolution.AmbiguousCandidates.Num() > 0)
			{
				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				Detail->SetObjectField(TEXT("world"), WorldJson);
				Detail->SetStringField(TEXT("matched_by"), Resolution.MatchedBy);
				Detail->SetArrayField(TEXT("candidates"), ActorCandidatesToJson(Resolution.AmbiguousCandidates));
				BuildErrorResponse(OutResponse, TEXT("Multiple PIE actors match actor_ref"), TEXT("AMBIGUOUS_ACTOR"), Detail);
				return;
			}
			if (!Resolution.Actor)
			{
				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				Detail->SetObjectField(TEXT("world"), WorldJson);
				TArray<TSharedPtr<FJsonValue>> SearchedLevels;
				for (const FString& Level : Resolution.SearchedLevels)
				{
					SearchedLevels.Add(MakeShared<FJsonValueString>(Level));
				}
				Detail->SetArrayField(TEXT("searched_levels"), SearchedLevels);
				Detail->SetStringField(TEXT("world_context"), TEXT("pie"));
				BuildErrorResponse(OutResponse, TEXT("Actor was not found in the selected PIE world"), TEXT("ACTOR_NOT_FOUND"), Detail);
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetObjectField(TEXT("world"), WorldJson);
			Result->SetObjectField(TEXT("resolved"), SerializeResolvedActor(Resolution.Actor, Resolution.MatchedBy));
			Result->SetObjectField(TEXT("transform"), TransformToJson(Resolution.Actor->GetActorTransform()));

			if (USceneComponent* Root = Resolution.Actor->GetRootComponent())
			{
				Result->SetObjectField(TEXT("root_component"), SerializeSceneComponentState(Root));
			}

			bool bIncludeComponents = false;
			Params->TryGetBoolField(TEXT("include_components"), bIncludeComponents);
			const TArray<TSharedPtr<FJsonValue>>* ComponentFilterValues = nullptr;
			Params->TryGetArrayField(TEXT("component_filter"), ComponentFilterValues);
			TSet<FString> ComponentFilter;
			if (ComponentFilterValues)
			{
				for (const TSharedPtr<FJsonValue>& Value : *ComponentFilterValues)
				{
					FString ComponentName;
					if (Value.IsValid() && Value->TryGetString(ComponentName) && !ComponentName.IsEmpty())
					{
						ComponentFilter.Add(ComponentName);
					}
				}
			}

			if (bIncludeComponents || ComponentFilter.Num() > 0)
			{
				TArray<TSharedPtr<FJsonValue>> Components;
				TSet<FString> FoundFilteredComponents;
				TArray<USceneComponent*> SceneComponents;
				Resolution.Actor->GetComponents<USceneComponent>(SceneComponents);
				for (USceneComponent* Component : SceneComponents)
				{
					if (!ComponentMatchesFilter(Component, ComponentFilter))
					{
						continue;
					}
					Components.Add(MakeShared<FJsonValueObject>(SerializeSceneComponentState(Component)));
					FoundFilteredComponents.Add(Component->GetName());
				}
				if (ComponentFilter.Num() > 0)
				{
					TArray<TSharedPtr<FJsonValue>> Missing;
					for (const FString& Requested : ComponentFilter)
					{
						if (!FoundFilteredComponents.Contains(Requested))
						{
							Missing.Add(MakeShared<FJsonValueString>(Requested));
						}
					}
					if (Missing.Num() > 0)
					{
						TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
						Detail->SetObjectField(TEXT("world"), WorldJson);
						Detail->SetObjectField(TEXT("resolved"), SerializeResolvedActor(Resolution.Actor, Resolution.MatchedBy));
						Detail->SetArrayField(TEXT("missing_components"), Missing);
						BuildErrorResponse(OutResponse, TEXT("Requested component was not found on the PIE actor"), TEXT("COMPONENT_NOT_FOUND"), Detail);
						return;
					}
				}
				Result->SetArrayField(TEXT("components"), Components);
			}

			const TArray<TSharedPtr<FJsonValue>>* PropertyNames = nullptr;
			if (Params->TryGetArrayField(TEXT("properties"), PropertyNames))
			{
				Result->SetObjectField(TEXT("properties"), SerializeSelectedProperties(Resolution.Actor, PropertyNames));
			}

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
		Registry.Register(TEXT("get_pie_session_state"),   &HandleGetPIESessionState);
		Registry.Register(TEXT("get_pie_actor_state"),     &HandleGetPIEActorState);
		Registry.Register(TEXT("execute_console_command"), &HandleExecuteConsoleCommand);
		Registry.Register(TEXT("get_widget_blueprint"),    &HandleGetWidgetBlueprint);
		Registry.Register(TEXT("get_asset_references"),    &HandleGetAssetReferences);
	}
}
