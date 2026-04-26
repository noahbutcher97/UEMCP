// Copyright Optimum Athena. All Rights Reserved.
#include "InputAndPieHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

namespace UEMCP
{
	void RegisterInputAndPieHandlers(FMCPCommandRegistry& Registry)
	{
		// Stubs — M5-input+geometry sub-worker fills these in. Enhanced Input asset
		// creation only — PIE control (start_pie / stop_pie / is_pie_running /
		// execute_console_command) is ALREADY shipped in EdgeCaseHandlers.cpp under
		// M-enhance D77; do NOT add PIE handlers here, that would double-register
		// the same wire-type and conflict at startup.
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

		Registry.Register(TEXT("create_input_action"),    NotImplemented(TEXT("create_input_action")));
		Registry.Register(TEXT("create_mapping_context"), NotImplemented(TEXT("create_mapping_context")));
		Registry.Register(TEXT("add_mapping"),            NotImplemented(TEXT("add_mapping")));
	}
}
