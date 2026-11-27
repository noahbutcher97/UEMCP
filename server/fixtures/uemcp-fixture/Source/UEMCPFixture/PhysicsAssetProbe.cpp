#include "PhysicsAssetProbe.h"

#if WITH_EDITOR
#include "Components/SkeletalMeshComponent.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/World.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "PhysicsEngine/PhysicsConstraintTemplate.h"
#if __has_include("PhysicsEngine/SkeletalBodySetup.h")
#include "PhysicsEngine/SkeletalBodySetup.h"
#endif // UE 5.3 declares USkeletalBodySetup in PhysicsAsset.h.
#include "PreviewScene.h"
#include "Physics/Experimental/PhysScene_Chaos.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"

namespace PhysicsAssetProbe
{
	static FString Serialize(const TSharedRef<FJsonObject>& Obj)
	{
		FString Result;
		auto Writer = TJsonWriterFactory<>::Create(&Result);
		FJsonSerializer::Serialize(Obj, Writer);
		return Result;
	}

	static bool IsFixture(UPhysicsAsset* Asset)
	{
		return Asset && Asset->GetPathName() == TEXT("/Game/PhysicsQualification/PA_Joint.PA_Joint");
	}

	static USkeletalBodySetup* MakeBody(UPhysicsAsset* Asset, FName Name)
	{
		auto* Body = NewObject<USkeletalBodySetup>(Asset, NAME_None, RF_Transactional);
		Body->BoneName = Name;
		Body->CollisionTraceFlag = CTF_UseSimpleAsComplex;
		Body->AggGeom.SphereElems.AddDefaulted_GetRef().Radius = 3;
		Asset->SkeletalBodySetups.Add(Body);
		return Body;
	}
}
#endif

FString UPhysicsAssetProbe::Seed(UPhysicsAsset* Asset, USkeletalMesh* PreviewMesh)
{
#if WITH_EDITOR
	if (!PhysicsAssetProbe::IsFixture(Asset) || !PreviewMesh || PreviewMesh->GetPathName() != TEXT("/Game/PhysicsQualification/SK_Probe.SK_Probe")) return TEXT("unexpected fixture");
	const FReferenceSkeleton& Ref = PreviewMesh->GetRefSkeleton();
	int32 Child = INDEX_NONE, Parent = INDEX_NONE, Tip = INDEX_NONE;
	for (int32 Bone = 1; Bone < Ref.GetRawBoneNum(); ++Bone)
	{
		const int32 P = Ref.GetParentIndex(Bone);
		if (P <= 0 || Ref.GetParentIndex(P) == INDEX_NONE || Ref.GetRefBonePose()[Bone].GetTranslation().Size() < 1) continue;
		Child = P; Parent = Ref.GetParentIndex(P); Tip = Bone;
		break;
	}
	if (Tip == INDEX_NONE) return TEXT("three-bone chain missing");
	Asset->SetPreviewMesh(PreviewMesh);
	Asset->SkeletalBodySetups.Reset();
	Asset->ConstraintSetup.Reset();
	Asset->CollisionDisableTable.Reset();
	Asset->ConstraintProfiles.Reset();
	Asset->CurrentConstraintProfileName = NAME_None;
	PhysicsAssetProbe::MakeBody(Asset, Ref.GetBoneName(Parent));
	PhysicsAssetProbe::MakeBody(Asset, Ref.GetBoneName(Child));
	Asset->UpdateBodySetupIndexMap();
	Asset->UpdateBoundsBodiesArray();
	auto* Template = NewObject<UPhysicsConstraintTemplate>(Asset, NAME_None, RF_Transactional);
	FConstraintInstance& C = Template->DefaultInstance;
	C.JointName = TEXT("ExistingHinge");
	C.ConstraintBone1 = Ref.GetBoneName(Child);
	C.ConstraintBone2 = Ref.GetBoneName(Parent);
	C.SetRefFrame(EConstraintFrame::Frame1, FTransform::Identity);
	C.SetRefFrame(EConstraintFrame::Frame2, Ref.GetRefBonePose()[Child]);
	C.SetAngularSwing1Limit(ACM_Locked, 0);
	C.SetAngularSwing2Limit(ACM_Locked, 0);
	C.SetAngularTwistLimit(ACM_Limited, 55.0f);
	Template->SetDefaultProfile(C);
	Asset->ConstraintSetup.Add(Template);
	Asset->DisableCollision(0, 1);
	Asset->MarkPackageDirty();
	auto Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("parent"), Ref.GetBoneName(Parent).ToString());
	Result->SetStringField(TEXT("child"), Ref.GetBoneName(Child).ToString());
	Result->SetStringField(TEXT("tip"), Ref.GetBoneName(Tip).ToString());
	return PhysicsAssetProbe::Serialize(Result);
#else
	return TEXT("editor required");
#endif
}

bool UPhysicsAssetProbe::FlipInvalidTopology(UPhysicsAsset* Asset, bool bIntroduce)
{
#if WITH_EDITOR
	if (!PhysicsAssetProbe::IsFixture(Asset) || Asset->SkeletalBodySetups.IsEmpty()) return false;
	if (bIntroduce)
	{
		if (Asset->SkeletalBodySetups.Contains(nullptr)) return false;
		Asset->SkeletalBodySetups.Add(nullptr);
	}
	else
	{
		if (Asset->SkeletalBodySetups.Last()) return false;
		Asset->SkeletalBodySetups.Pop();
	}
	return true;
#else
	return false;
#endif
}

FString UPhysicsAssetProbe::Observe(UPhysicsAsset* Asset, FName SimulateJoint)
{
#if WITH_EDITOR
	if (!PhysicsAssetProbe::IsFixture(Asset) || !Asset->GetPreviewMesh()) return TEXT("unexpected fixture");
	auto Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
	TArray<TSharedPtr<FJsonValue>> Bodies, Joints;
	for (const USkeletalBodySetup* B : Asset->SkeletalBodySetups)
	{
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("bone"), B->BoneName.ToString());
		Row->SetNumberField(TEXT("shapes"), B->AggGeom.GetElementCount());
		Row->SetNumberField(TEXT("sphere_radius"), B->AggGeom.SphereElems.Num() ? B->AggGeom.SphereElems[0].Radius : 0);
		Bodies.Add(MakeShared<FJsonValueObject>(Row));
	}
	for (const UPhysicsConstraintTemplate* T : Asset->ConstraintSetup)
	{
		const FConstraintInstance& C = T->DefaultInstance;
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("joint"), C.JointName.ToString());
		Row->SetStringField(TEXT("child"), C.ConstraintBone1.ToString());
		Row->SetStringField(TEXT("parent"), C.ConstraintBone2.ToString());
		Row->SetNumberField(TEXT("limit"), C.GetAngularTwistLimit());
		Row->SetStringField(TEXT("frame1"), C.GetRefFrame(EConstraintFrame::Frame1).ToHumanReadableString());
		Row->SetStringField(TEXT("frame2"), C.GetRefFrame(EConstraintFrame::Frame2).ToHumanReadableString());
		Joints.Add(MakeShared<FJsonValueObject>(Row));
	}
	Result->SetArrayField(TEXT("bodies"), Bodies);
	Result->SetArrayField(TEXT("joints"), Joints);
	if (!SimulateJoint.IsNone())
	{
		FPreviewScene Scene(FPreviewScene::ConstructionValues().SetCreateDefaultLighting(false).SetCreatePhysicsScene(true).ShouldSimulatePhysics(true).SetTransactional(false));
		auto* Component = NewObject<USkeletalMeshComponent>(GetTransientPackage());
		Component->SetSkeletalMesh(Asset->GetPreviewMesh());
		Component->SetPhysicsAsset(Asset, true);
		Component->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
		Component->SetEnableGravity(false);
		Scene.AddComponent(Component, FTransform::Identity);
		Component->SetAllBodiesSimulatePhysics(false);
		FConstraintInstance* J = Component->FindConstraintInstance(SimulateJoint);
		if (!J || !J->IsValidConstraintInstance()) return TEXT("missing simulation joint");
		// Pin the parent and isolate the measured joint. An unrelated kinematic child would
		// otherwise anchor its dynamic parent through a second constraint.
		for (const UPhysicsConstraintTemplate* Other : Asset->ConstraintSetup)
		{
			if (Other->DefaultInstance.JointName == SimulateJoint) continue;
			if (FConstraintInstance* Unrelated = Component->FindConstraintInstance(Other->DefaultInstance.JointName))
				Unrelated->TermConstraint();
		}
		FBodyInstance* B = Component->GetBodyInstance(J->ConstraintBone1);
		if (!B) return TEXT("missing simulated child body");
		B->SetInstanceSimulatePhysics(true);
		B->SetEnableGravity(false);
		if (!B->IsInstanceSimulatingPhysics()) return TEXT("child did not simulate");
		const FTransform JointWorld = J->GetRefFrame(EConstraintFrame::Frame1) * B->GetUnrealWorldTransform();
		const FVector Axis = JointWorld.GetUnitAxis(EAxis::X);
		const float Initial = FMath::RadiansToDegrees(J->GetCurrentTwist());
		FPhysScene* Physics = Scene.GetWorld()->GetPhysicsScene();
		const FVector Gravity = FVector::ZeroVector;
		constexpr float StepSeconds = 1.f / 120.f;
		float Peak = 0;
		for (int32 Step = 0; Step < 180; ++Step)
		{
			B->SetAngularVelocityInRadians(Axis * 2.0, false);
			// UWorld tick functions run once per engine frame. Step this private Chaos scene explicitly.
			Physics->SetUpForFrame(&Gravity, StepSeconds, 0.f, StepSeconds, StepSeconds, 1, false);
			Physics->StartFrame();
			Physics->WaitPhysScenes();
			Physics->EndFrame();
			Peak = FMath::Max(Peak, FMath::Abs(FMath::RadiansToDegrees(J->GetCurrentTwist())));
		}
		Result->SetNumberField(TEXT("steps"), 180);
		Result->SetNumberField(TEXT("initial_degrees"), Initial);
		Result->SetNumberField(TEXT("peak_degrees"), Peak);
		Result->SetNumberField(TEXT("final_degrees"), FMath::RadiansToDegrees(J->GetCurrentTwist()));
	}
	return PhysicsAssetProbe::Serialize(Result);
#else
	return TEXT("editor required");
#endif
}
