// Copyright Noah Butcher. All Rights Reserved.
#include "PhysicsAssetHandlers.h"
#include "BlueprintHandlerHelpers.h"
#include "Editor.h"
#include "Engine/SkeletalMesh.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/PackageName.h"
#include "PhysicsAssetUtils.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "PhysicsEngine/PhysicsConstraintTemplate.h"
#if __has_include("PhysicsEngine/SkeletalBodySetup.h")
#include "PhysicsEngine/SkeletalBodySetup.h"
#endif // UE 5.3 declares USkeletalBodySetup in PhysicsAsset.h.
#include "ScopedTransaction.h"

namespace UEMCP::PhysicsAuthoring
{
	using FJson = TSharedPtr<FJsonObject>;

	static bool ReadName(const FJson& Params, const TCHAR* Key, FName& Out)
	{
		FString Text;
		if (!Params->TryGetStringField(Key, Text) || Text.IsEmpty() || Text.Len() >= NAME_SIZE || Text.TrimStartAndEnd() != Text) return false;
		Out = FName(*Text);
		return !Out.IsNone();
	}

	static bool HasUsableTopology(const UPhysicsAsset* Asset)
	{
		TSet<FName> Bones, Joints;
		for (int32 Index = 0; Index < Asset->SkeletalBodySetups.Num(); ++Index)
		{
			const USkeletalBodySetup* Body = Asset->SkeletalBodySetups[Index];
			if (!Body || Body->BoneName.IsNone() || Bones.Contains(Body->BoneName) || Asset->FindBodyIndex(Body->BoneName) != Index)
				return false;
			Bones.Add(Body->BoneName);
		}
		for (const UPhysicsConstraintTemplate* Template : Asset->ConstraintSetup)
		{
			if (!Template) return false;
			const FConstraintInstance& Joint = Template->DefaultInstance;
			if (Joint.JointName.IsNone() || Joints.Contains(Joint.JointName) || Joint.ConstraintBone1 == Joint.ConstraintBone2 ||
				!Bones.Contains(Joint.ConstraintBone1) || !Bones.Contains(Joint.ConstraintBone2))
				return false;
			Joints.Add(Joint.JointName);
		}
		return true;
	}

	static UPhysicsAsset* ResolveAsset(const FJson& Params, FJson& Out, bool bWrite)
	{
		FString Path;
		if (!Params || !Params->TryGetStringField(TEXT("asset_path"), Path) || Path.Len() > 512 ||
			!Path.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive))
		{
			BuildErrorResponse(Out, TEXT("Supply an exact /Game PhysicsAsset package or object path"), TEXT("INVALID_PATH"));
			return nullptr;
		}
		const FString Package = FPackageName::ObjectPathToPackageName(Path);
		const FString ObjectPath = Package + TEXT(".") + FPackageName::GetLongPackageAssetName(Package);
		UPhysicsAsset* Asset = nullptr;
		if (FPackageName::IsValidLongPackageName(Package) && (Path.Equals(Package, ESearchCase::CaseSensitive) || Path.Equals(ObjectPath, ESearchCase::CaseSensitive)))
			Asset = LoadObject<UPhysicsAsset>(nullptr, *ObjectPath, nullptr, LOAD_NoWarn);
		if (!Asset || !Asset->IsAsset() || !Asset->GetPathName().Equals(ObjectPath, ESearchCase::CaseSensitive))
		{
			BuildErrorResponse(Out, TEXT("No PhysicsAsset at that project path"), TEXT("ASSET_NOT_FOUND"));
			return nullptr;
		}
		if (bWrite && (!GEditor || GEditor->IsPlaySessionInProgress() || GEditor->PlayWorld))
		{
			BuildErrorResponse(Out, TEXT("Stop PIE or simulation before editing physics definitions"), TEXT("EDITOR_BUSY"));
			return nullptr;
		}
		if (bWrite && !IsWritableAnimPackage(Asset->GetOutermost()))
		{
			BuildErrorResponse(Out, TEXT("PhysicsAsset package is read-only"), TEXT("READ_ONLY"));
			return nullptr;
		}
		if (bWrite && !Asset->CurrentConstraintProfileName.IsNone())
		{
			BuildErrorResponse(Out, TEXT("Select the default constraint profile before editing"), TEXT("PROFILE_ACTIVE"));
			return nullptr;
		}
		if (!HasUsableTopology(Asset))
		{
			BuildErrorResponse(Out, TEXT("PhysicsAsset contains missing or ambiguous body or constraint entries"), TEXT("INVALID_TOPOLOGY"));
			return nullptr;
		}
		return Asset;
	}

	static FJson BodyRow(const USkeletalBodySetup* Body)
	{
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("bone"), Body->BoneName.ToString());
		Row->SetNumberField(TEXT("shape_count"), Body->AggGeom.GetElementCount());
		TArray<TSharedPtr<FJsonValue>> Spheres;
		for (const FKSphereElem& Sphere : Body->AggGeom.SphereElems)
		{
			auto Item = MakeShared<FJsonObject>();
			Item->SetNumberField(TEXT("radius_cm"), Sphere.Radius);
			Item->SetArrayField(TEXT("center_cm"), {MakeShared<FJsonValueNumber>(Sphere.Center.X), MakeShared<FJsonValueNumber>(Sphere.Center.Y), MakeShared<FJsonValueNumber>(Sphere.Center.Z)});
			Spheres.Add(MakeShared<FJsonValueObject>(Item));
		}
		Row->SetArrayField(TEXT("spheres"), Spheres);
		return Row;
	}

	static FJson JointFrame(const FTransform& Frame)
	{
		auto Json = MakeShared<FJsonObject>();
		const FVector T = Frame.GetTranslation();
		const FQuat Q = Frame.GetRotation();
		Json->SetArrayField(TEXT("translation_cm"), {MakeShared<FJsonValueNumber>(T.X), MakeShared<FJsonValueNumber>(T.Y), MakeShared<FJsonValueNumber>(T.Z)});
		Json->SetArrayField(TEXT("rotation_xyzw"), {MakeShared<FJsonValueNumber>(Q.X), MakeShared<FJsonValueNumber>(Q.Y), MakeShared<FJsonValueNumber>(Q.Z), MakeShared<FJsonValueNumber>(Q.W)});
		return Json;
	}

	static FJson ConstraintRow(const UPhysicsConstraintTemplate* Template)
	{
		const FConstraintInstance& Joint = Template->DefaultInstance;
		const auto& Limit = Template->GetConstraintProfilePropertiesOrDefault(NAME_None).TwistLimit;
		auto Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("joint"), Joint.JointName.ToString());
		Row->SetStringField(TEXT("bone1"), Joint.ConstraintBone1.ToString());
		Row->SetStringField(TEXT("bone2"), Joint.ConstraintBone2.ToString());
		Row->SetStringField(TEXT("twist_motion"), Limit.TwistMotion == ACM_Limited ? TEXT("limited") : Limit.TwistMotion == ACM_Locked ? TEXT("locked") : TEXT("free"));
		Row->SetNumberField(TEXT("twist_limit_degrees"), Limit.TwistLimitDegrees);
		Row->SetObjectField(TEXT("frame1"), JointFrame(Joint.GetRefFrame(EConstraintFrame::Frame1)));
		Row->SetObjectField(TEXT("frame2"), JointFrame(Joint.GetRefFrame(EConstraintFrame::Frame2)));
		return Row;
	}

	static void Inspect(const FJson& Params, FJson& Out)
	{
		UPhysicsAsset* Asset = ResolveAsset(Params, Out, false);
		if (!Asset) return;
		auto Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
		Result->SetStringField(TEXT("profile"), TEXT("default"));
		Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
		TArray<TSharedPtr<FJsonValue>> Bodies, Constraints;
		for (const USkeletalBodySetup* Body : Asset->SkeletalBodySetups)
		{
			Bodies.Add(MakeShared<FJsonValueObject>(BodyRow(Body)));
		}
		for (const UPhysicsConstraintTemplate* Joint : Asset->ConstraintSetup)
		{
			Constraints.Add(MakeShared<FJsonValueObject>(ConstraintRow(Joint)));
		}
		Result->SetArrayField(TEXT("bodies"), Bodies);
		Result->SetArrayField(TEXT("constraints"), Constraints);
		BuildSuccessResponse(Out, Result);
	}

	static void FinishEdit(UPhysicsAsset* Asset, FJson Row, FJson& Out, bool bChanged)
	{
		if (bChanged)
		{
			Asset->PostEditChange();
			Asset->RefreshPhysicsAssetChange();
		}
		Row->SetStringField(TEXT("asset_path"), Asset->GetPathName());
		Row->SetBoolField(TEXT("changed"), bChanged);
		Row->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
		BuildSuccessResponse(Out, Row);
	}

	static bool ReadAngle(const FJson& Params, float& Angle)
	{
		double Number = 0;
		if (!Params->HasTypedField<EJson::Number>(TEXT("twist_limit_degrees")) ||
			!Params->TryGetNumberField(TEXT("twist_limit_degrees"), Number) ||
			!FMath::IsFinite(Number) || Number < 1 || Number > 179) return false;
		Angle = static_cast<float>(Number);
		return true;
	}

	static void SetLimit(const FJson& Params, FJson& Out)
	{
		UPhysicsAsset* Asset = ResolveAsset(Params, Out, true);
		if (!Asset) return;
		FName Name;
		float Angle;
		if (!ReadName(Params, TEXT("joint"), Name) || !ReadAngle(Params, Angle))
		{
			BuildErrorResponse(Out, TEXT("Supply an existing joint and twist_limit_degrees between 1 and 179"), TEXT("INVALID_ARGUMENT")); return;
		}
		const int32 JointIndex = Asset->FindConstraintIndex(Name);
		if (JointIndex == INDEX_NONE) { BuildErrorResponse(Out, TEXT("Joint was not found"), TEXT("JOINT_NOT_FOUND")); return; }
		UPhysicsConstraintTemplate* Template = Asset->ConstraintSetup[JointIndex];
		const auto& Limit = Template->GetConstraintProfilePropertiesOrDefault(NAME_None).TwistLimit;
		if (Limit.TwistMotion == ACM_Limited && Limit.TwistLimitDegrees == Angle)
		{
			FinishEdit(Asset, ConstraintRow(Template), Out, false); return;
		}
		FScopedTransaction Tx(NSLOCTEXT("UEMCP", "EditTwist", "Edit physics constraint twist limit"));
		Asset->SetFlags(RF_Transactional);
		Asset->Modify();
		Template->SetFlags(RF_Transactional);
		Template->Modify();
		Template->ApplyConstraintProfile(NAME_None, Template->DefaultInstance, true);
		Template->DefaultInstance.SetAngularTwistLimit(ACM_Limited, Angle);
		Template->SetDefaultProfile(Template->DefaultInstance);
		FinishEdit(Asset, ConstraintRow(Template), Out, true);
	}

	static void AddBody(const FJson& Params, FJson& Out)
	{
		UPhysicsAsset* Asset = ResolveAsset(Params, Out, true);
		if (!Asset) return;
		FName Bone;
		double Radius = 0;
		if (!ReadName(Params, TEXT("bone"), Bone) || !Params->HasTypedField<EJson::Number>(TEXT("radius_cm")) ||
			!Params->TryGetNumberField(TEXT("radius_cm"), Radius) || !FMath::IsFinite(Radius) || Radius < 0.1 || Radius > 10000)
		{
			BuildErrorResponse(Out, TEXT("Supply a bone and sphere radius_cm between 0.1 and 10000"), TEXT("INVALID_ARGUMENT")); return;
		}
		USkeletalMesh* Mesh = Asset->GetPreviewMesh();
		if (!Mesh || Mesh->GetRefSkeleton().FindBoneIndex(Bone) == INDEX_NONE)
		{
			BuildErrorResponse(Out, TEXT("The preview mesh must contain the requested bone"), TEXT("BONE_NOT_FOUND")); return;
		}
		if (Asset->FindBodyIndex(Bone) != INDEX_NONE)
		{
			BuildErrorResponse(Out, TEXT("The bone already has a body"), TEXT("BODY_EXISTS")); return;
		}
		FScopedTransaction Tx(NSLOCTEXT("UEMCP", "AddSphereBody", "Add physics sphere body"));
		Asset->SetFlags(RF_Transactional);
		Asset->Modify();
		FPhysAssetCreateParams Options;
		Options.bDisableCollisionsByDefault = false;
		const int32 Index = FPhysicsAssetUtils::CreateNewBody(Asset, Bone, Options);
		USkeletalBodySetup* Body = Asset->SkeletalBodySetups[Index];
		Body->Modify();
		FKSphereElem& Sphere = Body->AggGeom.SphereElems.AddDefaulted_GetRef();
		Sphere.Radius = static_cast<float>(Radius);
		Body->InvalidatePhysicsData();
		FinishEdit(Asset, BodyRow(Body), Out, true);
	}

	static void AddConstraint(const FJson& Params, FJson& Out)
	{
		UPhysicsAsset* Asset = ResolveAsset(Params, Out, true);
		if (!Asset) return;
		FName JointName, Child, Parent;
		float Angle;
		if (!ReadName(Params, TEXT("joint"), JointName) || !ReadName(Params, TEXT("child_bone"), Child) ||
			!ReadName(Params, TEXT("parent_bone"), Parent) || !ReadAngle(Params, Angle) || Child == Parent)
		{
			BuildErrorResponse(Out, TEXT("Supply a joint name, two distinct body bones and twist_limit_degrees from 1 to 179"), TEXT("INVALID_ARGUMENT")); return;
		}
		const int32 ChildBody = Asset->FindBodyIndex(Child), ParentBody = Asset->FindBodyIndex(Parent);
		USkeletalMesh* Mesh = Asset->GetPreviewMesh();
		if (ChildBody == INDEX_NONE || ParentBody == INDEX_NONE || !Mesh ||
			Mesh->GetRefSkeleton().FindBoneIndex(Child) == INDEX_NONE || Mesh->GetRefSkeleton().FindBoneIndex(Parent) == INDEX_NONE)
		{
			BuildErrorResponse(Out, TEXT("Both bodies and their preview mesh bones must exist"), TEXT("BODY_NOT_FOUND")); return;
		}
		if (!Mesh->GetRefSkeleton().BoneIsChildOf(Mesh->GetRefSkeleton().FindBoneIndex(Child), Mesh->GetRefSkeleton().FindBoneIndex(Parent)))
		{
			BuildErrorResponse(Out, TEXT("parent_bone must be an ancestor of child_bone on the preview skeleton"), TEXT("INVALID_BODY_PAIR")); return;
		}
		if (!FPhysicsAssetUtils::CanCreateConstraints())
		{
			BuildErrorResponse(Out, TEXT("Constraint creation is disabled for this solver"), TEXT("CONSTRAINT_UNAVAILABLE")); return;
		}
		for (const UPhysicsConstraintTemplate* Existing : Asset->ConstraintSetup)
		{
			const FConstraintInstance& C = Existing->DefaultInstance;
			if (C.JointName == JointName || (C.ConstraintBone1 == Child && C.ConstraintBone2 == Parent) || (C.ConstraintBone2 == Child && C.ConstraintBone1 == Parent))
			{
				BuildErrorResponse(Out, TEXT("The joint name or body pair already exists"), TEXT("CONSTRAINT_EXISTS")); return;
			}
		}
		FScopedTransaction Tx(NSLOCTEXT("UEMCP", "AddTwistJoint", "Add physics twist constraint"));
		Asset->SetFlags(RF_Transactional);
		Asset->Modify();
		const int32 Index = FPhysicsAssetUtils::CreateNewConstraint(Asset, JointName);
		if (Index == INDEX_NONE) { Tx.Cancel(); BuildErrorResponse(Out, TEXT("Constraint creation is disabled for this solver"), TEXT("CONSTRAINT_UNAVAILABLE")); return; }
		UPhysicsConstraintTemplate* Template = Asset->ConstraintSetup[Index];
		Template->Modify();
		FConstraintInstance& Joint = Template->DefaultInstance;
		Joint.ConstraintBone1 = Child;
		Joint.ConstraintBone2 = Parent;
		Joint.SnapTransformsToDefault(EConstraintTransformComponentFlags::All, Asset);
		Joint.SetAngularSwing1Limit(ACM_Locked, 0);
		Joint.SetAngularSwing2Limit(ACM_Locked, 0);
		Joint.SetAngularTwistLimit(ACM_Limited, Angle);
		Template->SetDefaultProfile(Joint);
		Asset->DisableCollision(ChildBody, ParentBody);
		FinishEdit(Asset, ConstraintRow(Template), Out, true);
	}
}

void UEMCP::RegisterPhysicsAssetHandlers(FMCPCommandRegistry& Registry)
{
	Registry.Register(TEXT("get_physics_asset"), &PhysicsAuthoring::Inspect);
	Registry.Register(TEXT("set_physics_constraint_limit"), &PhysicsAuthoring::SetLimit);
	Registry.Register(TEXT("add_physics_sphere_body"), &PhysicsAuthoring::AddBody);
	Registry.Register(TEXT("add_physics_constraint"), &PhysicsAuthoring::AddConstraint);
}
