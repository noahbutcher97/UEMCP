// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * D109 — project-layout-aware Blueprint asset-path resolver.
 *
 * Replaces the hardcoded "/Game/Blueprints/<Name>" assumption that broke
 * spawn_blueprint_actor + 15 BP-write tools + 1 widget handler on projects
 * whose Blueprint content tree doesn't sit under /Game/Blueprints/.
 *
 * Resolution chain:
 *   1. Fully-qualified /Game/... path (preferred — unambiguous). Accepts both
 *      package form (/Game/Path/BP_X) and object form (/Game/Path/BP_X.BP_X);
 *      strips the .Asset suffix to obtain the package path.
 *   2. Legacy bare-name probe at /Game/Blueprints/<Name> (back-compat for
 *      Epic-template-derived projects).
 *   3. AssetRegistry fallback by ObjectName, project-wide. Multiple matches
 *      surface as BLUEPRINT_AMBIGUOUS with all candidates listed.
 *
 * Mirrors ActorLookupHelper.h convention: free function in the UEMCP
 * namespace, return-bool with OutPackagePath / OutError / OutErrorCode
 * out-params. Caller emits the typed error response.
 */
namespace UEMCP
{
	/**
	 * Resolve a Blueprint asset by name OR fully-qualified path.
	 *
	 * @param Input          Either a bare asset name ("BP_Player") or a
	 *                       fully-qualified /Game/... path.
	 * @param OutPackagePath Set to the resolved package path on success.
	 * @param OutError       Human-readable failure description (caller emits).
	 * @param OutErrorCode   Typed error code (BLUEPRINT_NOT_FOUND or
	 *                       BLUEPRINT_AMBIGUOUS) for caller's error envelope.
	 * @return true on success, false otherwise.
	 */
	bool ResolveBlueprintAssetPath(
		const FString& Input,
		FString& OutPackagePath,
		FString& OutError,
		FString& OutErrorCode);
}
