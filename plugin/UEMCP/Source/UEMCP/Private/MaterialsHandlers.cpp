// Copyright Optimum Athena. All Rights Reserved.
#include "MaterialsHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

namespace UEMCP
{
	void RegisterMaterialsHandlers(FMCPCommandRegistry& Registry)
	{
		// Stubs — M5-animation+materials sub-worker fills these in. To find every
		// stub to replace: grep this file for `NotImplemented(TEXT(`.
		auto NotImplemented = [](const TCHAR* ToolName)
		{
			return [ToolName](const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("M5 tool '%s' not yet shipped (stub from M5-PREP)"), ToolName),
					TEXT("not_implemented"));
			};
		};

		Registry.Register(TEXT("create_material"),          NotImplemented(TEXT("create_material")));
		Registry.Register(TEXT("create_material_instance"), NotImplemented(TEXT("create_material_instance")));
		// set_material_parameter: per D101 (ii), sub-worker may ship this as an RC
		// delegate in rc-tools.mjs (3-line addition) instead of plugin C++. RC API
		// exposes SetScalar/Vector/TextureParameterValue UFUNCTIONs on
		// UMaterialInstanceConstant — same pattern as list_material_parameters.
		// If shipped RC-only, drop this Register call.
		Registry.Register(TEXT("set_material_parameter"),   NotImplemented(TEXT("set_material_parameter")));
	}
}
