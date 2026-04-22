// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * bp_compile_and_report — Compile a Blueprint and capture the full
 * FCompilerResultsLog surface (errors + warnings + notes + info with
 * per-entry node_guid / asset_path where available).
 *
 * FA-ε §Q1 + D66: FULL-TCP because the BlueprintEditorLibrary UFUNCTION is
 * void-returning; RC can trigger a compile but cannot report structured
 * diagnostics. Plugin-C++ required regardless of transport.
 *
 * API: FKismetEditorUtilities::CompileBlueprint takes an FCompilerResultsLog*
 *      out-param (KismetEditorUtilities.h signature with the extra arg, not the
 *      BlueprintEditorLibrary UFUNCTION). Handler owns the log lifetime.
 *
 * Response shape (D74 handoff §2.2):
 *   {
 *     "errors":   [{ "message": "...", "severity": "Error",   "node_guid"?: "...", "asset_path"?: "..." }, ...],
 *     "warnings": [...],
 *     "notes":    [...],
 *     "info":     [...]
 *   }
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds compile-diagnostic handlers to the registry. Call pre-thread-create. */
	void RegisterCompileDiagnosticHandlers(FMCPCommandRegistry& Registry);
}
