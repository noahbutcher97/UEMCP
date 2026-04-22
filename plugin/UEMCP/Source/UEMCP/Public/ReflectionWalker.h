// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Full-fidelity reflection walker.
 *
 * Emits UPROPERTY flags + UCLASS flags + UFUNCTION signatures without RC's
 * SanitizeMetadata allowlist filter (D66 / FA-ε §Q2.1). Reads
 * `FProperty::GetMetaDataMap()` directly so Category, Replicated, EditAnywhere,
 * BlueprintReadWrite, SaveGame, Transient, Config, etc. all pass through.
 *
 * Shared helper — consumed by both reflection-only tools (via a dedicated
 * command handler) and hybrid PARTIAL-RC tools (get_blueprint_info /
 * _variables / _components — CP4) that need to augment the RC-subset with
 * the full flag set.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;
	struct FFieldVariant;
}
class UStruct;
class UClass;
class UFunction;
class FProperty;

namespace UEMCP
{
	/**
	 * Serialize a UStruct's field set — all member properties with full metadata.
	 * Works on UClass / UScriptStruct / UUserDefinedStruct.
	 * @returns newly-allocated array of property JSON objects.
	 */
	TArray<TSharedPtr<FJsonValue>> SerializeStructProperties(const UStruct* Struct);

	/**
	 * Serialize a UClass — its UCLASS flags, superclass, implemented interfaces,
	 * full property set, and exposed functions.
	 */
	TSharedPtr<FJsonObject> SerializeClassReflection(const UClass* Class);

	/**
	 * Serialize a UFUNCTION's signature: return type + parameters with flags.
	 * Fully-flagged (BlueprintCallable, BlueprintPure, Exec, Replicated, etc.).
	 */
	TSharedPtr<FJsonObject> SerializeFunctionSignature(const UFunction* Function);

	/**
	 * Serialize one FProperty — name, type string, flag set, metadata map.
	 * Bypasses RC's SanitizeMetadata allowlist.
	 */
	TSharedPtr<FJsonObject> SerializeProperty(const FProperty* Property);

	/** Adds reflection-related command handlers to the registry. */
	void RegisterReflectionHandlers(FMCPCommandRegistry& Registry);
}
