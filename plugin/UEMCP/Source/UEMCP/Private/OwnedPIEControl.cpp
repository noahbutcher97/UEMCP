// Copyright Noah Butcher. All Rights Reserved.
#include "OwnedPIEControl.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "HAL/PlatformProcess.h"
#include "Misc/CommandLine.h"
#include "Misc/Guid.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "PlayInEditorDataTypes.h"
#include "Runtime/Launch/Resources/Version.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

namespace UEMCP
{
	namespace
	{
		constexpr const TCHAR* OwnedMap = TEXT("/Game/OwnedPIE/Lifecycle");
		constexpr const TCHAR* OwnedActor = TEXT("OwnedLifecycleActor");
		constexpr const TCHAR* MissingActor = TEXT("DefinitelyAbsentOwnedProbe");
		struct FOwnedState
		{
			FCriticalSection Mutex;
			bool bEnabled = false, bValidNonce = false, bSealed = false, bVerified = false, bShuttingDown = false;
			FString Nonce;
			uint64 Accepted = 0, Completed = 0;
			TSet<uint64> Outstanding;
			uint64 Tick = 0, SealTick = 0, ReconcileTick = 0, FirstZeroTick = 0, DrainedTick = 0;
			bool bReconcileRequested = false;
			// Delegate/UObject state is GameThread-only; counters above are mutex-protected.
			FDelegateHandle TickHandle;
			TWeakObjectPtr<UEngine> TickEngine;
			FOwnedState()
			{
				FString Raw;
				bEnabled = FParse::Value(FCommandLine::Get(), TEXT("UEMCPOwnedPIE="), Raw)
					|| FParse::Param(FCommandLine::Get(), TEXT("UEMCPOwnedPIE"));
				FGuid Guid;
				bValidNonce = FGuid::ParseExact(Raw, EGuidFormats::DigitsWithHyphens, Guid) && Guid.IsValid();
				if (bValidNonce) Nonce = Raw; // Echo the exact supervisor-supplied canonical GUID spelling.
			}
		};
		FOwnedState& State() { static FOwnedState Value; return Value; }
		bool Fail(TSharedPtr<FJsonObject>& Out, const TCHAR* Code, const TCHAR* Message)
		{
			BuildErrorResponse(Out, Message, Code); return false;
		}
		bool IsLifecycle(const FString& Command)
		{
			return Command == TEXT("start_pie") || Command == TEXT("stop_pie")
				|| Command == TEXT("get_pie_session_state") || Command == TEXT("get_pie_actor_state");
		}
		bool IsControl(const FString& Command)
		{
			return Command == TEXT("owned_pie_verify") || Command == TEXT("owned_pie_fence")
				|| Command == TEXT("owned_pie_reconcile");
		}
		bool CheckNonce(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Out)
		{
			FString Received;
			if (!State().bValidNonce || !Params || !Params->TryGetStringField(TEXT("owned_pie_nonce"), Received)
				|| Received != State().Nonce)
				return Fail(Out, TEXT("OWNED_PIE_NONCE"), TEXT("Owned PIE nonce is missing or incorrect"));
			return true;
		}
		FString ProjectPath()
		{
			FString Path = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
			FPaths::NormalizeFilename(Path); FPaths::CollapseRelativeDirectories(Path); return Path;
		}
		bool OwnedWorld(UWorld*& World, TSharedPtr<FJsonObject>& Out)
		{
			check(IsInGameThread());
			{
				FScopeLock Lock(&State().Mutex);
				if (State().bShuttingDown) return Fail(Out, TEXT("OWNED_PIE_SHUTDOWN"), TEXT("Owned control is shutting down"));
			}
			if (!GEditor || !GEngine || IsRunningCommandlet()
				|| FPaths::GetCleanFilename(ProjectPath()) != TEXT("UEMCPFixture.uproject"))
				return Fail(Out, TEXT("OWNED_PIE_HOST"), TEXT("Owned control requires the disposable UEMCPFixture editor"));
			World = GEditor->GetEditorWorldContext().World();
			if (!World || World->WorldType != EWorldType::Editor || World->GetPackage()->GetName() != OwnedMap
				|| World->GetStreamingLevels().Num() != 0)
				return Fail(Out, TEXT("OWNED_PIE_MAP"), TEXT("The exact owned saved map must already be loaded without streaming levels"));
			return true;
		}
		struct FEngineFlags
		{
			bool bQueuedStart = false, bSession = false, bWorld = false, bQueuedEnd = false, bSimulating = false;
			int32 Contexts = 0;
			bool IsZero() const { return !bQueuedStart && !bSession && !bWorld && !bQueuedEnd && !bSimulating && Contexts == 0; }
		};
		FEngineFlags ReadFlags()
		{
			check(IsInGameThread());
			FEngineFlags Flags;
			Flags.bQueuedStart = GEditor->IsPlaySessionRequestQueued();
			Flags.bSession = GEditor->GetPlayInEditorSessionInfo().IsSet();
			Flags.bWorld = GEditor->PlayWorld != nullptr;
			Flags.bQueuedEnd = GEditor->ShouldEndPlayMap();
			Flags.bSimulating = GEditor->IsSimulateInEditorInProgress();
			for (const FWorldContext& Context : GEngine->GetWorldContexts())
				if (Context.WorldType == EWorldType::PIE) ++Flags.Contexts; // Also count contexts with no World yet.
			return Flags;
		}
		void ObservePostEditorTick(float)
		{
			check(IsInGameThread());
			UWorld* World = nullptr; TSharedPtr<FJsonObject> Ignored;
			const bool bZero = OwnedWorld(World, Ignored) && ReadFlags().IsZero();
			FOwnedState& S = State(); FScopeLock Lock(&S.Mutex);
			++S.Tick;
			if (!S.bSealed || !S.bReconcileRequested || S.Outstanding.Num() != 0 || !bZero
				|| S.Tick <= S.SealTick || S.Tick <= S.ReconcileTick)
			{ S.FirstZeroTick = S.DrainedTick = 0; return; }
			// Two actual post-editor ticks, never two polls in one tick.
			if (S.FirstZeroTick == 0) S.FirstZeroTick = S.Tick;
			else if (S.Tick > S.FirstZeroTick) S.DrainedTick = S.Tick;
		}
		void EnsureTickHook()
		{
			check(IsInGameThread()); FOwnedState& S = State();
			if (!S.TickHandle.IsValid())
			{
				S.TickEngine = GEngine;
				S.TickHandle = GEngine->OnPostEditorTick().AddStatic(&ObservePostEditorTick);
			}
		}
		TSharedPtr<FJsonObject> Snapshot(const FEngineFlags& Flags)
		{
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("owned"), true);
			Result->SetStringField(TEXT("nonce"), State().Nonce);
			Result->SetStringField(TEXT("project_path"), ProjectPath());
			Result->SetStringField(TEXT("map_path"), OwnedMap);
			Result->SetNumberField(TEXT("process_id"), FPlatformProcess::GetCurrentProcessId());
			TSharedPtr<FJsonObject> Engine = MakeShared<FJsonObject>();
			Engine->SetBoolField(TEXT("queued_start"), Flags.bQueuedStart);
			Engine->SetBoolField(TEXT("session_active"), Flags.bSession);
			Engine->SetBoolField(TEXT("play_world"), Flags.bWorld);
			Engine->SetNumberField(TEXT("pie_contexts"), Flags.Contexts);
			Engine->SetBoolField(TEXT("queued_end"), Flags.bQueuedEnd);
			Engine->SetBoolField(TEXT("simulating"), Flags.bSimulating);
			Result->SetObjectField(TEXT("flags"), Engine);
			FOwnedState& S = State(); FScopeLock Lock(&S.Mutex);
			TSharedPtr<FJsonObject> Accounting = MakeShared<FJsonObject>();
			Accounting->SetBoolField(TEXT("sealed"), S.bSealed);
			Accounting->SetNumberField(TEXT("accepted"), S.Accepted);
			Accounting->SetNumberField(TEXT("completed"), S.Completed);
			Accounting->SetNumberField(TEXT("outstanding"), S.Outstanding.Num());
			Result->SetObjectField(TEXT("accounting"), Accounting);
			Result->SetNumberField(TEXT("tick"), S.Tick);
			Result->SetNumberField(TEXT("seal_tick"), S.SealTick);
			Result->SetNumberField(TEXT("drained_tick"), S.DrainedTick);
			Result->SetBoolField(TEXT("drained"), S.bSealed && S.bReconcileRequested && S.DrainedTick > S.SealTick
				&& S.DrainedTick > S.ReconcileTick && S.Outstanding.Num() == 0 && S.Accepted == S.Completed && Flags.IsZero());
			return Result;
		}
		TArray<TSharedPtr<FJsonValue>> Vector(const FVector& Value)
		{
			TArray<TSharedPtr<FJsonValue>> Result;
			Result.Add(MakeShared<FJsonValueNumber>(Value.X)); Result.Add(MakeShared<FJsonValueNumber>(Value.Y)); Result.Add(MakeShared<FJsonValueNumber>(Value.Z));
			return Result;
		}
		void Verify(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Out)
		{
			UWorld* World = nullptr; if (!OwnedWorld(World, Out)) return;
			FString Map, Name, Missing;
			if (!Params->TryGetStringField(TEXT("map_path"), Map) || Map != OwnedMap
				|| !Params->TryGetStringField(TEXT("actor_name"), Name) || Name != OwnedActor
				|| !Params->TryGetStringField(TEXT("missing_actor_name"), Missing) || Missing != MissingActor)
			{ Fail(Out, TEXT("OWNED_PIE_ORACLE"), TEXT("Expected the exact owned fixture map and actor identities")); return; }
			const FEngineFlags Flags = ReadFlags();
			{
				FScopeLock Lock(&State().Mutex);
				if (State().bSealed || State().Outstanding.Num() != 0 || State().bVerified || !Flags.IsZero())
				{ Fail(Out, TEXT("OWNED_PIE_NOT_IDLE"), TEXT("Verification is single-use and requires an unsealed stopped empty session")); return; }
			}
			AActor* Actor = nullptr; bool bMissing = true; int32 Matches = 0;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				if (It->GetName() == Name) { Actor = *It; ++Matches; }
				if (It->GetName() == Missing) bMissing = false;
			}
			if (Matches != 1 || !bMissing || Actor->GetClass()->GetPathName() != TEXT("/Script/Engine.StaticMeshActor"))
			{ Fail(Out, TEXT("OWNED_PIE_ORACLE"), TEXT("Owned actor is missing/ambiguous, has wrong class, or absent probe exists")); return; }
			EnsureTickHook();
			{
				FScopeLock Lock(&State().Mutex);
				if (State().bSealed) { Fail(Out, TEXT("OWNED_PIE_SEALED"), TEXT("Owned session was sealed during verification")); return; }
				State().bVerified = true;
			}
			TSharedPtr<FJsonObject> Result = Snapshot(Flags);
			TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
			Observed->SetStringField(TEXT("name"), Actor->GetName());
			Observed->SetStringField(TEXT("class"), Actor->GetClass()->GetPathName());
			Observed->SetArrayField(TEXT("location"), Vector(Actor->GetActorLocation()));
			Observed->SetArrayField(TEXT("scale"), Vector(Actor->GetActorScale3D()));
			TArray<TSharedPtr<FJsonValue>> Rotation; const FRotator R = Actor->GetActorRotation();
			Rotation.Add(MakeShared<FJsonValueNumber>(R.Pitch)); Rotation.Add(MakeShared<FJsonValueNumber>(R.Yaw)); Rotation.Add(MakeShared<FJsonValueNumber>(R.Roll));
			Observed->SetArrayField(TEXT("rotation"), Rotation);
			Observed->SetNumberField(TEXT("InputPriority"), Actor->InputPriority);
			Observed->SetNumberField(TEXT("AutoReceiveInput"), static_cast<uint8>(Actor->AutoReceiveInput.GetValue()));
			Observed->SetBoolField(TEXT("has_input_component"), Actor->InputComponent != nullptr);
			Result->SetObjectField(TEXT("actor"), Observed);
			Result->SetBoolField(TEXT("missing_actor_absent"), bMissing);
			// Enforced start policy, not a claim that a runtime world already exists.
			Result->SetBoolField(TEXT("standalone"), true);
			Result->SetBoolField(TEXT("online_disabled"), true);
			BuildSuccessResponse(Out, Result);
		}
		void Fence(const TSharedPtr<FJsonObject>&, TSharedPtr<FJsonObject>& Out)
		{
			UWorld* World = nullptr; if (!OwnedWorld(World, Out)) return;
			EnsureTickHook(); BuildSuccessResponse(Out, Snapshot(ReadFlags()));
		}
		void Reconcile(const TSharedPtr<FJsonObject>&, TSharedPtr<FJsonObject>& Out)
		{
			UWorld* World = nullptr; if (!OwnedWorld(World, Out)) return;
			EnsureTickHook(); bool bOutstanding;
			{
				FScopeLock Lock(&State().Mutex);
				if (!State().bSealed) { Fail(Out, TEXT("OWNED_PIE_NOT_SEALED"), TEXT("Fence before reconciliation")); return; }
				bOutstanding = State().Outstanding.Num() != 0;
			}
			if (bOutstanding) { BuildSuccessResponse(Out, Snapshot(ReadFlags())); return; }
			FEngineFlags Flags = ReadFlags(); bool bRequestedAction = false;
			// Cancel also resets session info: never call during startup or active play.
			if (Flags.bQueuedStart && !Flags.bSession && !Flags.bWorld && Flags.Contexts == 0)
			{ GEditor->CancelRequestPlaySession(); bRequestedAction = true; }
			else if (Flags.bWorld)
			{
				if (!Flags.bQueuedEnd) { GEditor->RequestEndPlayMap(); bRequestedAction = true; }
			}
			// A session/context without PlayWorld is pending startup, not a failed reconciliation.
			// Leave it untouched and report a non-drained snapshot so bounded polling can continue.
			Flags = ReadFlags();
			{
				FScopeLock Lock(&State().Mutex);
				if (!State().bReconcileRequested || bRequestedAction)
				{
					State().bReconcileRequested = true; State().ReconcileTick = State().Tick;
					State().FirstZeroTick = State().DrainedTick = 0;
				}
			}
			BuildSuccessResponse(Out, Snapshot(Flags));
		}
	}
	bool AdmitOwnedPIECommand(const FString& Command, const TSharedPtr<FJsonObject>& Params,
		FOwnedPIEAdmission& Admission, TSharedPtr<FJsonObject>& Out)
	{
		FOwnedState& S = State(); if (!S.bEnabled) return true;
		if (Command == TEXT("ping")) return true;
		if (!IsLifecycle(Command) && !IsControl(Command))
			return Fail(Out, TEXT("OWNED_PIE_COMMAND"), TEXT("Owned fixture process accepts only PIE qualification commands"));
		if (!CheckNonce(Params, Out)) return false; // Invalid authorization never seals a session.
		if (ENGINE_MAJOR_VERSION != 5 || ENGINE_MINOR_VERSION != 6)
			return Fail(Out, TEXT("OWNED_PIE_ENGINE"), TEXT("Owned control is restricted to the inspected UE5.6 API"));
		FScopeLock Lock(&S.Mutex);
		if (Command == TEXT("owned_pie_fence"))
		{
			if (!S.bSealed) { S.bSealed = true; S.SealTick = S.Tick; }
			return true; // Seal on receipt thread, before GameThread marshal.
		}
		if (!IsLifecycle(Command)) return true;
		if (S.bSealed) return Fail(Out, TEXT("OWNED_PIE_SEALED"), TEXT("Owned admission is permanently sealed"));
		if (!S.bVerified) return Fail(Out, TEXT("OWNED_PIE_UNVERIFIED"), TEXT("Verify before lifecycle commands"));
		Admission.Ticket = ++S.Accepted; S.Outstanding.Add(Admission.Ticket); return true;
	}
	bool BeginOwnedPIECallback(const FOwnedPIEAdmission& Admission, TSharedPtr<FJsonObject>& Out)
	{
		if (Admission.Ticket == 0) return true;
		{
			FScopeLock Lock(&State().Mutex);
			if (State().bSealed) return Fail(Out, TEXT("OWNED_PIE_SEALED"), TEXT("Late owned callback rejected after fence"));
		}
		UWorld* World = nullptr; return OwnedWorld(World, Out);
	}
	void CompleteOwnedPIECallback(const FOwnedPIEAdmission& Admission)
	{
		if (Admission.Ticket == 0) return;
		FScopeLock Lock(&State().Mutex);
		if (State().Outstanding.Remove(Admission.Ticket) == 1) ++State().Completed;
	}
	bool ConfigureOwnedPIEStart(FRequestPlaySessionParams& Request, TSharedPtr<FJsonObject>& Out)
	{
		if (!State().bEnabled) return true;
		if (Request.SessionDestination != EPlaySessionDestinationType::InProcess)
			return Fail(Out, TEXT("OWNED_PIE_MODE"), TEXT("Owned PIE requires an in-process session"));
		// RequestPlaySession duplicates again. Never modify the global CDO settings.
		ULevelEditorPlaySettings* Settings = DuplicateObject<ULevelEditorPlaySettings>(GetDefault<ULevelEditorPlaySettings>(), GetTransientPackage());
		if (!Settings) return Fail(Out, TEXT("OWNED_PIE_SETTINGS"), TEXT("Unable to duplicate play settings"));
		Settings->SetPlayNetMode(EPlayNetMode::PIE_Standalone);
		Settings->SetPlayNumberOfClients(1); Settings->SetRunUnderOneProcess(true);
		Settings->bLaunchSeparateServer = false;
		Request.SessionDestination = EPlaySessionDestinationType::InProcess;
		Request.WorldType = EPlaySessionWorldType::PlayInEditor; Request.GlobalMapOverride = OwnedMap;
		Request.bAllowOnlineSubsystem = false; Request.EditorPlaySettings = Settings;
		return true;
	}
	void RegisterOwnedPIEHandlers(FMCPCommandRegistry& Registry)
	{
		if (!State().bEnabled) return; // Internal controls do not exist on the normal bridge.
		Registry.Register(TEXT("owned_pie_verify"), &Verify);
		Registry.Register(TEXT("owned_pie_fence"), &Fence);
		Registry.Register(TEXT("owned_pie_reconcile"), &Reconcile);
	}
	void ShutdownOwnedPIEControl()
	{
		FOwnedState& S = State(); if (!S.bEnabled) return;
		check(IsInGameThread());
		{ FScopeLock Lock(&S.Mutex); S.bSealed = true; S.bShuttingDown = true; }
		if (UEngine* Engine = S.TickEngine.Get()) Engine->OnPostEditorTick().Remove(S.TickHandle);
		S.TickHandle.Reset(); S.TickEngine.Reset();
	}
}
