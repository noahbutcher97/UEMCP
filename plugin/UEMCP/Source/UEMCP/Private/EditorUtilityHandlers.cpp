// Copyright Optimum Athena. All Rights Reserved.
#include "EditorUtilityHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

namespace UEMCP
{
	void RegisterEditorUtilityHandlers(FMCPCommandRegistry& Registry)
	{
		// Stubs — M5-editor-utility sub-worker fills these in. Highest security
		// review burden of the 5 M5 toolsets:
		//   - run_python_command: D14 deny-list (os, subprocess, eval, exec, open,
		//     __import__) MUST land in the real handler. Per D101 (iv), sub-worker
		//     may also gate on a startup flag (--allow-python-exec) for defense
		//     in depth.
		//   - delete_asset_safe: must call IAssetRegistry::GetReferencers() and
		//     refuse if hard refs exist unless force=true (D14 risk).
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

		Registry.Register(TEXT("run_python_command"),           NotImplemented(TEXT("run_python_command")));
		// get_editor_utility_blueprint: yaml flags "displaced_by: inspect_blueprint,
		// read_asset_properties" — sub-worker may route via existing reflection_walk
		// PARTIAL-RC pattern instead of writing a fresh handler.
		Registry.Register(TEXT("get_editor_utility_blueprint"), NotImplemented(TEXT("get_editor_utility_blueprint")));
		Registry.Register(TEXT("run_editor_utility"),           NotImplemented(TEXT("run_editor_utility")));
		Registry.Register(TEXT("duplicate_asset"),              NotImplemented(TEXT("duplicate_asset")));
		Registry.Register(TEXT("rename_asset"),                 NotImplemented(TEXT("rename_asset")));
		Registry.Register(TEXT("delete_asset_safe"),            NotImplemented(TEXT("delete_asset_safe")));
	}
}
