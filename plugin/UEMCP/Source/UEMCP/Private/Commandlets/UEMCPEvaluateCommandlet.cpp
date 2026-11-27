// Copyright Noah Butcher. All Rights Reserved.
#include "UEMCPEvaluateCommandlet.h"
#include "EvaluationFileHash.h"

#include "Components/SceneComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/DataAsset.h"
#include "Engine/Level.h"
#include "Engine/World.h"
#include "GameFramework/PlayerStart.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/EngineVersion.h"
#include "Misc/PackageName.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UnrealType.h"
#include "Misc/ScopeExit.h"
THIRD_PARTY_INCLUDES_START
#define UI OPENSSL_UI_TYPE
#include <openssl/evp.h>
#undef UI
THIRD_PARTY_INCLUDES_END

FString HashEvaluationFile(IFileHandle& File)
{
	EVP_MD_CTX* Context = EVP_MD_CTX_new();
	if (!Context) return {};
	ON_SCOPE_EXIT { EVP_MD_CTX_free(Context); };
	if (EVP_DigestInit_ex(Context, EVP_sha256(), nullptr) != 1) return {};
	int64 Remaining = File.Size();
	if (Remaining <= 0) return {};
	TArray<uint8> Buffer;
	Buffer.SetNumUninitialized(65536);
	while (Remaining > 0)
	{
		const int32 Count = static_cast<int32>(FMath::Min<int64>(Remaining, Buffer.Num()));
		if (!File.Read(Buffer.GetData(), Count) || EVP_DigestUpdate(Context, Buffer.GetData(), Count) != 1) return {};
		Remaining -= Count;
	}
	uint8 Hash[EVP_MAX_MD_SIZE];
	unsigned int Size = 0;
	if (EVP_DigestFinal_ex(Context, Hash, &Size) != 1 || Size != 32) return {};
	return BytesToHex(Hash, Size).ToLower();
}

namespace
{
	UObject* LoadEvaluationAsset(const FString& Package, UClass* Type)
	{
		if (!Package.StartsWith(TEXT("/Game/")) || !FPackageName::IsValidLongPackageName(Package)) return nullptr;
		const FString Path = Package + TEXT(".") + FPackageName::GetLongPackageAssetName(Package);
		UObject* Object = StaticLoadObject(Type, nullptr, *Path, nullptr, LOAD_NoWarn);
		return Object && Object->GetPathName().Equals(Path, ESearchCase::CaseSensitive) ? Object : nullptr;
	}

	int32 EvaluationError(const TCHAR* Message)
	{
		UE_LOG(LogTemp, Error, TEXT("UEMCP_EVALUATION_ERROR %s"), Message);
		return 1;
	}
}

UUEMCPEvaluateCommandlet::UUEMCPEvaluateCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UUEMCPEvaluateCommandlet::Main(const FString& Params)
{
	FString ConfigPath, MapPath;
	int32 Seed = 0;
	if (!FParse::Value(*Params, TEXT("EvaluationConfig="), ConfigPath) ||
		!FParse::Value(*Params, TEXT("EvaluationMap="), MapPath) ||
		!FParse::Value(*Params, TEXT("EvaluationSeed="), Seed))
		return EvaluationError(TEXT("Supply a saved config, map and seed."));

	if (!ConfigPath.StartsWith(TEXT("/Game/")) || !MapPath.StartsWith(TEXT("/Game/")) ||
		!FPackageName::IsValidLongPackageName(ConfigPath) || !FPackageName::IsValidLongPackageName(MapPath))
		return EvaluationError(TEXT("Expected two saved project packages."));
	uint32 OwnerPid = 0;
	if (FParse::Value(*Params, TEXT("EvaluationOwner="), OwnerPid) && !FPlatformProcess::IsApplicationRunning(OwnerPid))
		return EvaluationError(TEXT("Evaluation owner exited during startup."));
	IPlatformFile& Files = FPlatformFileManager::Get().GetPlatformFile();
	const FString ConfigFile = FPackageName::LongPackageNameToFilename(ConfigPath, FPackageName::GetAssetPackageExtension());
	const FString MapFile = FPackageName::LongPackageNameToFilename(MapPath, FPackageName::GetMapPackageExtension());
	TUniquePtr<IFileHandle> ConfigLease(Files.OpenRead(*ConfigFile, false));
	TUniquePtr<IFileHandle> MapLease(Files.OpenRead(*MapFile, false));
	if (!ConfigLease || !MapLease) return EvaluationError(TEXT("Missing saved input or a conflicting package writer."));
	UDataAsset* Config = Cast<UDataAsset>(LoadEvaluationAsset(ConfigPath, UDataAsset::StaticClass()));
	if (!Config) return EvaluationError(TEXT("Config did not resolve to the requested DataAsset."));
	const FStructProperty* Settings = FindFProperty<FStructProperty>(Config->GetClass(), TEXT("Settings"));
	const FNumericProperty* Threshold = Settings ? FindFProperty<FNumericProperty>(Settings->Struct, TEXT("Threshold")) : nullptr;
	if (!Threshold || !Threshold->IsFloatingPoint() || Threshold->ArrayDim != 1 || Settings->ArrayDim != 1)
		return EvaluationError(TEXT("Expected a floating Settings.Threshold in metres."));
	const void* Address = Settings->ContainerPtrToValuePtr<void>(Config);
	const double Minimum = Threshold->GetFloatingPointPropertyValue(Threshold->ContainerPtrToValuePtr<void>(Address));
	if (!FMath::IsFinite(Minimum) || Minimum < 0) return EvaluationError(TEXT("Threshold must be finite and nonnegative."));

	UWorld* World = Cast<UWorld>(LoadEvaluationAsset(MapPath, UWorld::StaticClass()));
	if (!World || !World->PersistentLevel || World->GetWorldPartition() || World->PersistentLevel->IsUsingExternalActors() || World->GetStreamingLevels().Num())
		return EvaluationError(TEXT("Expected a saved, non-partitioned map with one persistent level."));
	TArray<APlayerStart*> Starts;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		APlayerStart* Start = Cast<APlayerStart>(Actor);
		if (!Start) continue;
		if (!Start->GetRootComponent() || Start->GetRootComponent()->GetAttachParent() || Start->GetRootComponent()->GetRelativeLocation().ContainsNaN())
			return EvaluationError(TEXT("Expected unattached player starts with finite saved positions."));
		Starts.Add(Start);
	}
	if (Starts.Num() < 2 || Starts.Num() > 256) return EvaluationError(TEXT("Map must contain between 2 and 256 player starts."));
	Starts.Sort([](const APlayerStart& A, const APlayerStart& B){ return A.GetName() < B.GetName(); });
	FRandomStream Random(Seed);
	for (int32 Index = Starts.Num() - 1; Index > 0; --Index) Starts.Swap(Index, Random.RandRange(0, Index));

	TArray<TSharedPtr<FJsonValue>> Rows;
	int32 Passed = 0;
	for (const APlayerStart* Start : Starts)
	{
		double Nearest = TNumericLimits<double>::Max();
		for (const APlayerStart* Other : Starts)
		{
			if (Start == Other) continue;
			const double Distance = FVector::Distance(Start->GetRootComponent()->GetRelativeLocation(), Other->GetRootComponent()->GetRelativeLocation()) / 100.0;
			if (!FMath::IsFinite(Distance)) return EvaluationError(TEXT("Distance exceeds the supported range."));
			Nearest = FMath::Min(Nearest, Distance);
		}
		if (!FMath::IsFinite(Nearest)) return EvaluationError(TEXT("Distance exceeds the supported range."));
		const bool bPass = Nearest >= Minimum;
		Passed += bPass ? 1 : 0;
		TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("player_start"), Start->GetName());
		Row->SetNumberField(TEXT("nearest_metres"), Nearest);
		Row->SetBoolField(TEXT("meets_minimum"), bPass);
		Rows.Add(MakeShared<FJsonValueObject>(Row));
	}
	TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
	const FString ConfigDigest = HashEvaluationFile(*ConfigLease);
	const FString MapDigest = HashEvaluationFile(*MapLease);
	if (ConfigDigest.IsEmpty() || MapDigest.IsEmpty()) return EvaluationError(TEXT("Could not hash the leased inputs."));
	Report->SetStringField(TEXT("config_sha256"), ConfigDigest);
	Report->SetStringField(TEXT("map_sha256"), MapDigest);
	Report->SetStringField(TEXT("evaluation"), TEXT("player_start_spacing"));
	Report->SetStringField(TEXT("engine_build"), FEngineVersion::Current().ToString());
	Report->SetStringField(TEXT("config"), Config->GetOutermost()->GetName());
	Report->SetStringField(TEXT("map"), World->GetOutermost()->GetName());
	Report->SetNumberField(TEXT("seed"), Seed);
	Report->SetNumberField(TEXT("threshold_metres"), Minimum);
	Report->SetNumberField(TEXT("passed"), Passed);
	Report->SetArrayField(TEXT("starts"), Rows);
	FString Json;
	const auto Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
	if (!FJsonSerializer::Serialize(Report, Writer)) return EvaluationError(TEXT("Result serialization failed."));
	UE_LOG(LogTemp, Display, TEXT("UEMCP_EVALUATION_RESULT %s"), *Json);
	return 0;
}
