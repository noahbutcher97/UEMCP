// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "UObject/UnrealType.h"
#include "Dom/JsonValue.h"

/**
 * P0-4: Property-type handler registry for set_actor_property / set_component_property.
 *
 * M1 ships the registry infrastructure + scalar handlers (int, float, double, bool, string, name).
 * Struct / vector / object / array handlers are M3+ per-command scope.
 *
 * Registration uses the REGISTER_PROPERTY_HANDLER macro; call it from RegisterDefaultHandlers()
 * (invoked once at module startup) for built-ins and from M3+ command registration for extensions.
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
