// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "UObject/UnrealType.h"
#include "Dom/JsonValue.h"

/**
 * P0-4: Property-type handler registry for FProperty dispatch.
 *
 * Default handlers (registered at construction): IntProperty, FloatProperty, DoubleProperty,
 * BoolProperty, StrProperty, NameProperty (scalars) plus ByteProperty + EnumProperty with
 * oracle-parity enum-name resolution (numeric-string fast path, "Namespace::Value" splitting,
 * UEnum::GetValueByNameString lookup with raw-string fallback).
 *
 * Production callers (post W-E adoption, 2026-05-03):
 *   - ActorHandlers.cpp::SetActorPropertyValue  → set_actor_property / set_component_property
 *   - BlueprintHandlers.cpp::SetUProperty       → set_blueprint_property / set_default_value
 * Both wrappers resolve the property by name and delegate type dispatch to Registry.Handle.
 * Adopting the registry eliminated ~200 lines of duplicated switch-on-FProperty-class logic
 * and unblocked bUseUnity = true (UEMCP.Build.cs).
 *
 * Registration uses the REGISTER_PROPERTY_HANDLER macro; call it from RegisterDefaultHandlers()
 * (invoked once at module startup) for built-ins and from per-command code for extensions
 * (e.g., struct/vector/object handlers that future workers add).
 *
 * See docs/specs/phase3-plugin-design-inputs.md P0-4.
 */
namespace UEMCP
{
	/**
	 * Handler signature. Container is the UObject/struct that owns the property; the handler is
	 * responsible for calling Prop->SetPropertyValue_InContainer(Container, ...) with a coerced value.
	 * Return false with OutError filled on any malformed input.
	 */
	using FPropertyHandler = TFunction<bool(void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError)>;

	class FPropertyHandlerRegistry
	{
	public:
		static FPropertyHandlerRegistry& Get();

		void Register(const FName& PropertyClassName, FPropertyHandler Handler);

		/**
		 * Dispatch by Prop->GetClass()->GetFName(). If no handler is registered for the property
		 * type, returns false with a diagnostic — NOT an engine crash.
		 */
		bool Handle(void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) const;

		/** True if a handler is registered for the given property class. */
		bool HasHandler(const FName& PropertyClassName) const;

	private:
		FPropertyHandlerRegistry();
		void RegisterDefaultHandlers();

		TMap<FName, FPropertyHandler> Handlers;
	};
}

/**
 * Usage:
 *   REGISTER_PROPERTY_HANDLER("IntProperty", [](void* C, FProperty* P, const TSharedPtr<FJsonValue>& V, FString& E) { ... });
 */
#define REGISTER_PROPERTY_HANDLER(PropClassName, HandlerFn) \
	UEMCP::FPropertyHandlerRegistry::Get().Register(FName(TEXT(PropClassName)), HandlerFn)
