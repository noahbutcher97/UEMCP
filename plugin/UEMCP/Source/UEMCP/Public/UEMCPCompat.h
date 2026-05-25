// Copyright Optimum Athena. All Rights Reserved.
#pragma once

// =============================================================================
// UEMCPCompat.h — the single home for engine-version divergence.
//
// RULE: no raw `UE_VERSION_OLDER_THAN(...)` or `#if ENGINE_*_VERSION` anywhere
// else in the plugin. When an API, include path, or behavior differs across
// the supported engine versions, express the divergence HERE and have the
// call site use the alias/macro this header exposes. Centralizing keeps the
// version surface auditable (one file to review per new engine release) and
// prevents `#if` drift across the codebase.
//
// Two flavors of helper live here:
//   1. Semantic version gates  — readable wrappers over UE_VERSION_OLDER_THAN.
//   2. Relocated-header macros  — name a header whose include PATH moved between
//      versions, so the divergent header is included only at the call site
//      (not pulled transitively into everything that includes this file).
//
// History: D167 (UE 5.3 backport — UserDefinedStruct relocation), D169
// (Fab multi-version readiness), D170 (this header established).
// =============================================================================

#include "Misc/EngineVersionComparison.h"

// --- 1. Semantic version gates ------------------------------------------------
// Add gates as real divergences appear (YAGNI — don't pre-declare unused ones).
#define UEMCP_UE_5_5_OR_LATER (!UE_VERSION_OLDER_THAN(5, 5, 0))

// --- 2. Relocated-header macros ----------------------------------------------
// UUserDefinedStruct: exposed via the Engine module (`Engine/UserDefinedStruct.h`)
// on 5.3/5.4; relocated to CoreUObject StructUtils (`StructUtils/UserDefinedStruct.h`)
// in 5.5+. Both modules are already plugin deps, so this is include-path-only.
// Use at the call site as:  #include UEMCP_USERDEFINEDSTRUCT_HEADER
#if UEMCP_UE_5_5_OR_LATER
	#define UEMCP_USERDEFINEDSTRUCT_HEADER "StructUtils/UserDefinedStruct.h"
#else
	#define UEMCP_USERDEFINEDSTRUCT_HEADER "Engine/UserDefinedStruct.h"
#endif
