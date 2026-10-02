#include "AuthorSerializationFixtureCommandlet.h"
#if WITH_EDITOR
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "EdGraph/EdGraph.h"
#include "EdGraphSchema_K2.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_CallFunction.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#endif

UAuthorSerializationFixtureCommandlet::UAuthorSerializationFixtureCommandlet()
{
	IsEditor = true;
	IsClient = false;
	IsServer = false;
	LogToConsole = true;
}

int32 UAuthorSerializationFixtureCommandlet::Main(const FString& Params)
{
#if WITH_EDITOR
	// Always author into the invocation-owned host. Never load or overwrite input assets.
	const FString PackageName = TEXT("/Game/Serialization/BP_OwnedLink");
	const FString Filename = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
	if (IFileManager::Get().FileExists(*Filename)) return 2;
	UPackage* Package = CreatePackage(*PackageName);
	UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(UObject::StaticClass(), Package,
		TEXT("BP_OwnedLink"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
	if (!BP) return 3;
	// CreateBlueprint supplies an empty EventGraph. Keep the authored package's
	// complete graph set explicit so the independent oracle compares exactly.
	const auto InitialGraphs = BP->UbergraphPages;
	for (UEdGraph* InitialGraph : InitialGraphs)
	{
		if (!InitialGraph || InitialGraph->Nodes.Num() != 0) return 7;
		FBlueprintEditorUtils::RemoveGraph(BP, InitialGraph);
	}
	UEdGraph* Graph = FBlueprintEditorUtils::CreateNewGraph(BP, TEXT("OwnedGraph"), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
	FBlueprintEditorUtils::AddUbergraphPage(BP, Graph);
	UK2Node_CustomEvent* Event = NewObject<UK2Node_CustomEvent>(Graph, TEXT("OwnedEvent"));
	Event->CustomFunctionName = TEXT("OwnedSignal");
	Graph->AddNode(Event);
	Event->AllocateDefaultPins();
	UK2Node_CallFunction* Call = NewObject<UK2Node_CallFunction>(Graph, TEXT("OwnedPrint"));
	Call->SetFromFunction(UKismetSystemLibrary::StaticClass()->FindFunctionByName(TEXT("PrintString")));
	Graph->AddNode(Call);
	Call->AllocateDefaultPins();
	Call->NodePosX = 300;
	Call->FindPinChecked(TEXT("InString"))->DefaultValue = TEXT("UEMCP owned serialization fixture");
	if (!Graph->GetSchema()->TryCreateConnection(Event->FindPinChecked(UEdGraphSchema_K2::PN_Then), Call->FindPinChecked(UEdGraphSchema_K2::PN_Execute))) return 4;
	FKismetEditorUtilities::CompileBlueprint(BP);
	if (BP->Status == BS_Error) return 5;
	// Fixed identities are assigned after compilation. UE may reconstruct pin IDs on reload;
	// the independent oracle records that load and comparisons require unique names.
	Event->NodeGuid = FGuid(1, 0xABCDEF12, 0x80000000, 0xFFFFFFFF);
	Call->NodeGuid = FGuid(0x12345678, 2, 3, 4);
	for (int32 N = 0; N < Graph->Nodes.Num(); ++N)
		for (int32 P = 0; P < Graph->Nodes[N]->Pins.Num(); ++P)
			Graph->Nodes[N]->Pins[P]->PinId = FGuid(0x10000000 + N, P + 1, 3, 4);
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, BP, *Filename, Args) ? 0 : 6;
#else
	return 1;
#endif
}
