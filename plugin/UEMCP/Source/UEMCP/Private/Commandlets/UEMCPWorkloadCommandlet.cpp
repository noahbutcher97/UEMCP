// Copyright Noah Butcher. All Rights Reserved.
#include "UEMCPWorkloadCommandlet.h"
#include "HandlerCommon.h"
#include "EvaluationFileHash.h"
#include "HAL/PlatformFileManager.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "PhysicsEngine/PhysicsConstraintTemplate.h"
#include "Physics/Experimental/PhysScene_Chaos.h"
#include "PreviewScene.h"
#include "Serialization/JsonSerializer.h"

UUEMCPWorkloadCommandlet::UUEMCPWorkloadCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UUEMCPWorkloadCommandlet::Main(const FString& Params)
{
	const auto Fail = [](const FString& Message) {
		UE_LOG(LogTemp, Error, TEXT("UEMCP_EVALUATION_ERROR %s"), *Message);
		return 1;
	};
	FString File, Text, Kind, Handler;
	if (!FParse::Value(*Params, TEXT("WorkloadInput="), File) ||
		IFileManager::Get().FileSize(*File) > 65536 || !FFileHelper::LoadFileToString(Text, *File))
		return Fail(TEXT("Missing or oversized workload request"));
	TSharedPtr<FJsonObject> Request;
	const TSharedPtr<FJsonObject>* Inputs = nullptr;
	int32 Version = 0;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Request) || !Request ||
		!Request->TryGetStringField(TEXT("kind"), Kind) || !Request->TryGetStringField(TEXT("handler"), Handler) ||
		!Request->TryGetNumberField(TEXT("version"), Version) || !Request->TryGetObjectField(TEXT("inputs"), Inputs) ||
		!Handler.StartsWith(TEXT("/Script/")) || !Inputs || !Inputs->IsValid())
		return Fail(TEXT("Invalid native workload descriptor"));
	UClass* Class = UEMCP::ResolveClass(Handler, UUEMCPNativeWorkload::StaticClass());
	if (!Class || !Class->HasAnyClassFlags(CLASS_Native) || Class->HasAnyClassFlags(CLASS_Abstract) || Class->GetPathName() != Handler)
		return Fail(TEXT("Installed native workload handler unavailable. Build the project and enable its module."));
	const auto* Workload = Class->GetDefaultObject<UUEMCPNativeWorkload>();
	if (Workload->WorkloadKind() != Kind || Workload->WorkloadVersion() != Version)
		return Fail(TEXT("Installed native workload kind/version differs from the registration. Rebuild or pin the matching version."));
	// Pin the same saved bytes measured by the server for the full native invocation.
	const TArray<TSharedPtr<FJsonValue>>* Sources = nullptr;
	if (!Request->TryGetArrayField(TEXT("sources"), Sources) || Sources->Num() > 64)
		return Fail(TEXT("Invalid workload package source list"));
	TArray<TUniquePtr<IFileHandle>> Leases;
	for (const auto& Source : *Sources)
	{
		const TSharedPtr<FJsonObject>* Object = nullptr;
		FString Package, Ext, Digest;
		if (!Source || !Source->TryGetObject(Object) || !Object || !Object->IsValid() ||
			!(*Object)->TryGetStringField(TEXT("package"), Package) || !(*Object)->TryGetStringField(TEXT("extension"), Ext) ||
			!(*Object)->TryGetStringField(TEXT("digest"), Digest) || Digest.Len() != 64 ||
			!Package.StartsWith(TEXT("/Game/")) || !FPackageName::IsValidLongPackageName(Package) ||
			(Ext != TEXT(".uasset") && Ext != TEXT(".umap")))
			return Fail(TEXT("Invalid workload package identity"));
		const FString Path = FPackageName::LongPackageNameToFilename(Package, Ext);
		TUniquePtr<IFileHandle> Lease(FPlatformFileManager::Get().GetPlatformFile().OpenRead(*Path, false));
		if (!Lease || HashEvaluationFile(*Lease) != Digest) return Fail(TEXT("Missing, changed or locked workload package"));
		Leases.Add(MoveTemp(Lease));
	}
	auto Output = MakeShared<FJsonObject>();
	FString Error;
	if (!Workload->Evaluate(**Inputs, *Output, Error)) return Fail(Error);
	auto Reply = MakeShared<FJsonObject>();
	Reply->SetStringField(TEXT("kind"), Kind);
	Reply->SetNumberField(TEXT("version"), Version);
	Reply->SetStringField(TEXT("handler"), Handler);
	Reply->SetStringField(TEXT("engine_build"), FEngineVersion::Current().ToString());
	Reply->SetObjectField(TEXT("result"), Output);
	FString Encoded;
	auto Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Encoded);
	FJsonSerializer::Serialize(Reply, Writer);
	UE_LOG(LogTemp, Display, TEXT("UEMCP_EVALUATION_RESULT %s"), *Encoded);
	return 0;
}

bool UUEMCPJointResponse::Evaluate(const FJsonObject& Inputs, FJsonObject& Output, FString& Error) const
{
	FString Package, JointName;
	int32 Steps = 0;
	if (!Inputs.TryGetStringField(TEXT("asset"), Package) || !Package.StartsWith(TEXT("/Game/")) ||
		!FPackageName::IsValidLongPackageName(Package) || !Inputs.TryGetStringField(TEXT("joint"), JointName) ||
		JointName.IsEmpty() || JointName.Len() > 256 || !Inputs.TryGetNumberField(TEXT("steps"), Steps) || Steps < 1 || Steps > 3600)
	{
		Error = TEXT("Expected a saved PhysicsAsset, joint name and 1–3600 physics steps");
		return false;
	}
	const FString ObjPath = Package + TEXT(".") + FPackageName::GetLongPackageAssetName(Package);
	auto* Asset = LoadObject<UPhysicsAsset>(nullptr, *ObjPath);
	if (!Asset || !Asset->GetPathName().Equals(ObjPath, ESearchCase::CaseSensitive) || !Asset->GetPreviewMesh())
	{
		Error = TEXT("Expected the exact saved PhysicsAsset with a preview skeletal mesh");
		return false;
	}
	const FName Joint(*JointName);
	FPreviewScene Scene(FPreviewScene::ConstructionValues().SetCreateDefaultLighting(false).SetCreatePhysicsScene(true).ShouldSimulatePhysics(true).SetTransactional(false));
	auto* Component = NewObject<USkeletalMeshComponent>(GetTransientPackage());
	Component->SetSkeletalMesh(Asset->GetPreviewMesh());
	Component->SetPhysicsAsset(Asset, true);
	Component->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
	Component->SetEnableGravity(false);
	Scene.AddComponent(Component, FTransform::Identity);
	Component->SetAllBodiesSimulatePhysics(false);
	FConstraintInstance* Constraint = Component->FindConstraintInstance(Joint);
	if (!Constraint || !Constraint->IsValidConstraintInstance())
	{
		Error = TEXT("Joint has no live constraint in this PhysicsAsset");
		return false;
	}
	for (const UPhysicsConstraintTemplate* Other : Asset->ConstraintSetup)
	{
		if (Other && Other->DefaultInstance.JointName != Joint)
			if (auto* Instance = Component->FindConstraintInstance(Other->DefaultInstance.JointName)) Instance->TermConstraint();
	}
	auto* Body = Component->GetBodyInstance(Constraint->ConstraintBone1);
	if (!Body) { Error = TEXT("Joint has no child body"); return false; }
	Body->SetInstanceSimulatePhysics(true);
	Body->SetEnableGravity(false);
	if (!Body->IsInstanceSimulatingPhysics()) { Error = TEXT("Child body could not enter simulation"); return false; }
	const FVector Axis = (Constraint->GetRefFrame(EConstraintFrame::Frame1) * Body->GetUnrealWorldTransform()).GetUnitAxis(EAxis::X);
	auto* Physics = Scene.GetWorld()->GetPhysicsScene();
	if (!Physics) { Error = TEXT("Physics scene unavailable"); return false; }
	constexpr float Dt = 1.f / 120.f;
	const FVector Gravity = FVector::ZeroVector;
	const double Initial = FMath::RadiansToDegrees(Constraint->GetCurrentTwist());
	double Peak = FMath::Abs(Initial);
	for (int32 Step = 0; Step < Steps; ++Step)
	{
		Body->SetAngularVelocityInRadians(Axis * 2.f, false);
		Physics->SetUpForFrame(&Gravity, Dt, 0.f, Dt, Dt, 1, false);
		Physics->StartFrame();
		Physics->WaitPhysScenes();
		Physics->EndFrame();
		Peak = FMath::Max(Peak, static_cast<double>(FMath::Abs(FMath::RadiansToDegrees(Constraint->GetCurrentTwist()))));
	}
	Output.SetStringField(TEXT("asset"), Package);
	Output.SetStringField(TEXT("joint"), JointName);
	Output.SetStringField(TEXT("units"), TEXT("degrees"));
	Output.SetStringField(TEXT("mode"), TEXT("fixed_step_chaos_scene"));
	Output.SetNumberField(TEXT("steps"), Steps);
	Output.SetNumberField(TEXT("step_seconds"), Dt);
	Output.SetNumberField(TEXT("initial_degrees"), Initial);
	Output.SetNumberField(TEXT("peak_degrees"), Peak);
	Output.SetNumberField(TEXT("final_degrees"), FMath::RadiansToDegrees(Constraint->GetCurrentTwist()));
	return true;
}
