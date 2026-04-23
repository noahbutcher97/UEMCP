// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

class UBlueprint;

/**
 * Narrow-sidecar writer (M-enhance CP5 / D58 re-sequence).
 *
 * Emits plugin-only fields for a UBlueprint to
 *   <project>/Saved/UEMCP/<package>/<asset>.sidecar.json
 *
 * "Narrow" per phase3-resequence-2026-04-20.md §L: contains ONLY the
 * derivatives that offline tooling cannot produce — compile errors,
 * full reflection flag set (beyond RC's SanitizeMetadata allowlist),
 * generated-class info. NOT edge topology (S-B-base offline),
 * NOT positions / contains[] / via_knots (M-spatial offline post-pass).
 *
 * Schema: `narrow-sidecar-v1`. Future versions bump the marker;
 * consumers can key off it.
 *
 * Returns true on successful write, false with OutError populated
 * otherwise. Never throws. Safe to call from game thread only —
 * uses compile + reflection APIs that assume game-thread context.
 */
namespace UEMCP
{
	bool WriteNarrowSidecar(UBlueprint* Blueprint, FString& OutError);

	/** Compute the on-disk sidecar path for a given blueprint. Public for tests / manual regen. */
	FString GetSidecarPathForBlueprint(const UBlueprint* Blueprint);
}
