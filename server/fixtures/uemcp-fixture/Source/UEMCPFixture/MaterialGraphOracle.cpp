#include "MaterialGraphOracle.h"
#include "Materials/Material.h"
#include "Materials/MaterialFunction.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionFunctionInput.h"
#include "Materials/MaterialExpressionFunctionOutput.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"

bool VerifyMaterialGraphFixture()
{
	UMaterialFunction* Scale = LoadObject<UMaterialFunction>(nullptr, TEXT("/Game/MaterialGraphVerification/MF_Scale.MF_Scale"));
	UMaterialFunction* Nested = LoadObject<UMaterialFunction>(nullptr, TEXT("/Game/MaterialGraphVerification/MF_Nested.MF_Nested"));
	UMaterial* Consumer = LoadObject<UMaterial>(nullptr, TEXT("/Game/MaterialGraphVerification/M_Consumer.M_Consumer"));
	if (!Scale || !Nested || !Consumer || Scale->GetExpressions().Num() != 3 || Nested->GetExpressions().Num() != 3 || Consumer->GetExpressions().Num() != 1) return false;
	UMaterialExpressionFunctionInput* Input = nullptr;
	UMaterialExpressionFunctionOutput* Output = nullptr;
	UMaterialExpressionMultiply* Multiply = nullptr;
	for (UMaterialExpression* E : Scale->GetExpressions())
	{
		if (!E || E->Function != Scale || E->GetOuter() != Scale || !E->MaterialExpressionGuid.IsValid()) return false;
		if (auto* I = Cast<UMaterialExpressionFunctionInput>(E)) Input = I;
		if (auto* O = Cast<UMaterialExpressionFunctionOutput>(E)) Output = O;
		if (auto* M = Cast<UMaterialExpressionMultiply>(E)) Multiply = M;
	}
	if (!Input || !Output || !Multiply || Input->InputName != TEXT("Value") || Input->InputType != FunctionInput_Scalar || !Input->Id.IsValid()
		|| Output->OutputName != TEXT("Result") || !Output->Id.IsValid() || Multiply->A.Expression != Input || Multiply->B.Expression || Multiply->ConstB != 2 || Output->A.Expression != Multiply) return false;
	UMaterialExpressionMaterialFunctionCall* Call = nullptr;
	UMaterialExpressionConstant* Constant = nullptr;
	Output = nullptr;
	for (UMaterialExpression* E : Nested->GetExpressions())
	{
		if (!E || E->Function != Nested || E->GetOuter() != Nested) return false;
		if (auto* C = Cast<UMaterialExpressionMaterialFunctionCall>(E)) Call = C;
		if (auto* C = Cast<UMaterialExpressionConstant>(E)) Constant = C;
		if (auto* O = Cast<UMaterialExpressionFunctionOutput>(E)) Output = O;
	}
	if (!Call || !Constant || !Output || Constant->R != .25f || Call->MaterialFunction != Scale || Call->FunctionInputs.Num() != 1
		|| Call->FunctionInputs[0].Input.Expression != Constant || Output->A.Expression != Call) return false;
	Call = Cast<UMaterialExpressionMaterialFunctionCall>(Consumer->GetExpressions()[0]);
	return Call && Call->MaterialFunction == Nested && Consumer->GetEditorOnlyData()->EmissiveColor.Expression == Call;
}
