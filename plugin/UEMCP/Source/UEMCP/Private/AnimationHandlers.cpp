// Copyright Optimum Athena. All Rights Reserved.
#include "AnimationHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Animation/AnimMontage.h"
#include "Animation/AnimNotifies/AnimNotify.h"
#include "Animation/AnimNotifies/AnimNotifyState.h"
#include "Animation/AnimSequence.h"
#include "Animation/AnimSequenceBase.h"
#include "Animation/Skeleton.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"

namespace UEMCP
{
	namespace
	{
		// ── Path helpers ─────────────────────────────────────────────────────────

		// Convert "/Game/Animations/Foo" → "/Game/Animations/Foo.Foo" (doubled
		// object-path form). Pass-through if already doubled. Mirrors the
		// canonical lookup form used in WidgetHandlers (D102 institutional memory:
		// LoadObject<T> with doubled object-path survives PIE state).
		FString ToObjectPath(const FString& AssetPath)
		{
			if (AssetPath.Contains(TEXT("."))) return AssetPath;
			const int32 SlashIdx = AssetPath.Find(TEXT("/"), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
			if (SlashIdx < 0) return AssetPath;
			const FString AssetName = AssetPath.Mid(SlashIdx + 1);
			return FString::Printf(TEXT("%s.%s"), *AssetPath, *AssetName);
		}

		FString GetStringOr(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field, const FString& Default)
		{
			FString Out;
			return Params->TryGetStringField(Field, Out) ? Out : Default;
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 1. create_montage — build UAnimMontage from a source UAnimSequence
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Builds a single-slot, single-segment montage with one default section.
		// Skeleton inherited from the source AnimSequence. Subsequent calls to
		// add_montage_section / add_montage_notify mutate this same asset.

		void HandleCreateMontage(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_montage requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name, AnimSequencePath;
			if (!Params->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("anim_sequence"), AnimSequencePath) || AnimSequencePath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'anim_sequence' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FString PackagePath = GetStringOr(Params, TEXT("path"), TEXT("/Game/Animations"));

			const FString AnimObjectPath = ToObjectPath(AnimSequencePath);
			UAnimSequence* AnimSeq = LoadObject<UAnimSequence>(nullptr, *AnimObjectPath);
			if (!AnimSeq)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("AnimSequence not found at '%s'"), *AnimSequencePath),
					TEXT("ANIM_SEQUENCE_NOT_FOUND"));
				return;
			}
			USkeleton* Skeleton = AnimSeq->GetSkeleton();
			if (!Skeleton)
			{
				BuildErrorResponse(OutResponse,
					TEXT("AnimSequence has no Skeleton — cannot derive montage skeleton"),
					TEXT("MISSING_SKELETON"));
				return;
			}

			const FString FullAssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *Name);
			if (FPackageName::DoesPackageExist(FullAssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset already exists at '%s'"), *FullAssetPath),
					TEXT("ASSET_EXISTS"));
				return;
			}

			UPackage* Package = CreatePackage(*FullAssetPath);
			if (!Package)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create package"), TEXT("PACKAGE_CREATE_FAILED"));
				return;
			}

			UAnimMontage* Montage = NewObject<UAnimMontage>(Package, *Name, RF_Public | RF_Standalone);
			if (!Montage)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create UAnimMontage"), TEXT("MONTAGE_CREATE_FAILED"));
				return;
			}
			Montage->SetSkeleton(Skeleton);

			// Build a default slot containing the source AnimSequence as the only segment.
			const float PlayLength = AnimSeq->GetPlayLength();
			FAnimSegment Segment;
			Segment.SetAnimReference(AnimSeq);
			Segment.AnimStartTime = 0.0f;
			Segment.AnimEndTime = PlayLength;
			Segment.AnimPlayRate = 1.0f;
			Segment.StartPos = 0.0f;

			// UAnimMontage's constructor already inserts an empty DefaultSlot via
			// AddSlot(FAnimSlotGroup::DefaultSlotName) — see UE 5.6
			// Engine/Source/Runtime/Engine/Private/Animation/AnimMontage.cpp:75.
			// Inject our segment into that existing slot rather than appending a
			// second one (the duplicate produced "Slot 'DefaultSlot' already used"
			// log spam at hundreds of warnings/sec when the asset was opened).
			FSlotAnimationTrack* DefaultSlot = nullptr;
			for (FSlotAnimationTrack& Slot : Montage->SlotAnimTracks)
			{
				if (Slot.SlotName == FAnimSlotGroup::DefaultSlotName)
				{
					DefaultSlot = &Slot;
					break;
				}
			}
			if (!DefaultSlot)
			{
				DefaultSlot = &Montage->AddSlot(FAnimSlotGroup::DefaultSlotName);
			}
			DefaultSlot->AnimTrack.AnimSegments.Add(Segment);

			// Default section at time 0 (no auto-advance).
			FCompositeSection DefaultSection;
			DefaultSection.SectionName = FName(TEXT("Default"));
			DefaultSection.SetTime(0.0f);
			DefaultSection.NextSectionName = NAME_None;
			Montage->CompositeSections.Add(DefaultSection);

			Montage->SetCompositeLength(PlayLength);
			Montage->RefreshCacheData();
			Montage->PostEditChange();
			Package->MarkPackageDirty();
			FAssetRegistryModule::AssetCreated(Montage);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), Name);
			Result->SetStringField(TEXT("path"), FullAssetPath);
			Result->SetStringField(TEXT("anim_sequence"), AnimObjectPath);
			Result->SetStringField(TEXT("skeleton"), Skeleton->GetPathName());
			Result->SetNumberField(TEXT("length"), PlayLength);
			Result->SetNumberField(TEXT("slot_count"), Montage->SlotAnimTracks.Num());
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 2. add_montage_section — append a named section at a specified time
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Refuses to overwrite an existing section by name (the legacy oracle
		// silently overwrote, per the animation TOOLSET_TIPS quirk). Loud failure
		// is preferable to silent collision.

		void HandleAddMontageSection(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_montage_section requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath, SectionName;
			double Time = 0.0;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'asset_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("section_name"), SectionName) || SectionName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'section_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetNumberField(TEXT("time"), Time))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'time' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			const FString ObjectPath = ToObjectPath(AssetPath);
			UAnimMontage* Montage = LoadObject<UAnimMontage>(nullptr, *ObjectPath);
			if (!Montage)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("UAnimMontage not found at '%s'"), *AssetPath),
					TEXT("MONTAGE_NOT_FOUND"));
				return;
			}

			const FName SectionFName(*SectionName);
			for (const FCompositeSection& Existing : Montage->CompositeSections)
			{
				if (Existing.SectionName == SectionFName)
				{
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("Section '%s' already exists in montage"), *SectionName),
						TEXT("SECTION_EXISTS"));
					return;
				}
			}

			FCompositeSection NewSection;
			NewSection.SectionName = SectionFName;
			NewSection.SetTime(static_cast<float>(Time));
			NewSection.NextSectionName = NAME_None;
			Montage->CompositeSections.Add(NewSection);
			Montage->RefreshCacheData();
			Montage->PostEditChange();
			Montage->MarkPackageDirty();

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), AssetPath);
			Result->SetStringField(TEXT("section_name"), SectionName);
			Result->SetNumberField(TEXT("time"), Time);
			Result->SetNumberField(TEXT("section_count"), Montage->CompositeSections.Num());
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 3. add_montage_notify — append a UAnimNotify or UAnimNotifyState
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Resolves notify_class by short-name first, falling back to TObjectIterator
		// over loaded UClass — mirrors how editor browsers resolve notify subclasses.
		// Stateful (UAnimNotifyState) gets a default 0.1s duration; Notify is
		// instantaneous.

		UClass* ResolveNotifyClass(const FString& NotifyClassName)
		{
			// Direct path resolution first (e.g. "/Script/Engine.AnimNotify_PlaySound").
			if (UClass* Direct = FindObject<UClass>(nullptr, *NotifyClassName))
			{
				return Direct;
			}
			// /Script/Engine.<ShortName> hint.
			const FString WithEnginePrefix = FString::Printf(TEXT("/Script/Engine.%s"), *NotifyClassName);
			if (UClass* WithPrefix = FindObject<UClass>(nullptr, *WithEnginePrefix))
			{
				return WithPrefix;
			}
			// Fall back to short-name match across all loaded UClasses. O(n) but
			// once-per-handler-call; the editor already pays this cost in its own
			// notify-class browser.
			for (TObjectIterator<UClass> It; It; ++It)
			{
				if (It->GetName() == NotifyClassName)
				{
					return *It;
				}
			}
			return nullptr;
		}

		void HandleAddMontageNotify(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_montage_notify requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath, NotifyClassName;
			double Time = 0.0;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'asset_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("notify_class"), NotifyClassName) || NotifyClassName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'notify_class' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetNumberField(TEXT("time"), Time))
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'time' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			const FString ObjectPath = ToObjectPath(AssetPath);
			UAnimMontage* Montage = LoadObject<UAnimMontage>(nullptr, *ObjectPath);
			if (!Montage)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("UAnimMontage not found at '%s'"), *AssetPath),
					TEXT("MONTAGE_NOT_FOUND"));
				return;
			}

			UClass* NotifyClass = ResolveNotifyClass(NotifyClassName);
			if (!NotifyClass)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Notify class not found: '%s'"), *NotifyClassName),
					TEXT("NOTIFY_CLASS_NOT_FOUND"));
				return;
			}
			const bool bIsStateful = NotifyClass->IsChildOf(UAnimNotifyState::StaticClass());
			const bool bIsNotify   = NotifyClass->IsChildOf(UAnimNotify::StaticClass());
			if (!bIsStateful && !bIsNotify)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Class '%s' is not a UAnimNotify or UAnimNotifyState"), *NotifyClassName),
					TEXT("NOTIFY_CLASS_INVALID"));
				return;
			}
			if (NotifyClass->HasAnyClassFlags(CLASS_Abstract))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Class '%s' is abstract — cannot instantiate notify"), *NotifyClassName),
					TEXT("NOTIFY_CLASS_ABSTRACT"));
				return;
			}

			FAnimNotifyEvent NewEvent;
			NewEvent.NotifyName = NotifyClass->GetFName();
			// Pass EAnimLinkMethod::Absolute explicitly — relative links require a
			// section anchor and add complexity for no current consumer. NotifyName
			// is set explicitly above (auto-assignment inside Link/PostEditChange
			// is not guaranteed across UE 5.x revisions).
			NewEvent.Link(Montage, static_cast<float>(Time), EAnimLinkMethod::Absolute);
			NewEvent.TriggerTimeOffset = 0.0f;

			if (bIsStateful)
			{
				UAnimNotifyState* StatefulInst = NewObject<UAnimNotifyState>(Montage, NotifyClass);
				if (!StatefulInst)
				{
					BuildErrorResponse(OutResponse, TEXT("Failed to instantiate UAnimNotifyState"), TEXT("NOTIFY_CREATE_FAILED"));
					return;
				}
				NewEvent.NotifyStateClass = StatefulInst;
				NewEvent.SetDuration(0.1f);
			}
			else
			{
				UAnimNotify* NotifyInst = NewObject<UAnimNotify>(Montage, NotifyClass);
				if (!NotifyInst)
				{
					BuildErrorResponse(OutResponse, TEXT("Failed to instantiate UAnimNotify"), TEXT("NOTIFY_CREATE_FAILED"));
					return;
				}
				NewEvent.Notify = NotifyInst;
			}
			Montage->Notifies.Add(NewEvent);
			Montage->RefreshCacheData();
			Montage->PostEditChange();
			Montage->MarkPackageDirty();

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), AssetPath);
			Result->SetStringField(TEXT("notify_class"), NotifyClassName);
			Result->SetNumberField(TEXT("time"), Time);
			Result->SetBoolField(TEXT("is_stateful"), bIsStateful);
			Result->SetNumberField(TEXT("notify_count"), Montage->Notifies.Num());
			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterAnimationHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("create_montage"),      &HandleCreateMontage);
		Registry.Register(TEXT("add_montage_section"), &HandleAddMontageSection);
		Registry.Register(TEXT("add_montage_notify"),  &HandleAddMontageNotify);
		// get_audio_asset_info: SUPERSEDED-as-offline per D101 (v) decision.
		// yaml entry says `displaced_by: read_asset_properties` — D50 tagged-fallback
		// covers SoundCue/SoundWave CDO metadata via FPropertyTag iteration. Wwise
		// AkAudioEvent reflection requires the SDK and is unreachable from both
		// reflection_walk and offline parsers, so a live-editor handler would not
		// extend coverage. yaml entry kept as discovery breadcrumb; no live route.
	}
}
