// Copyright Optimum Athena. All Rights Reserved.
#include "ActorHandlers.h"

#include "ActorLookupHelper.h"
#include "BlueprintLookupHelper.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "PropertyHandlerRegistry.h"
#include "TransformParser.h"

#include "Camera/CameraActor.h"
#include "Editor.h"
#include "EditorViewportClient.h"
#include "Engine/Blueprint.h"
#include "Engine/DirectionalLight.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Level.h"
#include "Engine/PointLight.h"
#include "Engine/SpotLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "Kismet/GameplayStatics.h"
#include "LevelEditorViewport.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	namespace
	{
		// ── JSON helpers (oracle-parity vector/rotator shapes) ───────────────────
		//
		// Vector/rotator INPUT parsing is delegated to UEMCP::ParseVector3 / ParseRotator
		// (W-E adoption — see TransformParser.h). Output formatters stay local because
		// they're oracle-parity wire shapes ([x,y,z] vector, [pitch,yaw,roll] rotator)
		// and have no equivalent in TransformParser.

		TArray<TSharedPtr<FJsonValue>> Vec3ToJson(const FVector& V)
		{
			TArray<TSharedPtr<FJsonValue>> Arr;
			Arr.Add(MakeShared<FJsonValueNumber>(V.X));
			Arr.Add(MakeShared<FJsonValueNumber>(V.Y));
			Arr.Add(MakeShared<FJsonValueNumber>(V.Z));
			return Arr;
		}

		TArray<TSharedPtr<FJsonValue>> RotatorToJson(const FRotator& R)
		{
			TArray<TSharedPtr<FJsonValue>> Arr;
			Arr.Add(MakeShared<FJsonValueNumber>(R.Pitch));
			Arr.Add(MakeShared<FJsonValueNumber>(R.Yaw));
			Arr.Add(MakeShared<FJsonValueNumber>(R.Roll));
			return Arr;
		}

		/**
		 * Oracle-parity actor serialization. The oracle's `bDetailed` flag was a no-op
		 * (ActorToJsonObject ignored it). We emit the same 5 fields regardless so wire
		 * consumers see no shape difference. Future quality lift (component dump, tag
		 * list) can extend this without breaking parity by adding NEW fields.
		 */
		TSharedPtr<FJsonObject> ActorToJsonObject(AActor* Actor)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Actor)
			{
				return Out;
			}
			Out->SetStringField(TEXT("name"),  Actor->GetName());
			Out->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
			Out->SetArrayField(TEXT("location"), Vec3ToJson(Actor->GetActorLocation()));
			Out->SetArrayField(TEXT("rotation"), RotatorToJson(Actor->GetActorRotation()));
			Out->SetArrayField(TEXT("scale"),    Vec3ToJson(Actor->GetActorScale3D()));
			return Out;
		}

		// ── World resolution ─────────────────────────────────────────────────────

		UWorld* GetEditorWorld()
		{
			if (GEditor)
			{
				if (FWorldContext* Ctx = &GEditor->GetEditorWorldContext())
				{
					return Ctx->World();
				}
			}
			return GWorld;
		}

		/**
		 * Lookup an actor by exact name (FName or label) using ActorLookupHelper —
		 * walks persistent + streaming levels. Encodes the standard error envelopes
		 * for missing/ambiguous cases so each handler stays focused on its core work.
		 *
		 * Returns nullptr and populates OutResponse on failure; handler should `return`
		 * immediately when nullptr is returned.
		 */
		AActor* ResolveActorByName(const FString& Name, TSharedPtr<FJsonObject>& OutResponse)
		{
			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return nullptr;
			}
			const FActorLookupResult Result = FindActorInAllLevels(Name, World);
			if (Result.Actor)
			{
				return Result.Actor;
			}
			if (Result.AmbiguousCandidates.Num() > 0)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Multiple actors match '%s' across loaded levels"), *Name),
					TEXT("AMBIGUOUS_ACTOR"));
				return nullptr;
			}
			BuildErrorResponse(OutResponse,
				FString::Printf(TEXT("Actor not found: %s"), *Name),
				TEXT("ACTOR_NOT_FOUND"));
			return nullptr;
		}

		// ── Property setter (delegates to PropertyHandlerRegistry — W-E adoption) ─
		//
		// Resolves the property by name, then dispatches by FProperty class via
		// FPropertyHandlerRegistry::Handle. Registry covers Int/Float/Double/Bool/Str/Name
		// scalars + Byte/Enum (oracle-parity name resolution). Type-mismatch JSON now
		// fails with a typed error instead of silent coercion to zero — registry
		// contract per UEMCPTests.cpp PropertyHandlerRegistry.Invalid.

		bool SetActorPropertyValue(UObject* Object, const FString& PropertyName,
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

		// ═══════════════════════════════════════════════════════════════════════
		// Handlers
		// ═══════════════════════════════════════════════════════════════════════

		void HandleGetActorsInLevel(const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
		{
			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			TArray<TSharedPtr<FJsonValue>> ActorJson;
			for (ULevel* Level : World->GetLevels())
			{
				if (!Level) continue;
				for (AActor* Actor : Level->Actors)
				{
					if (!IsValid(Actor)) continue;
					ActorJson.Add(MakeShared<FJsonValueObject>(ActorToJsonObject(Actor)));
				}
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetArrayField(TEXT("actors"), ActorJson);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleFindActorsByName(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("find_actors_by_name requires params.pattern"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Pattern;
			if (!Params->TryGetStringField(TEXT("pattern"), Pattern))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'pattern' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			TArray<TSharedPtr<FJsonValue>> Matches;
			for (ULevel* Level : World->GetLevels())
			{
				if (!Level) continue;
				for (AActor* Actor : Level->Actors)
				{
					if (!IsValid(Actor)) continue;
					if (Actor->GetName().Contains(Pattern))
					{
						Matches.Add(MakeShared<FJsonValueObject>(ActorToJsonObject(Actor)));
					}
				}
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetArrayField(TEXT("actors"), Matches);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleSpawnActor(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("spawn_actor requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString ActorType, ActorName;
			if (!Params->TryGetStringField(TEXT("type"), ActorType))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'type' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("name"), ActorName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			FVector Location(0.0f);
			FRotator Rotation(0.0f);
			FVector Scale(1.0f);
			FString TransformErr;
			if (Params->HasField(TEXT("location"))) UEMCP::ParseVector3(Params, TEXT("location"), Location, TransformErr);
			if (Params->HasField(TEXT("rotation"))) UEMCP::ParseRotator(Params, TEXT("rotation"), Rotation, TransformErr);
			if (Params->HasField(TEXT("scale")))    UEMCP::ParseVector3(Params, TEXT("scale"),    Scale,    TransformErr);

			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			// Name collision check across all loaded levels.
			for (ULevel* Level : World->GetLevels())
			{
				if (!Level) continue;
				for (AActor* Existing : Level->Actors)
				{
					if (IsValid(Existing) && Existing->GetName() == ActorName)
					{
						BuildErrorResponse(OutResponse,
							FString::Printf(TEXT("Actor with name '%s' already exists"), *ActorName),
							TEXT("NAME_COLLISION"));
						return;
					}
				}
			}

			FActorSpawnParameters SpawnParams;
			SpawnParams.Name = *ActorName;
			AActor* NewActor = nullptr;
			if (ActorType == TEXT("StaticMeshActor"))
			{
				NewActor = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), Location, Rotation, SpawnParams);
			}
			else if (ActorType == TEXT("PointLight"))
			{
				NewActor = World->SpawnActor<APointLight>(APointLight::StaticClass(), Location, Rotation, SpawnParams);
			}
			else if (ActorType == TEXT("SpotLight"))
			{
				NewActor = World->SpawnActor<ASpotLight>(ASpotLight::StaticClass(), Location, Rotation, SpawnParams);
			}
			else if (ActorType == TEXT("DirectionalLight"))
			{
				NewActor = World->SpawnActor<ADirectionalLight>(ADirectionalLight::StaticClass(), Location, Rotation, SpawnParams);
			}
			else if (ActorType == TEXT("CameraActor"))
			{
				NewActor = World->SpawnActor<ACameraActor>(ACameraActor::StaticClass(), Location, Rotation, SpawnParams);
			}
			else
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown actor type: %s"), *ActorType),
					TEXT("UNKNOWN_TYPE"));
				return;
			}

			if (!NewActor)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create actor"), TEXT("SPAWN_FAILED"));
				return;
			}

			// D131 NEW-9b: outliner display label. SpawnParams.Name only sets the
			// internal FName; without SetActorLabel the outliner shows the class
			// name (e.g. "PointLight") instead of ActorName.
			if (!ActorName.IsEmpty())
			{
				NewActor->SetActorLabel(*ActorName);
			}

			// Apply scale post-spawn (SpawnActor takes only Location/Rotation).
			FTransform Xform = NewActor->GetTransform();
			Xform.SetScale3D(Scale);
			NewActor->SetActorTransform(Xform);

			BuildSuccessResponse(OutResponse, ActorToJsonObject(NewActor));
		}

		void HandleDeleteActor(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("delete_actor requires params.name"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("name"), Name))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			AActor* Actor = ResolveActorByName(Name, OutResponse);
			if (!Actor) return;

			// Capture info BEFORE destroying — the actor pointer dangles after Destroy().
			TSharedPtr<FJsonObject> Captured = ActorToJsonObject(Actor);
			Actor->Destroy();

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetObjectField(TEXT("deleted_actor"), Captured);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleSetActorTransform(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("set_actor_transform requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("name"), Name))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			AActor* Actor = ResolveActorByName(Name, OutResponse);
			if (!Actor) return;

			// Partial-update: read current, overlay any specified fields.
			FTransform Xform = Actor->GetTransform();
			FString TransformErr;
			if (Params->HasField(TEXT("location")))
			{
				FVector Loc = Xform.GetLocation();
				if (UEMCP::ParseVector3(Params, TEXT("location"), Loc, TransformErr)) Xform.SetLocation(Loc);
			}
			if (Params->HasField(TEXT("rotation")))
			{
				FRotator Rot = Xform.GetRotation().Rotator();
				if (UEMCP::ParseRotator(Params, TEXT("rotation"), Rot, TransformErr)) Xform.SetRotation(FQuat(Rot));
			}
			if (Params->HasField(TEXT("scale")))
			{
				FVector S = Xform.GetScale3D();
				if (UEMCP::ParseVector3(Params, TEXT("scale"), S, TransformErr)) Xform.SetScale3D(S);
			}
			Actor->SetActorTransform(Xform);

			BuildSuccessResponse(OutResponse, ActorToJsonObject(Actor));
		}

		void HandleGetActorProperties(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_actor_properties requires params.name"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("name"), Name))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			AActor* Actor = ResolveActorByName(Name, OutResponse);
			if (!Actor) return;
			BuildSuccessResponse(OutResponse, ActorToJsonObject(Actor));
		}

		void HandleSetActorProperty(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("set_actor_property requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name, PropertyName;
			if (!Params->TryGetStringField(TEXT("name"), Name))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'name' parameter"), TEXT("MISSING_PARAMS"));
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
			AActor* Actor = ResolveActorByName(Name, OutResponse);
			if (!Actor) return;

			// Lookup priority: actor → root component → named subobject components.
			// Properties like Mobility / RelativeLocation live on USceneComponent
			// (root component), not on AActor itself. set_component_property is the
			// explicit-subobject path when the caller already knows which component
			// to write; this fallback covers callers writing canonical actor-level
			// properties without needing to know whether the property lives on the
			// actor proper or on its root component.
			UObject* Target = nullptr;
			FString TargetLabel;
			if (Actor->GetClass()->FindPropertyByName(*PropertyName))
			{
				Target = Actor;
				TargetLabel = TEXT("actor");
			}
			if (!Target)
			{
				if (USceneComponent* Root = Actor->GetRootComponent())
				{
					if (Root->GetClass()->FindPropertyByName(*PropertyName))
					{
						Target = Root;
						TargetLabel = TEXT("root_component");
					}
				}
			}
			if (!Target)
			{
				TArray<UActorComponent*> Components;
				Actor->GetComponents(Components);
				for (UActorComponent* C : Components)
				{
					if (!C || C == Actor->GetRootComponent()) continue;
					if (C->GetClass()->FindPropertyByName(*PropertyName))
					{
						Target = C;
						TargetLabel = FString::Printf(TEXT("component:%s"), *C->GetName());
						break;
					}
				}
			}
			if (!Target)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Property not found: %s (checked actor, root component, and all named components)"), *PropertyName),
					TEXT("PROPERTY_NOT_FOUND"));
				return;
			}

			TSharedPtr<FJsonValue> Value = Params->Values.FindRef(TEXT("property_value"));
			FString ErrorMessage;
			if (!SetActorPropertyValue(Target, PropertyName, Value, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, TEXT("PROPERTY_SET_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("actor"), Name);
			Result->SetStringField(TEXT("property"), PropertyName);
			Result->SetStringField(TEXT("set_on"), TargetLabel);  // Transparency: where the write actually landed
			Result->SetBoolField(TEXT("success"), true);
			Result->SetObjectField(TEXT("actor_details"), ActorToJsonObject(Actor));
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleSpawnBlueprintActor(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("spawn_blueprint_actor requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString BlueprintName, ActorName;
			if (!Params->TryGetStringField(TEXT("blueprint_name"), BlueprintName) || BlueprintName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'blueprint_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("actor_name"), ActorName))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'actor_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			// D109: project-layout-aware resolution — accepts both bare names
			// (legacy /Game/Blueprints/<Name> back-compat + AssetRegistry fallback)
			// and fully-qualified /Game/... paths. Ambiguity surfaces as a typed
			// BLUEPRINT_AMBIGUOUS error with all candidate paths listed.
			FString AssetPath, ResolveError, ResolveErrorCode;
			if (!ResolveBlueprintAssetPath(BlueprintName, AssetPath, ResolveError, ResolveErrorCode))
			{
				BuildErrorResponse(OutResponse, ResolveError, ResolveErrorCode);
				return;
			}
			UBlueprint* Blueprint = LoadObject<UBlueprint>(nullptr, *AssetPath);
			if (!Blueprint || !Blueprint->GeneratedClass)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Failed to load Blueprint or generated class: %s"), *AssetPath),
					TEXT("BLUEPRINT_LOAD_FAILED"));
				return;
			}

			FVector Location(0.0f);
			FRotator Rotation(0.0f);
			FVector Scale(1.0f);
			FString TransformErr;
			if (Params->HasField(TEXT("location"))) UEMCP::ParseVector3(Params, TEXT("location"), Location, TransformErr);
			if (Params->HasField(TEXT("rotation"))) UEMCP::ParseRotator(Params, TEXT("rotation"), Rotation, TransformErr);
			if (Params->HasField(TEXT("scale")))    UEMCP::ParseVector3(Params, TEXT("scale"),    Scale,    TransformErr);

			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			FTransform SpawnXform;
			SpawnXform.SetLocation(Location);
			SpawnXform.SetRotation(FQuat(Rotation));
			SpawnXform.SetScale3D(Scale);

			FActorSpawnParameters SpawnParams;
			SpawnParams.Name = *ActorName;
			AActor* NewActor = World->SpawnActor<AActor>(Blueprint->GeneratedClass, SpawnXform, SpawnParams);
			if (!NewActor)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to spawn blueprint actor"), TEXT("SPAWN_FAILED"));
				return;
			}
			// D131 NEW-9b: outliner display label (see HandleSpawnActor for rationale).
			if (!ActorName.IsEmpty())
			{
				NewActor->SetActorLabel(*ActorName);
			}
			BuildSuccessResponse(OutResponse, ActorToJsonObject(NewActor));
		}

		void HandleFocusViewport(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("focus_viewport requires target or location"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString TargetName;
			const bool bHasTarget = Params->TryGetStringField(TEXT("target"), TargetName);

			FVector Location(0.0f);
			FString TransformErr;
			const bool bHasLocation = Params->HasField(TEXT("location"))
				&& UEMCP::ParseVector3(Params, TEXT("location"), Location, TransformErr);

			if (!bHasTarget && !bHasLocation)
			{
				BuildErrorResponse(OutResponse,
					TEXT("Either 'target' or 'location' must be provided"),
					TEXT("MISSING_PARAMS"));
				return;
			}

			double Distance = 1000.0;
			if (Params->HasField(TEXT("distance")))
			{
				Distance = Params->GetNumberField(TEXT("distance"));
			}

			FRotator Orientation(0.0f);
			const bool bHasOrientation = Params->HasField(TEXT("orientation"))
				&& UEMCP::ParseRotator(Params, TEXT("orientation"), Orientation, TransformErr);

			if (!GEditor || !GEditor->GetActiveViewport() || !GEditor->GetActiveViewport()->GetClient())
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get active viewport"), TEXT("NO_VIEWPORT"));
				return;
			}
			FLevelEditorViewportClient* Vpc =
				static_cast<FLevelEditorViewportClient*>(GEditor->GetActiveViewport()->GetClient());

			FVector FocusPos = Location;
			if (bHasTarget)
			{
				AActor* Actor = ResolveActorByName(TargetName, OutResponse);
				if (!Actor) return;
				FocusPos = Actor->GetActorLocation();
			}

			Vpc->SetViewLocation(FocusPos - FVector(Distance, 0.0, 0.0));
			if (bHasOrientation)
			{
				Vpc->SetViewRotation(Orientation);
			}
			Vpc->Invalidate();

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("success"), true);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleTakeScreenshot(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("take_screenshot requires params.filepath"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString FilePath;
			if (!Params->TryGetStringField(TEXT("filepath"), FilePath))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'filepath' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!FilePath.EndsWith(TEXT(".png")))
			{
				FilePath += TEXT(".png");
			}

			if (!GEditor || !GEditor->GetActiveViewport())
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get active viewport"), TEXT("NO_VIEWPORT"));
				return;
			}
			FViewport* Viewport = GEditor->GetActiveViewport();

			TArray<FColor> Bitmap;
			const FIntPoint Size = Viewport->GetSizeXY();
			const FIntRect Rect(0, 0, Size.X, Size.Y);
			if (!Viewport->ReadPixels(Bitmap, FReadSurfaceDataFlags(), Rect))
			{
				BuildErrorResponse(OutResponse, TEXT("Viewport ReadPixels failed"), TEXT("READ_PIXELS_FAILED"));
				return;
			}

			// CompressImageArray is deprecated since 5.0 (becomes hard error in 5.7
			// per Project B materialization). The replacement signature uses FImageView
			// which infers BGRA8/sRGB from FColor*. TArray64<uint8> is canonical for
			// CompressImage's output — it converts implicitly to TArrayView<const uint8>
			// which FFileHelper::SaveArrayToFile accepts.
			TArray64<uint8> CompressedPng;
			FImageView View(Bitmap.GetData(), Size.X, Size.Y);
			FImageUtils::CompressImage(CompressedPng, TEXT("png"), View, 0);
			if (CompressedPng.Num() == 0)
			{
				BuildErrorResponse(OutResponse, TEXT("PNG compression produced empty buffer"), TEXT("PNG_COMPRESS_FAILED"));
				return;
			}

			// Relative paths must be resolved under ProjectDir or FFileHelper writes
			// them relative to the editor's working directory (typically
			// Engine/Binaries/Win64), surfacing as a "silent file-write" from the
			// caller's POV. Returning the resolved absolute path tells the caller
			// where the file actually landed.
			if (FPaths::IsRelative(FilePath))
			{
				FilePath = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir(), FilePath);
			}
			if (!FFileHelper::SaveArrayToFile(CompressedPng, *FilePath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Failed to write PNG to '%s'"), *FilePath),
					TEXT("FILE_WRITE_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("filepath"), FilePath);  // Resolved absolute path
			Result->SetNumberField(TEXT("byte_length"), CompressedPng.Num());
			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterActorHandlers(FMCPCommandRegistry& Registry)
	{
		// Wire-type strings match the conformance oracle (TCP:55557) so migrated
		// callers see only port + envelope changes — no rename churn.
		Registry.Register(TEXT("get_actors_in_level"),  &HandleGetActorsInLevel);
		Registry.Register(TEXT("find_actors_by_name"),  &HandleFindActorsByName);
		Registry.Register(TEXT("spawn_actor"),          &HandleSpawnActor);
		Registry.Register(TEXT("delete_actor"),         &HandleDeleteActor);
		Registry.Register(TEXT("set_actor_transform"),  &HandleSetActorTransform);
		Registry.Register(TEXT("get_actor_properties"), &HandleGetActorProperties);
		Registry.Register(TEXT("set_actor_property"),   &HandleSetActorProperty);
		Registry.Register(TEXT("spawn_blueprint_actor"),&HandleSpawnBlueprintActor);
		Registry.Register(TEXT("focus_viewport"),       &HandleFocusViewport);
		Registry.Register(TEXT("take_screenshot"),      &HandleTakeScreenshot);
	}
}
