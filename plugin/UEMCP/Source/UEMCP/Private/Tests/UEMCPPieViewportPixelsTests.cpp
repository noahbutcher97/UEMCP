// Copyright Noah Butcher. All Rights Reserved.
// Pure pixel test: no editor, renderer, viewport, or filesystem required.
#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"
#include "PieViewportPixels.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEMCPPieViewportOpaquePixelsTest,
	"UEMCP.Capture.PieViewportOpaquePixels",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPPieViewportOpaquePixelsTest::RunTest(const FString& Parameters)
{
	TArray<FColor> Pixels;
	Pixels.Add(FColor(17, 34, 51, 0));
	Pixels.Add(FColor(200, 100, 50, 1));
	Pixels.Add(FColor(0, 255, 128, 127));
	Pixels.Add(FColor(255, 0, 1, 255));
	const TArray<FColor> Before = Pixels;
	UEMCP::MakePieViewportPixelsOpaque(Pixels);
	TestEqual(TEXT("Pixel count is unchanged"), Pixels.Num(), Before.Num());
	for (int32 Index = 0; Index < Pixels.Num(); ++Index)
	{
		const FString Label = FString::Printf(TEXT("Pixel %d"), Index);
		TestEqual(Label + TEXT(" preserves red"), Pixels[Index].R, Before[Index].R);
		TestEqual(Label + TEXT(" preserves green"), Pixels[Index].G, Before[Index].G);
		TestEqual(Label + TEXT(" preserves blue"), Pixels[Index].B, Before[Index].B);
		TestEqual(Label + TEXT(" is opaque"), Pixels[Index].A, static_cast<uint8>(255));
	}
	const TArray<FColor> Once = Pixels;
	UEMCP::MakePieViewportPixelsOpaque(Pixels);
	TestTrue(TEXT("Normalizing opaque pixels is idempotent"), Pixels == Once);
	TArray<FColor> Empty;
	UEMCP::MakePieViewportPixelsOpaque(Empty);
	TestEqual(TEXT("Empty input stays empty"), Empty.Num(), 0);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
