#include "OwnedPIEFixtureCommandlet.h"
#if WITH_EDITOR
#include "GameFramework/MovementComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Level.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "CoreGlobals.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "ScopedSuspendRerunConstructionScripts.h"
#include "Runtime/Launch/Resources/Version.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UnrealType.h"

namespace UEMCPFixture::OwnedPIEAuthoring
{
	// Independently authored specification, mirrored by committed owned-pie/oracle.json.
	// Never derive the oracle from the package being checked.
	static const TCHAR* MapPackage = TEXT("/Game/OwnedPIE/Lifecycle");
	static const TCHAR* ActorName = TEXT("OwnedLifecycleActor");
	static const TCHAR* MissingName = TEXT("DefinitelyAbsentOwnedProbe");
	static const TCHAR* ActorClass = TEXT("/Script/Engine.StaticMeshActor");
	static const FVector Location(120, -240, 360);
	static const FRotator Rotation(0, 0, 0);
	static const FVector Scale(1, 2, 1);
	static constexpr int32 PriorityWitness = 173;

	static FString Absolute(FString Path)
	{
		Path = FPaths::ConvertRelativePathToFull(Path);
		FPaths::NormalizeFilename(Path);
		FPaths::CollapseRelativeDirectories(Path);
		return Path;
	}


	// Optional task-owned execution evidence gate; it never grants process authority.
	static bool ObserveExecutionBeforeWork(const FString& Params, const FString& Root, const FString& Mode)
	{
		FString Nonce;
		if (!FParse::Value(*Params, TEXT("OwnedProcessNonce="), Nonce)) return true;
		if (Nonce.Len() != 64) return false;
		for (const TCHAR Character : Nonce) if (!((Character >= '0' && Character <= '9') || (Character >= 'a' && Character <= 'f'))) return false;
		const FString Directory = Absolute(Root / TEXT("Saved/OwnedPIEProcessGates"));
		if (!IFileManager::Get().DirectoryExists(*Directory)) return false;
		const FString Ready = Directory / (Nonce + TEXT("-") + Mode + TEXT(".ready"));
		const FString Release = Directory / (Nonce + TEXT("-") + Mode + TEXT(".release"));
		if (IFileManager::Get().FileExists(*Ready) || IFileManager::Get().DirectoryExists(*Ready) ||
			IFileManager::Get().FileExists(*Release) || IFileManager::Get().DirectoryExists(*Release)) return false;
		const uint32 Pid = FPlatformProcess::GetCurrentProcessId();
		const FString Message = FString::Printf(TEXT("{\"schemaVersion\":1,\"nonce\":\"%s\",\"pid\":%u,\"mode\":\"%s\"}"), *Nonce, Pid, *Mode);
		const double Deadline = FPlatformTime::Seconds() + 20.0;
		if (!FFileHelper::SaveStringToFile(Message, *Ready, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM, &IFileManager::Get(), FILEWRITE_NoReplaceExisting)) return false;
		while (!IsEngineExitRequested() && FPlatformTime::Seconds() < Deadline)
		{
			if (IFileManager::Get().FileExists(*Release))
			{
				FString Acknowledgement;
				const bool Valid = IFileManager::Get().FileSize(*Release) <= 1024 && FFileHelper::LoadFileToString(Acknowledgement, *Release) && Acknowledgement == Message;
                return Valid && !IsEngineExitRequested() && FPlatformTime::Seconds() < Deadline;
			}
			FPlatformProcess::Sleep(0.05f);
		}
		return false;
	}


	static bool MaterializeOwnedLoadedTransform(UWorld* World)
	{
		if (!World || !World->PersistentLevel || World->IsInitialized() || World->Scene || World->GetPhysicsScene()) return false;
		AStaticMeshActor* Found = nullptr;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (Actor && Actor->GetName() == ActorName)
			{
				if (Found || Actor->GetClass() != AStaticMeshActor::StaticClass()) return false;
				Found = Cast<AStaticMeshActor>(Actor);
			}
		}
		if (!Found) return false;
		UStaticMeshComponent* Mesh = Found->GetStaticMeshComponent();
		ULevel* const Level = World->PersistentLevel;
        const auto ActorsBefore = Level->Actors;
		const auto BoundAndSerializedValuesMatch = [&]()
		{
			return IsValid(World) && IsValid(Found) && IsValid(Mesh) && Found->GetOuter() == Level && Found->GetName() == ActorName && Found->GetClass() == AStaticMeshActor::StaticClass() && Found->GetWorld() == World &&
				Mesh && Mesh == Found->GetRootComponent() && Mesh == Found->GetStaticMeshComponent() && Mesh->GetOuter() == Found && Mesh->GetWorld() == World &&
				Mesh->GetClass() == UStaticMeshComponent::StaticClass() && !Mesh->IsRegistered() && !Mesh->GetAttachParent() && Mesh->GetAttachChildren().Num() == 0 &&
				!Mesh->GetRelativeLocation().ContainsNaN() && !Mesh->GetRelativeRotation().ContainsNaN() && !Mesh->GetRelativeScale3D().ContainsNaN() &&
				Mesh->GetRelativeLocation().Equals(Location, 0.0001) && Mesh->GetRelativeRotation().Equals(Rotation, 0.0001) && Mesh->GetRelativeScale3D().Equals(Scale, 0.0001);
		};
		UE_LOG(LogTemp, Display, TEXT("OwnedPIE loaded transform: cached=%s relative=%s rotation=%s scale=%s"),
			*Found->GetActorLocation().ToString(), Mesh ? *Mesh->GetRelativeLocation().ToString() : TEXT("missing"),
			Mesh ? *Mesh->GetRelativeRotation().ToString() : TEXT("missing"), Mesh ? *Mesh->GetRelativeScale3D().ToString() : TEXT("missing"));
		if (!BoundAndSerializedValuesMatch()) return false;
        const FVector SavedLocation = Mesh->GetRelativeLocation();
        const FRotator SavedRotation = Mesh->GetRelativeRotation();
        const FVector SavedScale = Mesh->GetRelativeScale3D();
		// Only derive this unattached, unregistered owned root's transient cache from
		// already-validated saved values. No property setters, registration, world
		// initialization or save. Transform callbacks are still possible.
		Mesh->UpdateComponentToWorld(EUpdateTransformFlags::SkipPhysicsUpdate);
		return IsValid(World) && IsValid(Level) && !World->IsInitialized() && !World->Scene && !World->GetPhysicsScene() &&
			World->PersistentLevel == Level && Level->Actors == ActorsBefore && BoundAndSerializedValuesMatch() &&
            Mesh->GetRelativeLocation() == SavedLocation && Mesh->GetRelativeRotation() == SavedRotation && Mesh->GetRelativeScale3D() == SavedScale;
	}

	static bool CheckWorld(UWorld* World)
	{
		const auto Fail = [](const TCHAR* Predicate)
		{
			UE_LOG(LogTemp, Error, TEXT("OwnedPIE invariant rejected: %s"), Predicate);
			return false;
		};
		if (!World) return Fail(TEXT("!World"));
		if (!World->PersistentLevel) return Fail(TEXT("!World->PersistentLevel"));
		if (World->GetPackage()->GetName() != MapPackage) return Fail(TEXT("World->GetPackage()->GetName() != MapPackage"));
		if (World->GetName() != TEXT("Lifecycle")) return Fail(TEXT("World->GetName() != TEXT(\"Lifecycle\")"));
		if (World->GetStreamingLevels().Num() != 0) return Fail(TEXT("World->GetStreamingLevels().Num() != 0"));
		if (World->HasBegunPlay()) return Fail(TEXT("World->HasBegunPlay()"));
		if (World->PersistentLevel->GetLevelScriptActor()) return Fail(TEXT("World->PersistentLevel->GetLevelScriptActor()"));
		if (World->PersistentLevel->GetLevelScriptBlueprint(true)) return Fail(TEXT("World->PersistentLevel->GetLevelScriptBlueprint(true)"));
		AStaticMeshActor* Found = nullptr;
		int32 MeshActorCount = 0;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (!Actor) continue;
			if (Actor->GetName() == MissingName) return Fail(TEXT("Actor->GetName() == MissingName"));
			const FString ClassPath = Actor->GetClass()->GetPathName();
			if (ClassPath != ActorClass && ClassPath != TEXT("/Script/Engine.WorldSettings") &&
				ClassPath != TEXT("/Script/Engine.Brush") && ClassPath != TEXT("/Script/Engine.DefaultPhysicsVolume"))
			{
				UE_LOG(LogTemp, Error, TEXT("OwnedPIE rejected actor: name=%s class=%s"), *Actor->GetName(), *ClassPath);
				return Fail(TEXT("ClassPath != ActorClass && ClassPath != TEXT(\"/Script/Engine.WorldSettings\") && ClassPath != TEXT(\"/Script/Engine.Brush\") && ClassPath != TEXT(\"/Script/Engine.DefaultPhysicsVolume\")"));
			}
			if (Actor->IsA<AStaticMeshActor>()) ++MeshActorCount;
			if (Actor->GetName() == ActorName)
			{
				if (Found) return Fail(TEXT("Found"));
				if (Actor->GetClass()->GetPathName() != ActorClass) return Fail(TEXT("Actor->GetClass()->GetPathName() != ActorClass"));
				Found = Cast<AStaticMeshActor>(Actor);
			}
		}
		if (!Found) return Fail(TEXT("!Found"));
		if (MeshActorCount != 1) return Fail(TEXT("MeshActorCount != 1"));
		if (!Found->GetActorLocation().Equals(Location, 0.0001)) return Fail(TEXT("!Found->GetActorLocation().Equals(Location, 0.0001)"));
		if (!Found->GetActorRotation().Equals(Rotation, 0.0001)) return Fail(TEXT("!Found->GetActorRotation().Equals(Rotation, 0.0001)"));
		if (!Found->GetActorScale3D().Equals(Scale, 0.0001)) return Fail(TEXT("!Found->GetActorScale3D().Equals(Scale, 0.0001)"));
		if (Found->InputPriority != PriorityWitness) return Fail(TEXT("Found->InputPriority != PriorityWitness"));
		if (Found->AutoReceiveInput != EAutoReceiveInput::Disabled || Found->InputComponent) return Fail(TEXT("Owned actor must have no automatic input or input component"));
		if (Found->PrimaryActorTick.bCanEverTick) return Fail(TEXT("Found->PrimaryActorTick.bCanEverTick"));
		if (Found->PrimaryActorTick.bStartWithTickEnabled) return Fail(TEXT("Found->PrimaryActorTick.bStartWithTickEnabled"));
		if (Found->IsActorTickEnabled()) return Fail(TEXT("Found->IsActorTickEnabled()"));
		if (Found->GetIsReplicated()) return Fail(TEXT("Found->GetIsReplicated()"));
		if (Found->IsReplicatingMovement()) return Fail(TEXT("Found->IsReplicatingMovement()"));
		if (Found->bStaticMeshReplicateMovement) return Fail(TEXT("Found->bStaticMeshReplicateMovement"));
		UStaticMeshComponent* Mesh = Found->GetStaticMeshComponent();
		if (!Mesh) return Fail(TEXT("!Mesh"));
		if (Mesh->GetStaticMesh() != nullptr) return Fail(TEXT("Mesh->GetStaticMesh() != nullptr"));
		if (Mesh->Mobility != EComponentMobility::Static) return Fail(TEXT("Mesh->Mobility != EComponentMobility::Static"));
		if (Mesh->BodyInstance.bSimulatePhysics) return Fail(TEXT("Mesh->BodyInstance.bSimulatePhysics"));
		if (Mesh->bUseDefaultCollision) return Fail(TEXT("Mesh->bUseDefaultCollision"));
		if (Mesh->IsSimulatingPhysics()) return Fail(TEXT("Mesh->IsSimulatingPhysics()"));
		if (Mesh->IsGravityEnabled()) return Fail(TEXT("Mesh->IsGravityEnabled()"));
		if (Mesh->GetCollisionEnabled() != ECollisionEnabled::NoCollision) return Fail(TEXT("Mesh->GetCollisionEnabled() != ECollisionEnabled::NoCollision"));
		for (UActorComponent* Component : Found->GetComponents())
		{
			if (Component)
			{
				if (Component->IsA<UMovementComponent>()) return Fail(TEXT("Component->IsA<UMovementComponent>()"));
				if (Component->PrimaryComponentTick.bCanEverTick) return Fail(TEXT("Component->PrimaryComponentTick.bCanEverTick"));
				if (Component->PrimaryComponentTick.bStartWithTickEnabled) return Fail(TEXT("Component->PrimaryComponentTick.bStartWithTickEnabled"));
				if (Component->IsComponentTickEnabled()) return Fail(TEXT("Component->IsComponentTickEnabled()"));
			}
		}
		return true;
	}
}
#endif

UOwnedPIEFixtureCommandlet::UOwnedPIEFixtureCommandlet()
{
	IsEditor = true;
	IsClient = false;
	IsServer = false;
	LogToConsole = true;
}

int32 UOwnedPIEFixtureCommandlet::Main(const FString& Params)
{
#if WITH_EDITOR && ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION == 6
	using namespace UEMCPFixture::OwnedPIEAuthoring;
	FString Mode, OwnedProject, Receipt;
	if (!FParse::Param(*Params, TEXT("AllowOwnedPIEFixture")) ||
		!FParse::Value(*Params, TEXT("Mode="), Mode) || (Mode != TEXT("author") && Mode != TEXT("verify")) ||
		!FParse::Value(*Params, TEXT("OwnedProject="), OwnedProject) || FPaths::IsRelative(OwnedProject) ||
		!FParse::Value(*Params, TEXT("Receipt="), Receipt) || FPaths::IsRelative(Receipt) || !FPaths::IsProjectFilePathSet()) return 2;
	OwnedProject = Absolute(OwnedProject);
	Receipt = Absolute(Receipt);
	const FString Root = Absolute(FPaths::ProjectDir());
	if (OwnedProject != Absolute(FPaths::GetProjectFilePath()) || FPaths::GetCleanFilename(OwnedProject) != TEXT("UEMCPFixture.uproject") ||
		!IFileManager::Get().FileExists(*OwnedProject)) return 3;
	FString Authority;
	if (!FFileHelper::LoadFileToString(Authority, *(Root / TEXT(".uemcp-owned-pie-fixture"))) ||
		Authority.TrimStartAndEnd() != TEXT("UEMCP owned disposable PIE fixture v1")) return 4;
	// Fixed bounded receipt directory; caller chooses only a fresh JSON leaf.
	// Coordinator must establish a physical, reparse-free disposable root first.
	const FString ReceiptDirectory = Absolute(Root / TEXT("Saved/OwnedPIEReceipts"));
	if (FPaths::GetPath(Receipt) != ReceiptDirectory || FPaths::GetExtension(Receipt) != TEXT("json") ||
		IFileManager::Get().FileExists(*Receipt) || IFileManager::Get().DirectoryExists(*Receipt)) return 5;
	const FString Filename = Absolute(FPackageName::LongPackageNameToFilename(MapPackage, FPackageName::GetMapPackageExtension()));
	if (Filename != Absolute(Root / TEXT("Content/OwnedPIE/Lifecycle.umap")) || FindPackage(nullptr, MapPackage)) return 6;
	if (!ObserveExecutionBeforeWork(Params, Root, Mode)) return 16;
	UWorld* World = nullptr;
	ULevel* RegisteredOwnedLevel = nullptr;
	// Only this commandlet-created or exact owned-package-loaded world is released.
	// Do not enumerate, replace, or tear down the editor's unrelated initial world.
	ON_SCOPE_EXIT
	{
		if (RegisteredOwnedLevel && IsValid(RegisteredOwnedLevel))
		{
			// Registration was confined to this commandlet-owned level.
			RegisteredOwnedLevel->ClearLevelComponents();
		}
		if (World)
		{
			if (World->IsInitialized()) World->DestroyWorld(false);
			if (World->IsRooted()) World->RemoveFromRoot();
			World->ClearFlags(RF_Standalone);
		}
	};
	if (Mode == TEXT("author"))
	{
		// Refuse existing map/assets and auxiliary output; never replace or delete them.
		for (const TCHAR* Extension : { TEXT("umap"), TEXT("uasset"), TEXT("uexp"), TEXT("ubulk") })
		{
			const FString Existing = FPaths::ChangeExtension(Filename, Extension);
			if (IFileManager::Get().FileExists(*Existing) || IFileManager::Get().DirectoryExists(*Existing)) return 7;
		}
		UPackage* Package = CreatePackage(MapPackage);
		const UWorld::InitializationValues Values = UWorld::InitializationValues().InitializeScenes(false)
			.AllowAudioPlayback(false).CreatePhysicsScene(false).ShouldSimulatePhysics(false).CreateNavigation(false).CreateAISystem(false).CreateFXSystem(false);
		World = UWorld::CreateWorld(EWorldType::Editor, false, TEXT("Lifecycle"), Package, true, ERHIFeatureLevel::Num, &Values, true);
		if (!World) return 8;
		// Author a serialization-only world; initialization delegates can spawn helper actors.
		if (World->IsInitialized() || World->Scene || World->GetPhysicsScene()) return 8;
		World->SetFlags(RF_Public | RF_Standalone);
		FActorSpawnParameters Spawn;
		Spawn.Name = ActorName;
		Spawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ReturnNull;
		Spawn.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(Location, Rotation, Spawn);
		if (!Actor) return 9;
		Actor->SetActorScale3D(Scale);
		FProperty* PriorityProperty = AActor::StaticClass()->FindPropertyByName(TEXT("InputPriority"));
		const AStaticMeshActor* Defaults = GetDefault<AStaticMeshActor>();
		if (!CastField<FIntProperty>(PriorityProperty) || PriorityProperty->GetOwner<UClass>() != AActor::StaticClass() ||
			!PriorityProperty->HasAnyPropertyFlags(CPF_Edit) || PriorityProperty->HasAnyPropertyFlags(CPF_DisableEditOnInstance | CPF_Transient | CPF_DuplicateTransient | CPF_NonPIEDuplicateTransient) ||
			Defaults->InputPriority != 0 || Defaults->CustomTimeDilation != 1.0f) return 21;
		Actor->InputPriority = PriorityWitness;
		Actor->PrimaryActorTick.bCanEverTick = false;
		Actor->PrimaryActorTick.bStartWithTickEnabled = false;
		Actor->PrimaryActorTick.SetTickFunctionEnable(false);
		Actor->SetReplicates(false);
		Actor->SetReplicateMovement(false);
		Actor->bStaticMeshReplicateMovement = false;
		UStaticMeshComponent* Mesh = Actor->GetStaticMeshComponent();
		Mesh->SetSimulatePhysics(false);
		Mesh->SetEnableGravity(false);
		Mesh->bUseDefaultCollision = false;
		Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Mesh->SetMobility(EComponentMobility::Static);
		for (UActorComponent* Component : Actor->GetComponents())
		{
			if (!Component) continue;
			Component->PrimaryComponentTick.bCanEverTick = false;
			Component->PrimaryComponentTick.bStartWithTickEnabled = false;
			Component->PrimaryComponentTick.SetTickFunctionEnable(false);
		}
		if (!CheckWorld(World)) return 10;
		ULevel* const OwnedLevel = World->PersistentLevel;
		const auto ActorsBeforeRegistration = OwnedLevel->Actors;
		const auto OwnedBindingsIntact = [&]()
		{
			return IsValid(World) && IsValid(OwnedLevel) && IsValid(Actor) && IsValid(Mesh) &&
				World->PersistentLevel == OwnedLevel && OwnedLevel->Actors == ActorsBeforeRegistration &&
				!World->IsInitialized() && !World->Scene && !World->GetPhysicsScene() &&
				Actor->GetOuter() == OwnedLevel && Actor->GetWorld() == World &&
				Actor->GetClass() == AStaticMeshActor::StaticClass() && Actor->GetName() == ActorName &&
				Mesh == Actor->GetRootComponent() && Mesh == Actor->GetStaticMeshComponent() &&
				Mesh->GetClass() == UStaticMeshComponent::StaticClass() && Mesh->GetOuter() == Actor && Mesh->GetWorld() == World;
		};
		// Register only this commandlet-owned level without construction.
		// The nondefault InputPriority witness must survive real reconstruction and saving.
		RegisteredOwnedLevel = OwnedLevel;
		OwnedLevel->UpdateLevelComponents(false);
		if (!OwnedBindingsIntact() || !OwnedLevel->bAreComponentsCurrentlyRegistered) return 18;
		if (!GIsEditor || !CheckWorld(World)) return 20;
		// Exercise the actual construction-reset predicate on this owned authoring actor.
		// InputPriority is editable instance data; CustomTimeDilation is not.
		Actor->CustomTimeDilation = 0.5f;
		if (FScopedSuspendRerunConstructionScripts::IsSuspended() || Actor->IsChildActor() || Actor->HasAnyFlags(RF_ClassDefaultObject | RF_BeginDestroyed | RF_FinishDestroyed)) return 20;
		Actor->RerunConstructionScripts();
		if (!OwnedBindingsIntact() || Actor->CustomTimeDilation != 1.0f || Actor->InputPriority != PriorityWitness || !CheckWorld(World)) return 20;
		UE_LOG(LogTemp, Display, TEXT("OwnedPIE construction reset control: dilation=1 InputPriority=173 preserved=true"));
		if (!CheckWorld(World)) return 10;
		UE_LOG(LogTemp, Display, TEXT("OwnedPIE before save: InputPriority=%d registered=%d"), Actor->InputPriority, OwnedLevel->bAreComponentsCurrentlyRegistered);
		if (!IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true) || IFileManager::Get().FileExists(*Filename)) return 11;
		FSavePackageArgs Save;
		Save.TopLevelFlags = RF_Public | RF_Standalone;
		Save.SaveFlags = SAVE_NoError;
		if (!UPackage::SavePackage(Package, World, *Filename, Save)) return 12;
		if (!OwnedBindingsIntact()) return 19;
		UE_LOG(LogTemp, Display, TEXT("OwnedPIE after save: InputPriority=%d"), Actor->InputPriority);
		if (!CheckWorld(World)) return 19;
	}
	else
	{
		// A separate process must load the existing saved map; never repair/save it.
		if (!IFileManager::Get().FileExists(*Filename)) return 13;
		UPackage* Package = LoadPackage(nullptr, *Filename, LOAD_None);
		World = Package ? UWorld::FindWorldInPackage(Package) : nullptr;
		if (!MaterializeOwnedLoadedTransform(World)) return 17;
		if (!CheckWorld(World)) return 14;
	}
	if (!IFileManager::Get().MakeDirectory(*ReceiptDirectory, true)) return 15;
	// Written only after all checks. Author success is NOT saved-reload or PIE proof.
	const FString Json = FString::Printf(TEXT("{\n  \"schemaVersion\": 1,\n  \"spec\": \"owned-pie-v2\",\n  \"mode\": \"%s\",\n  \"mapPath\": \"/Game/OwnedPIE/Lifecycle\",\n  \"actorName\": \"OwnedLifecycleActor\",\n  \"constantSpecMatched\": true,\n  \"savedReloadVerified\": %s,\n  \"nativePIEQualified\": false\n}\n"),
		*Mode, Mode == TEXT("verify") ? TEXT("true") : TEXT("false"));
	return FFileHelper::SaveStringToFile(Json, *Receipt, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM,
		&IFileManager::Get(), FILEWRITE_NoReplaceExisting) ? 0 : 16;
#else
	return 1;
#endif
}
