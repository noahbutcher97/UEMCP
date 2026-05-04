// Copyright Optimum Athena. All Rights Reserved.
#include "GeometryHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "TransformParser.h"

#include "Components/DynamicMeshComponent.h"
#include "DynamicMeshActor.h"
#include "Editor.h"
#include "Engine/World.h"
#include "GeometryScript/MeshBooleanFunctions.h"
#include "GeometryScript/MeshPrimitiveFunctions.h"
#include "GeometryScript/MeshUVFunctions.h"
#include "Interfaces/IPluginManager.h"
#include "UDynamicMesh.h"

namespace UEMCP
{
	namespace
	{
		// ── World resolution (mirrors ActorHandlers convention) ─────────────

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

		// ── Plugin-availability gate ───────────────────────────────────────
		//
		// Belt + suspenders: Build.cs already pulls in GeometryScripting modules,
		// so if the plugin is missing the editor wouldn't load UEMCP at all. But
		// if a target project has the plugin disabled at runtime (e.g. via project
		// settings) and the editor still loads, we want a typed error rather than
		// a confusing UClass-not-found at LoadObject time.
		bool IsGeometryScriptPluginEnabled(FString& OutMessage)
		{
			TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("GeometryScripting"));
			if (!Plugin.IsValid() || !Plugin->IsEnabled())
			{
				OutMessage = TEXT("GeometryScripting plugin is not enabled. Enable it in the target project's "
					"Edit → Plugins panel and restart the editor before retrying.");
				return false;
			}
			return true;
		}

		// Vec3 input parsing delegates to UEMCP::ParseVector3 (W-E adoption — see
		// TransformParser.h). Local helper removed.

		// ── Actor lookup (light wrapper — Geometry tools always work on
		//    ADynamicMeshActor, narrower than ActorHandlers' general lookup). ─

		ADynamicMeshActor* FindDynamicMeshActor(UWorld* World, const FString& Name)
		{
			if (!World) return nullptr;
			for (ULevel* Level : World->GetLevels())
			{
				if (!Level) continue;
				for (AActor* Actor : Level->Actors)
				{
					if (IsValid(Actor) && Actor->GetName() == Name)
					{
						return Cast<ADynamicMeshActor>(Actor);
					}
				}
			}
			return nullptr;
		}

		// ── shape parser ───────────────────────────────────────────────────

		enum class EPrimitiveShape
		{
			Box, Sphere, Cylinder, Cone, Unknown
		};

		EPrimitiveShape ParseShape(const FString& Raw)
		{
			const FString S = Raw.ToLower();
			if (S == TEXT("box"))      return EPrimitiveShape::Box;
			if (S == TEXT("sphere"))   return EPrimitiveShape::Sphere;
			if (S == TEXT("cylinder")) return EPrimitiveShape::Cylinder;
			if (S == TEXT("cone"))     return EPrimitiveShape::Cone;
			return EPrimitiveShape::Unknown;
		}

		// ── operation parser ───────────────────────────────────────────────

		bool ParseBooleanOp(const FString& Raw, EGeometryScriptBooleanOperation& Out)
		{
			const FString S = Raw.ToLower();
			if (S == TEXT("union"))                              { Out = EGeometryScriptBooleanOperation::Union;     return true; }
			if (S == TEXT("difference") || S == TEXT("subtract")){ Out = EGeometryScriptBooleanOperation::Subtract;  return true; }
			if (S == TEXT("intersection") || S == TEXT("intersect")) { Out = EGeometryScriptBooleanOperation::Intersection; return true; }
			return false;
		}

		// ═══════════════════════════════════════════════════════════════════
		// Handlers
		// ═══════════════════════════════════════════════════════════════════

		void HandleCreateProceduralMesh(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString PluginErr;
			if (!IsGeometryScriptPluginEnabled(PluginErr))
			{
				BuildErrorResponse(OutResponse, PluginErr, TEXT("GEOMETRY_SCRIPT_PLUGIN_DISABLED"));
				return;
			}
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_procedural_mesh requires params"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString ShapeStr;
			if (!Params->TryGetStringField(TEXT("shape"), ShapeStr) || ShapeStr.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'shape' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const EPrimitiveShape Shape = ParseShape(ShapeStr);
			if (Shape == EPrimitiveShape::Unknown)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown shape '%s' (expected: box, sphere, cylinder, cone)"), *ShapeStr),
					TEXT("BAD_SHAPE"));
				return;
			}

			FVector Location(0.0);
			if (Params->HasField(TEXT("location")))
			{
				FString TransformErr;
				UEMCP::ParseVector3(Params, TEXT("location"), Location, TransformErr);
			}

			double Size = 100.0;
			if (Params->HasField(TEXT("size")))
			{
				Size = Params->GetNumberField(TEXT("size"));
				if (Size <= 0.0)
				{
					BuildErrorResponse(OutResponse, TEXT("'size' must be > 0"), TEXT("BAD_SIZE"));
					return;
				}
			}

			FString ActorName;
			Params->TryGetStringField(TEXT("name"), ActorName);

			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			FActorSpawnParameters SpawnParams;
			if (!ActorName.IsEmpty())
			{
				SpawnParams.Name = *ActorName;
			}
			ADynamicMeshActor* MeshActor = World->SpawnActor<ADynamicMeshActor>(
				ADynamicMeshActor::StaticClass(), Location, FRotator::ZeroRotator, SpawnParams);
			if (!MeshActor)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to spawn ADynamicMeshActor"), TEXT("SPAWN_FAILED"));
				return;
			}
			// D131 NEW-9b: outliner display label (see ActorHandlers.cpp HandleSpawnActor).
			if (!ActorName.IsEmpty())
			{
				MeshActor->SetActorLabel(*ActorName);
			}

			UDynamicMeshComponent* MeshComp = MeshActor->GetDynamicMeshComponent();
			UDynamicMesh* TargetMesh = MeshComp ? MeshComp->GetDynamicMesh() : nullptr;
			if (!TargetMesh)
			{
				BuildErrorResponse(OutResponse, TEXT("DynamicMeshComponent has no UDynamicMesh"), TEXT("NO_MESH"));
				return;
			}
			TargetMesh->Reset();

			FGeometryScriptPrimitiveOptions Options;
			const FTransform LocalIdentity = FTransform::Identity;

			// Append the requested primitive. Library functions return the input mesh
			// for fluent-chain use; we ignore the return because we already hold it.
			switch (Shape)
			{
				case EPrimitiveShape::Box:
				{
					UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendBox(
						TargetMesh, Options, LocalIdentity,
						/*DimensionX=*/Size, /*DimensionY=*/Size, /*DimensionZ=*/Size,
						/*StepsX=*/0, /*StepsY=*/0, /*StepsZ=*/0,
						EGeometryScriptPrimitiveOriginMode::Center);
					break;
				}
				case EPrimitiveShape::Sphere:
				{
					UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendSphereLatLong(
						TargetMesh, Options, LocalIdentity,
						/*Radius=*/Size * 0.5,
						/*StepsPhi=*/16, /*StepsTheta=*/16,
						EGeometryScriptPrimitiveOriginMode::Center);
					break;
				}
				case EPrimitiveShape::Cylinder:
				{
					UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendCylinder(
						TargetMesh, Options, LocalIdentity,
						/*Radius=*/Size * 0.5, /*Height=*/Size,
						/*RadialSteps=*/16, /*HeightSteps=*/1, /*bCapped=*/true,
						EGeometryScriptPrimitiveOriginMode::Center);
					break;
				}
				case EPrimitiveShape::Cone:
				{
					UGeometryScriptLibrary_MeshPrimitiveFunctions::AppendCone(
						TargetMesh, Options, LocalIdentity,
						/*BaseRadius=*/Size * 0.5, /*TopRadius=*/0.0, /*Height=*/Size,
						/*RadialSteps=*/16, /*HeightSteps=*/1, /*bCapped=*/true,
						EGeometryScriptPrimitiveOriginMode::Center);
					break;
				}
				default:
					break;
			}

			if (MeshComp)
			{
				MeshComp->NotifyMeshUpdated();
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"),  MeshActor->GetName());
			Result->SetStringField(TEXT("class"), MeshActor->GetClass()->GetName());
			Result->SetStringField(TEXT("shape"), *ShapeStr.ToLower());
			Result->SetNumberField(TEXT("size"),  Size);
			TArray<TSharedPtr<FJsonValue>> Loc;
			Loc.Add(MakeShared<FJsonValueNumber>(Location.X));
			Loc.Add(MakeShared<FJsonValueNumber>(Location.Y));
			Loc.Add(MakeShared<FJsonValueNumber>(Location.Z));
			Result->SetArrayField(TEXT("location"), Loc);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleMeshBoolean(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString PluginErr;
			if (!IsGeometryScriptPluginEnabled(PluginErr))
			{
				BuildErrorResponse(OutResponse, PluginErr, TEXT("GEOMETRY_SCRIPT_PLUGIN_DISABLED"));
				return;
			}
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("mesh_boolean requires params"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString TargetName, ToolName, OpStr;
			if (!Params->TryGetStringField(TEXT("target"), TargetName) || TargetName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'target' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("tool"), ToolName) || ToolName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'tool' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("operation"), OpStr) || OpStr.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'operation' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			EGeometryScriptBooleanOperation Op;
			if (!ParseBooleanOp(OpStr, Op))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown operation '%s' (expected: union, difference, intersection)"), *OpStr),
					TEXT("BAD_OPERATION"));
				return;
			}

			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			ADynamicMeshActor* TargetActor = FindDynamicMeshActor(World, TargetName);
			if (!TargetActor)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("DynamicMeshActor not found: %s"), *TargetName),
					TEXT("TARGET_NOT_FOUND"));
				return;
			}
			ADynamicMeshActor* ToolActor = FindDynamicMeshActor(World, ToolName);
			if (!ToolActor)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("DynamicMeshActor not found: %s"), *ToolName),
					TEXT("TOOL_NOT_FOUND"));
				return;
			}

			UDynamicMesh* TargetMesh = TargetActor->GetDynamicMeshComponent()
				? TargetActor->GetDynamicMeshComponent()->GetDynamicMesh() : nullptr;
			UDynamicMesh* ToolMesh = ToolActor->GetDynamicMeshComponent()
				? ToolActor->GetDynamicMeshComponent()->GetDynamicMesh() : nullptr;
			if (!TargetMesh || !ToolMesh)
			{
				BuildErrorResponse(OutResponse, TEXT("Target or tool actor has no UDynamicMesh"), TEXT("NO_MESH"));
				return;
			}

			FGeometryScriptMeshBooleanOptions BoolOptions;
			// Debug param is UGeometryScriptDebug* (UObject pointer), defaults nullptr.
			// UEMCP doesn't surface debug output via wire protocol, so passing nullptr
			// keeps the call simple. If we ever need debug captures, instantiate via
			// NewObject<UGeometryScriptDebug>(GetTransientPackage()).
			UGeometryScriptLibrary_MeshBooleanFunctions::ApplyMeshBoolean(
				TargetMesh, TargetActor->GetActorTransform(),
				ToolMesh,   ToolActor->GetActorTransform(),
				Op, BoolOptions, /*Debug=*/nullptr);

			if (UDynamicMeshComponent* MeshComp = TargetActor->GetDynamicMeshComponent())
			{
				MeshComp->NotifyMeshUpdated();
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("target"),    TargetName);
			Result->SetStringField(TEXT("tool"),      ToolName);
			Result->SetStringField(TEXT("operation"), *OpStr.ToLower());
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleGenerateUVs(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString PluginErr;
			if (!IsGeometryScriptPluginEnabled(PluginErr))
			{
				BuildErrorResponse(OutResponse, PluginErr, TEXT("GEOMETRY_SCRIPT_PLUGIN_DISABLED"));
				return;
			}
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("generate_uvs requires params"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString TargetName;
			if (!Params->TryGetStringField(TEXT("target"), TargetName) || TargetName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'target' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			int32 UVChannel = 0;
			if (Params->HasField(TEXT("uv_channel")))
			{
				UVChannel = static_cast<int32>(Params->GetNumberField(TEXT("uv_channel")));
				if (UVChannel < 0 || UVChannel > 7)
				{
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("'uv_channel' must be in [0..7], got %d"), UVChannel),
						TEXT("BAD_UV_CHANNEL"));
					return;
				}
			}

			UWorld* World = GetEditorWorld();
			if (!World)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to get editor world"), TEXT("NO_WORLD"));
				return;
			}

			ADynamicMeshActor* TargetActor = FindDynamicMeshActor(World, TargetName);
			if (!TargetActor)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("DynamicMeshActor not found: %s"), *TargetName),
					TEXT("TARGET_NOT_FOUND"));
				return;
			}
			UDynamicMesh* TargetMesh = TargetActor->GetDynamicMeshComponent()
				? TargetActor->GetDynamicMeshComponent()->GetDynamicMesh() : nullptr;
			if (!TargetMesh)
			{
				BuildErrorResponse(OutResponse, TEXT("Target actor has no UDynamicMesh"), TEXT("NO_MESH"));
				return;
			}

			// Box projection — simplest auto-UV path that works without per-shape
			// tuning. Caller can override the projection box transform later via a
			// dedicated tool if more sophisticated unwrapping is needed.
			// Debug param is UGeometryScriptDebug* — see ApplyMeshBoolean note above.
			UGeometryScriptLibrary_MeshUVFunctions::SetMeshUVsFromBoxProjection(
				TargetMesh, UVChannel, FTransform::Identity,
				FGeometryScriptMeshSelection(),
				/*MinIslandTriCount=*/2, /*Debug=*/nullptr);

			if (UDynamicMeshComponent* MeshComp = TargetActor->GetDynamicMeshComponent())
			{
				MeshComp->NotifyMeshUpdated();
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("target"),     TargetName);
			Result->SetNumberField(TEXT("uv_channel"), UVChannel);
			Result->SetStringField(TEXT("method"),     TEXT("box_projection"));
			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterGeometryHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("create_procedural_mesh"), &HandleCreateProceduralMesh);
		Registry.Register(TEXT("mesh_boolean"),           &HandleMeshBoolean);
		Registry.Register(TEXT("generate_uvs"),           &HandleGenerateUVs);
	}
}
