// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

namespace UEMCP
{
	/** Normal game viewport screenshots are opaque; framebuffer alpha may be unused. */
	inline void MakePieViewportPixelsOpaque(TArray<FColor>& Pixels)
	{
		for (FColor& Pixel : Pixels)
		{
			Pixel.A = 255;
		}
	}
}
