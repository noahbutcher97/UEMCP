// Copyright Noah Butcher. All Rights Reserved.
#include "MCPThreadMarshal.h"

#include "Async/Future.h"
#include "Containers/Ticker.h"
#include "HAL/PlatformTime.h"
#include "Misc/Timespan.h"

namespace UEMCP
{
	bool RunOnGameThread(TFunction<void()> Work, double TimeoutSeconds, double* OutWallClockSeconds)
	{
		// In-thread fast path. Avoids self-deadlock if Dispatch ever fires from GT
		// (commandlet test, console-command bridge, future in-process caller).
		if (IsInGameThread())
		{
			const double Start = FPlatformTime::Seconds();
			Work();
			if (OutWallClockSeconds)
			{
				*OutWallClockSeconds = FPlatformTime::Seconds() - Start;
			}
			return true;
		}

		// TPromise is move-only; share through TSharedRef so the queued task can
		// safely outlive an early return on the calling thread (timeout path).
		TSharedRef<TPromise<double>, ESPMode::ThreadSafe> PromisePtr =
			MakeShared<TPromise<double>, ESPMode::ThreadSafe>();
		TFuture<double> Future = PromisePtr->GetFuture();

		// Use the editor's frame context, not the socket worker's inherited
		// TaskGraph context. UE 5.8 render tasks require a valid FAppTime context.
		ExecuteOnGameThread(TEXT("UEMCPDispatch"), [PromisePtr, Work = MoveTemp(Work)]()
		{
			const double Start = FPlatformTime::Seconds();
			Work();
			PromisePtr->SetValue(FPlatformTime::Seconds() - Start);
		});

		const FTimespan Timeout = FTimespan::FromSeconds(TimeoutSeconds);
		if (!Future.WaitFor(Timeout))
		{
			// Caller observes timeout; queued task may still run later (and will
			// publish to the promise harmlessly — no consumer left).
			return false;
		}

		if (OutWallClockSeconds)
		{
			*OutWallClockSeconds = Future.Get();
		}
		return true;
	}
}
