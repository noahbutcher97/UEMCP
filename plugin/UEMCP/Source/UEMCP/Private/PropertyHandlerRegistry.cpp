// Copyright Optimum Athena. All Rights Reserved.
#include "PropertyHandlerRegistry.h"
#include "UObject/UnrealType.h"

namespace UEMCP
{
	FPropertyHandlerRegistry& FPropertyHandlerRegistry::Get()
	{
		static FPropertyHandlerRegistry Instance;
		return Instance;
	}

	FPropertyHandlerRegistry::FPropertyHandlerRegistry()
	{
		RegisterDefaultHandlers();
	}

	void FPropertyHandlerRegistry::Register(const FName& PropertyClassName, FPropertyHandler Handler)
	{
		Handlers.Add(PropertyClassName, MoveTemp(Handler));
	}

	bool FPropertyHandlerRegistry::HasHandler(const FName& PropertyClassName) const
	{
		return Handlers.Contains(PropertyClassName);
	}

	bool FPropertyHandlerRegistry::Handle(void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) const
	{
		if (!Container)
		{
			OutError = TEXT("container is null");
			return false;
		}
		if (!Prop)
		{
			OutError = TEXT("property is null");
			return false;
		}
		if (!Value.IsValid())
		{
			OutError = TEXT("value is null");
			return false;
		}

		const FName ClassName = Prop->GetClass()->GetFName();
		const FPropertyHandler* Handler = Handlers.Find(ClassName);
		if (!Handler)
		{
			OutError = FString::Printf(TEXT("no handler registered for property type '%s'"), *ClassName.ToString());
			return false;
		}
		return (*Handler)(Container, Prop, Value, OutError);
	}

	void FPropertyHandlerRegistry::RegisterDefaultHandlers()
	{
		// --- Scalar handlers ---

		Handlers.Add(FName(TEXT("IntProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				double Num = 0.0;
				if (!Value->TryGetNumber(Num))
				{
					OutError = TEXT("expected number for IntProperty");
					return false;
				}
				FIntProperty* IntProp = CastField<FIntProperty>(Prop);
				if (!IntProp)
				{
					OutError = TEXT("property class mismatch (expected FIntProperty)");
					return false;
				}
				IntProp->SetPropertyValue_InContainer(Container, static_cast<int32>(Num));
				return true;
			});

		Handlers.Add(FName(TEXT("FloatProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				double Num = 0.0;
				if (!Value->TryGetNumber(Num))
				{
					OutError = TEXT("expected number for FloatProperty");
					return false;
				}
				FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop);
				if (!FloatProp)
				{
					OutError = TEXT("property class mismatch (expected FFloatProperty)");
					return false;
				}
				FloatProp->SetPropertyValue_InContainer(Container, static_cast<float>(Num));
				return true;
			});

		Handlers.Add(FName(TEXT("DoubleProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				double Num = 0.0;
				if (!Value->TryGetNumber(Num))
				{
					OutError = TEXT("expected number for DoubleProperty");
					return false;
				}
				FDoubleProperty* DblProp = CastField<FDoubleProperty>(Prop);
				if (!DblProp)
				{
					OutError = TEXT("property class mismatch (expected FDoubleProperty)");
					return false;
				}
				DblProp->SetPropertyValue_InContainer(Container, Num);
				return true;
			});

		Handlers.Add(FName(TEXT("BoolProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				bool B = false;
				if (!Value->TryGetBool(B))
				{
					OutError = TEXT("expected bool for BoolProperty");
					return false;
				}
				FBoolProperty* BoolProp = CastField<FBoolProperty>(Prop);
				if (!BoolProp)
				{
					OutError = TEXT("property class mismatch (expected FBoolProperty)");
					return false;
				}
				BoolProp->SetPropertyValue_InContainer(Container, B);
				return true;
			});

		Handlers.Add(FName(TEXT("StrProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				FString S;
				if (!Value->TryGetString(S))
				{
					OutError = TEXT("expected string for StrProperty");
					return false;
				}
				FStrProperty* StrProp = CastField<FStrProperty>(Prop);
				if (!StrProp)
				{
					OutError = TEXT("property class mismatch (expected FStrProperty)");
					return false;
				}
				StrProp->SetPropertyValue_InContainer(Container, S);
				return true;
			});

		Handlers.Add(FName(TEXT("NameProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				FString S;
				if (!Value->TryGetString(S))
				{
					OutError = TEXT("expected string for NameProperty");
					return false;
				}
				FNameProperty* NameProp = CastField<FNameProperty>(Prop);
				if (!NameProp)
				{
					OutError = TEXT("property class mismatch (expected FNameProperty)");
					return false;
				}
				NameProp->SetPropertyValue_InContainer(Container, FName(*S));
				return true;
			});

		// Struct / vector / object / array handlers intentionally omitted — M3+ adds per-command.
	}
}
