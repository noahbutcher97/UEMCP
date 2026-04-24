// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Templates/Function.h"

/**
 * Game-thread marshaling for the TCP:55558 dispatch path.
 *
 * `FMCPServerRunnable` runs on a dedicated socket thread (FRunnable). Every
 * registered handler is invoked from that thread via `FMCPCommandRegistry::Dispatch`.
 * Most handlers touch APIs that are documented or known game-thread-only:
 *   - `GEditor->*`            (PIE start/stop, viewport, selection)
 *   - `UObject` reflection    (TFieldIterator, GeneratedClass walks)
 *   - `LoadObject<>` / `LoadClass<>`
 *   - `FKismetEditorUtilities::CompileBlueprint`
 *   - `ThumbnailTools::RenderThumbnail`
 *   - `TObjectIterator<>`
 * Calling these off the game thread risks torn reads, races against the editor
 * tick, and crashes inside Kismet's compiler. Audit F-1 (D79) flagged this as
 * the single highest-severity systemic finding pre-Wave-4.
 *
 * This helper centralizes the AsyncTask + TPromise pattern so the migration is
 * a single change at the dispatch site rather than 17 per-handler edits.
 */
namespace UEMCP
{
	/**
	 * Run `Work` on the game thread and block the caller until it returns
	 * (or the timeout elapses).
	 *
	 * - If already on the game thread, runs `Work` inline (no AsyncTask hop) —
	 *   prevents self-deadlock if a handler ever ends up dispatched from GT.
	 * - On non-GT callers, queues `Work` to `ENamedThreads::GameThread` and
	 *   blocks via `TFuture::WaitFor`. Returns true when `Work` completed,
	 *   false on timeout.
	 * - The internal promise is shared (TSharedPtr); on timeout the caller
	 *   moves on but the queued task can still complete safely without
	 *   touching freed state.
	 *
	 * `OutWallClockSeconds`, when non-null, receives the wall-clock time
	 * `Work` spent executing on the game thread (excludes queue wait).
	 * Used by Dispatch to log hitch candidates per handoff §6.
	 */
	bool RunOnGameThread(
		TFunction<void()> Work,
		double TimeoutSeconds = 30.0,
		double* OutWallClockSeconds = nullptr);
}
