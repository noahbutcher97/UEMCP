// Copyright Optimum Athena. All Rights Reserved.
#include "GeometryHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

namespace UEMCP
{
	void RegisterGeometryHandlers(FMCPCommandRegistry& Registry)
	{
		// Stubs — M5-input+geometry sub-worker fills these in. Geometry Script plugin
		// is REQUIRED per tools.yaml note; sub-worker must either gate handlers on
		// IPluginManager::FindPlugin("GeometryScript")->IsEnabled() OR return a typed
		// PLUGIN_DISABLED error envelope (per D101 (iii) verifier open question).
		//
		// To find every stub to replace: grep this file for `NotImplemented(TEXT(`.
		auto NotImplemented = [](const TCHAR* ToolName)
		{
			return [ToolName](const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("M5 tool '%s' not yet shipped (stub from M5-PREP)"), ToolName),
					TEXT("not_implemented"));
			};
		};

		Registry.Register(TEXT("create_procedural_mesh"), NotImplemented(TEXT("create_procedural_mesh")));
		Registry.Register(TEXT("mesh_boolean"),           NotImplemented(TEXT("mesh_boolean")));
		Registry.Register(TEXT("generate_uvs"),           NotImplemented(TEXT("generate_uvs")));
	}
}
