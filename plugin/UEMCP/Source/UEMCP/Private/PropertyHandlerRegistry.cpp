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

		// --- Enum-bearing handlers (W-E adoption, ported from SetActorPropertyValue / SetUProperty) ---
		//
		// Both ByteProperty (legacy TEnumAsByte<E>) and EnumProperty (modern enum class)
		// accept either an integer JSON value or a string name. String-name resolution is
		// oracle-parity: numeric-string fast path ("2" → 2), "Namespace::Value" splitting,
		// then UEnum::GetValueByNameString on the post-split tail, with a final fallback
		// to the raw original string. INDEX_NONE on miss → typed error.

		Handlers.Add(FName(TEXT("ByteProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				FByteProperty* ByteProp = CastField<FByteProperty>(Prop);
				if (!ByteProp)
				{
					OutError = TEXT("property class mismatch (expected FByteProperty)");
					return false;
				}
				void* Addr = Prop->ContainerPtrToValuePtr<void>(Container);
				UEnum* EnumDef = ByteProp->GetIntPropertyEnum();
				if (EnumDef && Value.IsValid() && Value->Type == EJson::String)
				{
					FString EnumName = Value->AsString();
					if (EnumName.IsNumeric())
					{
						ByteProp->SetPropertyValue(Addr, static_cast<uint8>(FCString::Atoi(*EnumName)));
						return true;
					}
					if (EnumName.Contains(TEXT("::")))
					{
						EnumName.Split(TEXT("::"), nullptr, &EnumName);
					}
					int64 EnumValue = EnumDef->GetValueByNameString(EnumName);
					if (EnumValue == INDEX_NONE)
					{
						EnumValue = EnumDef->GetValueByNameString(Value->AsString());
					}
					if (EnumValue == INDEX_NONE)
					{
						OutError = FString::Printf(TEXT("Could not find enum value for '%s'"), *Value->AsString());
						return false;
					}
					ByteProp->SetPropertyValue(Addr, static_cast<uint8>(EnumValue));
					return true;
				}
				double Num = 0.0;
				if (!Value->TryGetNumber(Num))
				{
					OutError = TEXT("expected number or enum string for ByteProperty");
					return false;
				}
				ByteProp->SetPropertyValue(Addr, static_cast<uint8>(Num));
				return true;
			});

		Handlers.Add(FName(TEXT("EnumProperty")),
			[](void* Container, FProperty* Prop, const TSharedPtr<FJsonValue>& Value, FString& OutError) -> bool
			{
				FEnumProperty* EnumProp = CastField<FEnumProperty>(Prop);
				if (!EnumProp)
				{
					OutError = TEXT("property class mismatch (expected FEnumProperty)");
					return false;
				}
				UEnum* EnumDef = EnumProp->GetEnum();
				FNumericProperty* Underlying = EnumProp->GetUnderlyingProperty();
				if (!EnumDef || !Underlying)
				{
					OutError = TEXT("FEnumProperty missing enum definition");
					return false;
				}
				void* Addr = Prop->ContainerPtrToValuePtr<void>(Container);
				if (Value.IsValid() && Value->Type == EJson::String)
				{
					FString EnumName = Value->AsString();
					if (EnumName.IsNumeric())
					{
						Underlying->SetIntPropertyValue(Addr, static_cast<int64>(FCString::Atoi(*EnumName)));
						return true;
					}
					if (EnumName.Contains(TEXT("::")))
					{
						EnumName.Split(TEXT("::"), nullptr, &EnumName);
					}
					int64 EnumValue = EnumDef->GetValueByNameString(EnumName);
					if (EnumValue == INDEX_NONE)
					{
						EnumValue = EnumDef->GetValueByNameString(Value->AsString());
					}
					if (EnumValue == INDEX_NONE)
					{
						OutError = FString::Printf(TEXT("Could not find enum value for '%s'"), *Value->AsString());
						return false;
					}
					Underlying->SetIntPropertyValue(Addr, EnumValue);
					return true;
				}
				double Num = 0.0;
				if (!Value->TryGetNumber(Num))
				{
					OutError = TEXT("expected number or enum string for EnumProperty");
					return false;
				}
				Underlying->SetIntPropertyValue(Addr, static_cast<int64>(Num));
				return true;
			});

		// Struct / vector / object / array handlers intentionally omitted — per-command scope.
	}
}
