// Copyright Noah Butcher. All Rights Reserved.
#if WITH_DEV_AUTOMATION_TESTS
#include "Animation/AnimMontage.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "MCPCommandRegistry.h"
#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#include "UObject/StrongObjectPtr.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPMontageTimeline, "UEMCP.Animation.MontageTimeline",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPMontageTimeline::RunTest(const FString&)
{
	if (!TestTrue(TEXT("Idle Undo history"), GEditor && GEditor->Trans && !GEditor->Trans->IsActive() && !GUndo)) return false;
	const FString Name = TEXT("AM_Timeline_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	auto Invoke = [](const TCHAR* Command, const TSharedPtr<FJsonObject>& Args)
	{
		TSharedPtr<FJsonObject> Response;
		UEMCP::FMCPCommandRegistry::Get().Dispatch(Command, Args, Response);
		return Response;
	};
	auto Args = MakeShared<FJsonObject>();
	Args->SetStringField(TEXT("name"), Name);
	Args->SetStringField(TEXT("path"), TEXT("/Game/__UEMCPTests"));
	Args->SetStringField(TEXT("anim_sequence"), TEXT("/Engine/Tutorial/SubEditors/TutorialAssets/Character/Tutorial_Walk_Fwd"));
	const FString Path = TEXT("/Game/__UEMCPTests/") + Name + TEXT(".") + Name;
	Invoke(TEXT("create_montage"), Args);
	auto* Montage = FindObject<UAnimMontage>(nullptr, *Path);
	if (!TestNotNull(TEXT("Created montage"), Montage)) return false;
	ON_SCOPE_EXIT { FAssetRegistryModule::AssetDeleted(Montage); Montage->GetOutermost()->SetDirtyFlag(false); Montage->ClearFlags(RF_Public | RF_Standalone); };
	TStrongObjectPtr<UTransactor> Prior(GEditor->Trans.Get());
	TStrongObjectPtr<UTransBuffer> History(NewObject<UTransBuffer>());
	History->Initialize(8 * 1024 * 1024);
	TGuardValue<decltype(GEditor->Trans)> ScopedHistory(GEditor->Trans, History.Get());
	Args->SetStringField(TEXT("asset_path"), Path);
	const double End = Montage->CalculateSequenceLength();
	Args->SetNumberField(TEXT("time"), End);
	Args->SetStringField(TEXT("section_name"), TEXT("Within"));
	Montage->GetOutermost()->SetDirtyFlag(false);
	auto Status = [&](const TCHAR* Command)
	{
		const auto R = Invoke(Command, Args);
		return R.IsValid() ? R->GetStringField(TEXT("status")) : FString();
	};
	TestEqual(TEXT("Endpoint section refused"), Status(TEXT("add_montage_section")), FString(TEXT("error")));
	Args->SetNumberField(TEXT("time"), End + 0.001);
	Args->SetStringField(TEXT("notify_class"), TEXT("/Script/Engine.AnimNotify_PlaySound"));
	TestEqual(TEXT("Late cue refused"), Status(TEXT("add_montage_notify")), FString(TEXT("error")));
	TestTrue(TEXT("Rejections preserved asset"), !Montage->GetOutermost()->IsDirty() && Montage->CompositeSections.Num() == 1 && Montage->Notifies.IsEmpty());
	Args->SetNumberField(TEXT("time"), End * 0.5);
	if (!TestEqual(TEXT("Interior section accepted"), Status(TEXT("add_montage_section")), FString(TEXT("success")))) return false;
	TestTrue(TEXT("Manual routing preserved"), Montage->CompositeSections[0].NextSectionName.IsNone());
	Args->SetStringField(TEXT("section_name"), TEXT("Default"));
	Args->SetStringField(TEXT("next_section"), TEXT("Within"));
	if (!TestEqual(TEXT("Route accepted"), Status(TEXT("set_montage_next_section")), FString(TEXT("success")))) return false;
	TestEqual(TEXT("Stored route"), Montage->CompositeSections[0].NextSectionName, FName(TEXT("Within")));
	Status(TEXT("set_montage_next_section"));
	TestTrue(TEXT("One Undo after retry"), History->Undo());
	TestTrue(TEXT("Previous terminal section restored"), Montage->CompositeSections[0].NextSectionName.IsNone());
	TestTrue(TEXT("Redo route"), History->Redo());
	TestEqual(TEXT("Redo restored destination"), Montage->CompositeSections[0].NextSectionName, FName(TEXT("Within")));
	Args->SetNumberField(TEXT("time"), End);
	if (!TestEqual(TEXT("Instant at end accepted"), Status(TEXT("add_montage_notify")), FString(TEXT("success")))) return false;
	TestTrue(TEXT("Notify linked to an animation segment"), Montage->Notifies.Num() == 1 && Montage->Notifies[0].GetSegmentIndex() != INDEX_NONE);
	TestTrue(TEXT("Undo notify"), History->Undo());
	TestTrue(TEXT("Notify removed"), Montage->Notifies.IsEmpty());
	Args->SetStringField(TEXT("notify_class"), TEXT("/Script/Engine.AnimNotifyState_TimedParticleEffect"));
	Args->SetNumberField(TEXT("time"), End - 0.05);
	TestEqual(TEXT("State duration must fit"), Status(TEXT("add_montage_notify")), FString(TEXT("error")));
	Args->SetNumberField(TEXT("time"), End * 0.25);
	if (!TestEqual(TEXT("Interior state accepted"), Status(TEXT("add_montage_notify")), FString(TEXT("success")))) return false;
	TestTrue(TEXT("State end linked"), Montage->Notifies.Num() == 1 && Montage->Notifies[0].EndLink.GetSegmentIndex() != INDEX_NONE);
	return true;
}
#endif
