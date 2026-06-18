// Copyright Optimum Athena. All Rights Reserved.
#include "AnimationHandlers.h"

#include "HandlerCommon.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Animation/AnimData/IAnimationDataModel.h"
#include "Animation/AnimCurveTypes.h"
#include "Animation/AnimMontage.h"
#include "Animation/AnimNotifies/AnimNotify.h"
#include "Animation/AnimNotifies/AnimNotifyState.h"
#include "Animation/AnimSequence.h"
#include "Animation/AnimSequenceBase.h"
#include "Animation/Skeleton.h"
#include "Misc/FrameRate.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"

namespace UEMCP
{
	namespace
	{
		// Path helpers (ToObjectPath / GetStringOr) extracted to UEMCP::ToObjectPath /
		// UEMCP::GetStringOr — see Public/HandlerCommon.h. Local copies removed to
		// allow Unity bundling (W-F D137).

		bool RequireAssetPath(const TSharedPtr<FJsonObject>& Params, const TCHAR* ToolName, FString& OutAssetPath, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("%s requires params"), ToolName),
					TEXT("MISSING_PARAMS"));
				return false;
			}
			if (!Params->TryGetStringField(TEXT("asset_path"), OutAssetPath) || OutAssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("%s requires non-empty asset_path"), ToolName),
					TEXT("MISSING_PARAMS"));
				return false;
			}
			return true;
		}

		void SetObjectPathOrNull(const TSharedPtr<FJsonObject>& Out, const TCHAR* FieldName, const UObject* Object)
		{
			if (Object)
			{
				Out->SetStringField(FieldName, Object->GetPathName());
			}
			else
			{
				Out->SetField(FieldName, MakeShared<FJsonValueNull>());
			}
		}

		TSharedPtr<FJsonObject> SerializeFrameRate(const FFrameRate& FrameRate)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetNumberField(TEXT("numerator"), FrameRate.Numerator);
			Out->SetNumberField(TEXT("denominator"), FrameRate.Denominator);
			if (FrameRate.IsValid())
			{
				Out->SetNumberField(TEXT("fps"), FrameRate.AsDecimal());
			}
			else
			{
				Out->SetField(TEXT("fps"), MakeShared<FJsonValueNull>());
			}
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeAnimNotifyEvent(const FAnimNotifyEvent& NotifyEvent)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetStringField(TEXT("notify_name"), NotifyEvent.NotifyName.ToString());
			Out->SetStringField(TEXT("event_name"), NotifyEvent.GetNotifyEventName().ToString());
			Out->SetNumberField(TEXT("time_seconds"), NotifyEvent.GetTriggerTime());
			Out->SetNumberField(TEXT("duration_seconds"), NotifyEvent.GetDuration());
			Out->SetNumberField(TEXT("track_index"), NotifyEvent.TrackIndex);
			Out->SetNumberField(TEXT("trigger_weight_threshold"), NotifyEvent.TriggerWeightThreshold);
			Out->SetNumberField(TEXT("trigger_chance"), NotifyEvent.NotifyTriggerChance);
			Out->SetBoolField(TEXT("is_state"), NotifyEvent.NotifyStateClass != nullptr);
			Out->SetBoolField(TEXT("is_branching_point"), NotifyEvent.IsBranchingPoint());
			Out->SetBoolField(TEXT("trigger_on_dedicated_server"), NotifyEvent.bTriggerOnDedicatedServer);
			Out->SetBoolField(TEXT("trigger_on_follower"), NotifyEvent.bTriggerOnFollower);
			SetObjectPathOrNull(Out, TEXT("notify_instance"), NotifyEvent.Notify);
			SetObjectPathOrNull(Out, TEXT("notify_class"), NotifyEvent.Notify ? NotifyEvent.Notify->GetClass() : nullptr);
			SetObjectPathOrNull(Out, TEXT("notify_state_instance"), NotifyEvent.NotifyStateClass);
			SetObjectPathOrNull(Out, TEXT("notify_state_class"), NotifyEvent.NotifyStateClass ? NotifyEvent.NotifyStateClass->GetClass() : nullptr);
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializeAnimNotifyEvents(const TArray<FAnimNotifyEvent>& Notifies)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			Out.Reserve(Notifies.Num());
			for (const FAnimNotifyEvent& NotifyEvent : Notifies)
			{
				Out.Add(MakeShared<FJsonValueObject>(SerializeAnimNotifyEvent(NotifyEvent)));
			}
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializeSyncMarkers(const TArray<FAnimSyncMarker>& Markers)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			Out.Reserve(Markers.Num());
			for (const FAnimSyncMarker& Marker : Markers)
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("name"), Marker.MarkerName.ToString());
				Entry->SetNumberField(TEXT("time_seconds"), Marker.Time);
#if WITH_EDITORONLY_DATA
				Entry->SetNumberField(TEXT("track_index"), Marker.TrackIndex);
#endif
				Out.Add(MakeShared<FJsonValueObject>(Entry));
			}
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializeRuntimeUnsupportedFields()
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			Out.Add(MakeShared<FJsonValueString>(TEXT("runtime_instance_state")));
			Out.Add(MakeShared<FJsonValueString>(TEXT("evaluated_pose")));
			Out.Add(MakeShared<FJsonValueString>(TEXT("runtime_blend_weights")));
			return Out;
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
			const FString PackagePath = UEMCP::GetStringOr(Params, TEXT("path"), TEXT("/Game/Animations"));

			const FString AnimObjectPath = UEMCP::ToObjectPath(AnimSequencePath);
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

			const FString ObjectPath = UEMCP::ToObjectPath(AssetPath);
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
		// Resolves notify_class via the shared UEMCP::ResolveClass resolver (load-first):
		// tries the bare name, then /Script/Engine.<name>, then /Script/Engine.AnimNotify_<name>.
		// Stateful (UAnimNotifyState) gets a default 0.1s duration; Notify is
		// instantaneous.

		UClass* ResolveNotifyClass(const FString& NotifyClassName)
		{
			// Load-first via the shared resolver, then the two engine short-name shapes.
			// No RequiredBase: the montage handler validates the notify type afterward
			// (behavior preserved). The deleted FindObject/TObjectIterator paths were
			// loaded-only — a cold /Game Blueprint notify now resolves because the
			// shared resolver loads /Game paths from disk.
			if (UClass* C = UEMCP::ResolveClass(NotifyClassName))
			{
				return C;
			}
			if (UClass* C = UEMCP::ResolveClass(FString::Printf(TEXT("/Script/Engine.%s"), *NotifyClassName)))
			{
				return C;
			}
			return UEMCP::ResolveClass(FString::Printf(TEXT("/Script/Engine.AnimNotify_%s"), *NotifyClassName));
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

			const FString ObjectPath = UEMCP::ToObjectPath(AssetPath);
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

		// ═══════════════════════════════════════════════════════════════════════
		// 4. get_montage_full — read a UAnimMontage asset instance
		// ═══════════════════════════════════════════════════════════════════════

		void HandleGetMontageFull(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!RequireAssetPath(Params, TEXT("get_montage_full"), AssetPath, OutResponse))
			{
				return;
			}

			const FString ObjectPath = UEMCP::ToObjectPath(AssetPath);
			UAnimMontage* Montage = LoadObject<UAnimMontage>(nullptr, *ObjectPath);
			if (!Montage)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("UAnimMontage not found at '%s'"), *AssetPath),
					TEXT("MONTAGE_NOT_FOUND"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), AssetPath);
			Result->SetStringField(TEXT("object_path"), Montage->GetPathName());
			Result->SetStringField(TEXT("asset_class"), Montage->GetClass()->GetPathName());
			SetObjectPathOrNull(Result, TEXT("skeleton"), Montage->GetSkeleton());
			Result->SetNumberField(TEXT("length_seconds"), Montage->GetPlayLength());
			Result->SetNumberField(TEXT("section_count"), Montage->CompositeSections.Num());
			Result->SetNumberField(TEXT("slot_track_count"), Montage->SlotAnimTracks.Num());
			Result->SetNumberField(TEXT("notify_count"), Montage->Notifies.Num());
			Result->SetNumberField(TEXT("blend_in_seconds"), Montage->GetDefaultBlendInTime());
			Result->SetNumberField(TEXT("blend_out_seconds"), Montage->GetDefaultBlendOutTime());
			Result->SetNumberField(TEXT("blend_out_trigger_time"), Montage->BlendOutTriggerTime);
			Result->SetBoolField(TEXT("enable_auto_blend_out"), Montage->bEnableAutoBlendOut);
			Result->SetStringField(TEXT("sync_group"), Montage->SyncGroup.ToString());
			Result->SetNumberField(TEXT("sync_slot_index"), Montage->SyncSlotIndex);
			Result->SetBoolField(TEXT("can_use_marker_sync"), Montage->CanUseMarkerSync());

			TArray<TSharedPtr<FJsonValue>> Sections;
			Sections.Reserve(Montage->CompositeSections.Num());
			for (int32 Index = 0; Index < Montage->CompositeSections.Num(); ++Index)
			{
				const FCompositeSection& Section = Montage->CompositeSections[Index];
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetNumberField(TEXT("index"), Index);
				Entry->SetStringField(TEXT("name"), Section.SectionName.ToString());
				Entry->SetNumberField(TEXT("time_seconds"), Section.GetTime());
				Entry->SetStringField(TEXT("next_section"), Section.NextSectionName.ToString());
				Sections.Add(MakeShared<FJsonValueObject>(Entry));
			}
			Result->SetArrayField(TEXT("sections"), Sections);

			TArray<TSharedPtr<FJsonValue>> SlotTracks;
			SlotTracks.Reserve(Montage->SlotAnimTracks.Num());
			for (int32 SlotIndex = 0; SlotIndex < Montage->SlotAnimTracks.Num(); ++SlotIndex)
			{
				const FSlotAnimationTrack& Slot = Montage->SlotAnimTracks[SlotIndex];
				TSharedPtr<FJsonObject> SlotJson = MakeShared<FJsonObject>();
				SlotJson->SetNumberField(TEXT("index"), SlotIndex);
				SlotJson->SetStringField(TEXT("slot_name"), Slot.SlotName.ToString());
				SlotJson->SetNumberField(TEXT("segment_count"), Slot.AnimTrack.AnimSegments.Num());

				TArray<TSharedPtr<FJsonValue>> Segments;
				Segments.Reserve(Slot.AnimTrack.AnimSegments.Num());
				for (int32 SegmentIndex = 0; SegmentIndex < Slot.AnimTrack.AnimSegments.Num(); ++SegmentIndex)
				{
					const FAnimSegment& Segment = Slot.AnimTrack.AnimSegments[SegmentIndex];
					const UAnimSequenceBase* AnimReference = Segment.GetAnimReference().Get();
					TSharedPtr<FJsonObject> SegmentJson = MakeShared<FJsonObject>();
					SegmentJson->SetNumberField(TEXT("index"), SegmentIndex);
					SetObjectPathOrNull(SegmentJson, TEXT("anim_reference"), AnimReference);
					if (AnimReference)
					{
						SegmentJson->SetStringField(TEXT("anim_reference_class"), AnimReference->GetClass()->GetPathName());
					}
					else
					{
						SegmentJson->SetField(TEXT("anim_reference_class"), MakeShared<FJsonValueNull>());
					}
					SegmentJson->SetNumberField(TEXT("start_pos_seconds"), Segment.StartPos);
					SegmentJson->SetNumberField(TEXT("end_pos_seconds"), Segment.GetEndPos());
					SegmentJson->SetNumberField(TEXT("length_seconds"), Segment.GetLength());
					SegmentJson->SetNumberField(TEXT("anim_start_time"), Segment.AnimStartTime);
					SegmentJson->SetNumberField(TEXT("anim_end_time"), Segment.AnimEndTime);
					SegmentJson->SetNumberField(TEXT("anim_play_rate"), Segment.AnimPlayRate);
					SegmentJson->SetNumberField(TEXT("looping_count"), Segment.LoopingCount);
					Segments.Add(MakeShared<FJsonValueObject>(SegmentJson));
				}
				SlotJson->SetArrayField(TEXT("segments"), Segments);
				SlotTracks.Add(MakeShared<FJsonValueObject>(SlotJson));
			}
			Result->SetArrayField(TEXT("slot_tracks"), SlotTracks);
			Result->SetArrayField(TEXT("notifies"), SerializeAnimNotifyEvents(Montage->Notifies));
			Result->SetArrayField(TEXT("sync_markers"), SerializeSyncMarkers(Montage->MarkerData.AuthoredSyncMarkers));
			Result->SetArrayField(TEXT("unsupported_runtime_fields"), SerializeRuntimeUnsupportedFields());

			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// 5. get_anim_sequence_info — read a UAnimSequence asset instance
		// ═══════════════════════════════════════════════════════════════════════

		void HandleGetAnimSequenceInfo(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!RequireAssetPath(Params, TEXT("get_anim_sequence_info"), AssetPath, OutResponse))
			{
				return;
			}

			const FString ObjectPath = UEMCP::ToObjectPath(AssetPath);
			UAnimSequence* AnimSeq = LoadObject<UAnimSequence>(nullptr, *ObjectPath);
			if (!AnimSeq)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("UAnimSequence not found at '%s'"), *AssetPath),
					TEXT("ANIM_SEQUENCE_NOT_FOUND"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), AssetPath);
			Result->SetStringField(TEXT("object_path"), AnimSeq->GetPathName());
			Result->SetStringField(TEXT("asset_class"), AnimSeq->GetClass()->GetPathName());
			SetObjectPathOrNull(Result, TEXT("skeleton"), AnimSeq->GetSkeleton());
			Result->SetNumberField(TEXT("duration_seconds"), AnimSeq->GetPlayLength());
			Result->SetNumberField(TEXT("rate_scale"), AnimSeq->RateScale);
			Result->SetBoolField(TEXT("loop"), AnimSeq->bLoop);
			Result->SetNumberField(TEXT("number_of_sampled_keys"), AnimSeq->GetNumberOfSampledKeys());
			Result->SetObjectField(TEXT("sampling_frame_rate"), SerializeFrameRate(AnimSeq->GetSamplingFrameRate()));
			Result->SetNumberField(TEXT("notify_count"), AnimSeq->Notifies.Num());
			Result->SetNumberField(TEXT("sync_marker_count"), AnimSeq->AuthoredSyncMarkers.Num());

			if (const IAnimationDataModel* DataModel = AnimSeq->GetDataModel())
			{
				TSharedPtr<FJsonObject> SourceModel = MakeShared<FJsonObject>();
				SourceModel->SetNumberField(TEXT("duration_seconds"), DataModel->GetPlayLength());
				SourceModel->SetNumberField(TEXT("number_of_frames"), DataModel->GetNumberOfFrames());
				SourceModel->SetNumberField(TEXT("number_of_keys"), DataModel->GetNumberOfKeys());
				SourceModel->SetNumberField(TEXT("bone_track_count"), DataModel->GetNumBoneTracks());
				SourceModel->SetNumberField(TEXT("float_curve_count"), DataModel->GetNumberOfFloatCurves());
				SourceModel->SetNumberField(TEXT("transform_curve_count"), DataModel->GetNumberOfTransformCurves());
				SourceModel->SetObjectField(TEXT("frame_rate"), SerializeFrameRate(DataModel->GetFrameRate()));
				Result->SetObjectField(TEXT("source_model"), SourceModel);

				TArray<TSharedPtr<FJsonValue>> FloatCurves;
				FloatCurves.Reserve(DataModel->GetFloatCurves().Num());
				for (const FFloatCurve& Curve : DataModel->GetFloatCurves())
				{
					TSharedPtr<FJsonObject> CurveJson = MakeShared<FJsonObject>();
					CurveJson->SetStringField(TEXT("name"), Curve.GetName().ToString());
					CurveJson->SetNumberField(TEXT("key_count"), Curve.FloatCurve.GetNumKeys());
					FloatCurves.Add(MakeShared<FJsonValueObject>(CurveJson));
				}
				Result->SetArrayField(TEXT("float_curves"), FloatCurves);

				TArray<TSharedPtr<FJsonValue>> TransformCurves;
				TransformCurves.Reserve(DataModel->GetTransformCurves().Num());
				for (const FTransformCurve& Curve : DataModel->GetTransformCurves())
				{
					TSharedPtr<FJsonObject> CurveJson = MakeShared<FJsonObject>();
					CurveJson->SetStringField(TEXT("name"), Curve.GetName().ToString());
					TransformCurves.Add(MakeShared<FJsonValueObject>(CurveJson));
				}
				Result->SetArrayField(TEXT("transform_curves"), TransformCurves);
			}
			else
			{
				Result->SetField(TEXT("source_model"), MakeShared<FJsonValueNull>());
				Result->SetArrayField(TEXT("float_curves"), TArray<TSharedPtr<FJsonValue>>());
				Result->SetArrayField(TEXT("transform_curves"), TArray<TSharedPtr<FJsonValue>>());
			}

			Result->SetArrayField(TEXT("notifies"), SerializeAnimNotifyEvents(AnimSeq->Notifies));
			Result->SetArrayField(TEXT("sync_markers"), SerializeSyncMarkers(AnimSeq->AuthoredSyncMarkers));
			Result->SetArrayField(TEXT("unsupported_runtime_fields"), SerializeRuntimeUnsupportedFields());

			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterAnimationHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("create_montage"),      &HandleCreateMontage);
		Registry.Register(TEXT("add_montage_section"), &HandleAddMontageSection);
		Registry.Register(TEXT("add_montage_notify"),  &HandleAddMontageNotify);
		Registry.Register(TEXT("get_montage_full"),    &HandleGetMontageFull);
		Registry.Register(TEXT("get_anim_sequence_info"), &HandleGetAnimSequenceInfo);
		// get_audio_asset_info: SUPERSEDED-as-offline per D101 (v) decision.
		// yaml entry says `displaced_by: read_asset_properties` — D50 tagged-fallback
		// covers SoundCue/SoundWave CDO metadata via FPropertyTag iteration. Wwise
		// AkAudioEvent reflection requires the SDK and is unreachable from both
		// reflection_walk and offline parsers, so a live-editor handler would not
		// extend coverage. yaml entry kept as discovery breadcrumb; no live route.
	}
}
