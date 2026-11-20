// Copyright Noah Butcher. All Rights Reserved.
// Explicit supervisor-only qualification fixture. No broad/default discovery.
#if WITH_DEV_AUTOMATION_TESTS
#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Runtime/Launch/Resources/Version.h"

namespace UEMCP::WorldMapFixturePreparation
{
// Only the first startup command is admitted: the reviewed supervisor launches
// one exact author OR reload case, followed by Quit. Broad filters and RunAll
// must never opt this fixture into an ordinary automation session.
static bool HasExplicitTestRequest(const FString& TestName)
{
	FString ExecCommands;
	if (!FParse::Value(FCommandLine::Get(), TEXT("ExecCmds="), ExecCommands, false)) return false;
	FString FirstCommand, RemainingCommands;
	if (!ExecCommands.Split(TEXT(";"), &FirstCommand, &RemainingCommands)) FirstCommand = ExecCommands;
	const TCHAR* Command = *FirstCommand;
	if (!FParse::Command(&Command, TEXT("Automation")) ||
		!(FParse::Command(&Command, TEXT("RunTests")) || FParse::Command(&Command, TEXT("RunTest")))) return false;
	TArray<FString> Names;
	FString(Command).ParseIntoArray(Names, TEXT("+"), true);
	for (const FString& Name : Names)
	{
		const FString ExactName = Name.TrimStartAndEnd();
		if (ExactName.Equals(TestName, ESearchCase::IgnoreCase) ||
			ExactName.Equals(TEXT("^") + TestName + TEXT("$"), ESearchCase::IgnoreCase)) return true;
	}
	return false;
}
}

// The package layout and Engine types below are deliberately UE 5.6-only.
// Keep the preflight static_assert: other engines get explicit failure stubs,
// never compilation of an unreviewed reader or a silent successful skip.
#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION == 6
#include "WorldPackageReader.proposal.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AI/NavigationSystemConfig.h"
#include "Components/SceneComponent.h"
#include "Engine/Level.h"
#include "Engine/LevelActorContainer.h"
#include "Engine/LevelScriptActor.h"
#include "Engine/Engine.h"
#include "Engine/Polys.h"
#include "Engine/World.h"
#include "Engine/WorldInitializationValues.h"
#include "GameFramework/Actor.h"
#include "GameFramework/WorldSettings.h"
#include "GameFramework/DamageType.h"
#include "Model.h"
#include "EditorFramework/ThumbnailInfo.h"
#include "ThumbnailRendering/WorldThumbnailInfo.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/UObjectHash.h"
#include "UObject/UnrealType.h"

namespace UEMCP::WorldMapFixturePreparation
{
struct FRun { FString Id,Stage,Attempt,Project,Root,Package,Asset,Receipt,Oracle,Sidecar,LegacySidecar; };
static bool ReadSmallJson(const FString& File,TSharedPtr<FJsonObject>& Out)
{
 TUniquePtr<IFileHandle> Handle(FPlatformFileManager::Get().GetPlatformFile().OpenRead(*File,false));
 if(!Handle) return false; const int64 Size=Handle->Size();
 if(Size<=0 || Size>4096) return false;
 TArray<uint8> Bytes; Bytes.SetNumUninitialized(int32(Size));
 if(!Handle->Read(Bytes.GetData(),Size) || Handle->Size()!=Size) return false;
 FString Text; FFileHelper::BufferToString(Text,Bytes.GetData(),Bytes.Num());
 return Text.Len()<=4096 &&
  FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text),Out) && Out.IsValid();
}
static bool WriteExclusiveJson(const FString& File,const TSharedPtr<FJsonObject>& Object)
{
 FString Text;
 if(!FJsonSerializer::Serialize(Object.ToSharedRef(),TJsonWriterFactory<>::Create(&Text)) || Text.Len()>32*1024*1024) return false;
 return FFileHelper::SaveStringToFile(Text,*File,FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM,
  &IFileManager::Get(),FILEWRITE_NoReplaceExisting);
}
static bool Hex32(const FString& Value)
{ if(Value.Len()!=32) return false; for(TCHAR C:Value) if(!FChar::IsHexDigit(C) || C!=FChar::ToLower(C)) return false; return true; }
static bool Open(FAutomationTestBase& T,const FString& Phase,FRun& R)
{
 FString GivenPhase; FParse::Value(FCommandLine::Get(),TEXT("UEMCPWorldRun="),R.Id);
 FParse::Value(FCommandLine::Get(),TEXT("UEMCPWorldPhase="),GivenPhase);
 FParse::Value(FCommandLine::Get(),TEXT("UEMCPWorldStage="),R.Stage);
 FParse::Value(FCommandLine::Get(),TEXT("UEMCPWorldAttempt="),R.Attempt);
 if(!Hex32(R.Id) || !Hex32(R.Stage) || !Hex32(R.Attempt) || GivenPhase!=Phase ||
  FEngineVersion::Current().GetMajor()!=5 || FEngineVersion::Current().GetMinor()!=6 ||
  !FParse::Param(FCommandLine::Get(),TEXT("NullRHI")) || !FParse::Param(FCommandLine::Get(),TEXT("NoSound")) ||
  !FParse::Param(FCommandLine::Get(),TEXT("Unattended")))
 { T.AddError(TEXT("Explicit owned World phase and bounded headless flags required")); return false; }
 R.Project=FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
 R.Root=FPaths::Combine(R.Project,TEXT("Saved/UEMCPWorld"),R.Id);
 R.Package=TEXT("/Game/__UEMCPWorld/")+R.Id+TEXT("/L_PlacedActors");
 R.Asset=FPackageName::LongPackageNameToFilename(R.Package,FPackageName::GetMapPackageExtension());
 R.Receipt=FPaths::Combine(R.Root,TEXT("author.receipt.json")); R.Oracle=FPaths::Combine(R.Root,TEXT("reload.oracle.json"));
 R.Sidecar=FPaths::Combine(FPaths::ProjectSavedDir(),TEXT("UEMCP"),R.Package.Mid(1)+TEXT(".sidecar.json"));
 R.LegacySidecar=FPaths::Combine(R.Project,TEXT("Saved/UEMCP"),R.Package.Mid(1)+TEXT(".sidecar.json"));
 TSharedPtr<FJsonObject> J; FString Schema,Id,Stage,Attempt,Project,ActualPhase;
 if(!ReadSmallJson(FPaths::Combine(R.Root,Phase+TEXT(".authority.json")),J) ||
  !J->TryGetStringField(TEXT("schema"),Schema) || Schema!=TEXT("owned-world-authority-v1") ||
  !J->TryGetStringField(TEXT("run_id"),Id) || Id!=R.Id || !J->TryGetStringField(TEXT("stage_id"),Stage) || Stage!=R.Stage ||
  !J->TryGetStringField(TEXT("attempt_id"),Attempt) || Attempt!=R.Attempt ||
  !J->TryGetStringField(TEXT("phase"),ActualPhase) || ActualPhase!=Phase ||
  !J->TryGetStringField(TEXT("project_dir"),Project) || !FPaths::IsSamePath(Project,R.Project))
 { T.AddError(TEXT("Missing/mismatched owned World authority; marker alone is not supervisor launch authority")); return false; }
 return true;
}
struct FReadGuard
{
 TUniquePtr<IFileHandle> Handle;
 TArray<uint8> Bytes;
 FString Sha1;
 bool Open(const FString& File)
 {
  // Windows physical OpenRead(false) permits other readers, denies write/delete.
  // The reviewed supervisor must also attest the actual physical non-reparse path.
  Handle.Reset(FPlatformFileManager::Get().GetPlatformFile().OpenRead(*File,false));
  if(!Handle) return false;
  const int64 Size=Handle->Size(); if(Size<32 || Size>16*1024*1024) return false;
  Bytes.SetNumUninitialized(int32(Size));
  if(!Handle->Read(Bytes.GetData(),Size) || Handle->Size()!=Size) return false;
  Sha1=FSHA1::HashBuffer(Bytes.GetData(),Bytes.Num()).ToString().ToLower(); return true;
 }
 bool Unchanged()
 {
  if(!Handle || Handle->Size()!=Bytes.Num() || !Handle->Seek(0)) return false;
  TArray<uint8> Chunk; Chunk.SetNumUninitialized(65536); FSHA1 Hash;
  for(int64 Left=Bytes.Num(); Left>0;)
  { const int64 Count=FMath::Min<int64>(Left,Chunk.Num()); if(!Handle->Read(Chunk.GetData(),Count)) return false; Hash.Update(Chunk.GetData(),Count); Left-=Count; }
  return Hash.Finalize().ToString().ToLower()==Sha1;
 }
};
static TSharedPtr<FJsonObject> Provenance(const FRun& R,const FString& Schema,const FString& Phase,const FReadGuard& File)
{
 auto J=JsonObject(); J->SetStringField(TEXT("schema"),Schema); J->SetStringField(TEXT("phase"),Phase);
 J->SetStringField(TEXT("run_id"),R.Id); J->SetStringField(TEXT("stage_id"),R.Stage); J->SetStringField(TEXT("attempt_id"),R.Attempt);
 J->SetStringField(TEXT("project_dir"),R.Project); J->SetStringField(TEXT("package"),R.Package);
 J->SetStringField(TEXT("engine_version"),FEngineVersion::Current().ToString());
 J->SetNumberField(TEXT("file_size"),File.Bytes.Num()); J->SetStringField(TEXT("file_sha1"),File.Sha1);
 return J; // SHA256/source/DLL/process/report authority is supplied independently by supervisor
}
static TSharedPtr<FJsonValue> VectorJson(const FVector& V)
{ return MakeShared<FJsonValueArray>(TArray<TSharedPtr<FJsonValue>>{MakeShared<FJsonValueNumber>(V.X),MakeShared<FJsonValueNumber>(V.Y),MakeShared<FJsonValueNumber>(V.Z)}); }
static bool Placement(FAutomationTestBase& T,const FRun& R,UWorld* World,TArray<TSharedPtr<FJsonValue>>& Markers,TArray<TSharedPtr<FJsonValue>>& Inventory)
{
 if(!World || World->GetOutermost()->GetName()!=R.Package || World->GetClass()!=UWorld::StaticClass() ||
  !World->PersistentLevel || World->IsPartitionedWorld() || !World->GetStreamingLevels().IsEmpty() ||
  World->GetNavigationSystem() || World->GetAISystem() || World->GetPhysicsScene() || World->Scene ||
  World->WorldType!=EWorldType::Editor || World->IsInitialized())
 { T.AddError(FString::Printf(TEXT("Exact owned Editor World state required: present=%d package=%s class=%s persistent=%d partitioned=%d streaming=%d navigation=%d ai=%d physics=%d scene=%d type=%d initialized=%d"),World?1:0,World?*World->GetOutermost()->GetName():TEXT("<null>"),World?*World->GetClass()->GetPathName():TEXT("<null>"),World&&World->PersistentLevel?1:0,World&&World->IsPartitionedWorld()?1:0,World?World->GetStreamingLevels().Num():-1,World&&World->GetNavigationSystem()?1:0,World&&World->GetAISystem()?1:0,World&&World->GetPhysicsScene()?1:0,World&&World->Scene?1:0,World?int32(World->WorldType):-1,World&&World->IsInitialized()?1:0)); return false; }
 auto Level=World->PersistentLevel; auto Settings=World->GetWorldSettings(false,false); auto Model=Level->Model.Get();
 if(!Settings || Settings->GetClass()!=AWorldSettings::StaticClass() || Settings->GetOuter()!=Level ||
  !Model || Model->GetClass()!=UModel::StaticClass() || Model->GetOuter()!=Level || !Model->Nodes.IsEmpty() ||
  !Model->Verts.IsEmpty() || !Model->Surfs.IsEmpty() || !Model->Polys || !Model->Polys->Element.IsEmpty() ||
  Model->Polys->GetClass()!=UPolys::StaticClass() || Model->Polys->GetOuter()!=Level || Level->LevelScriptBlueprint || !Level->ModelComponents.IsEmpty())
 { T.AddError(TEXT("Unexpected engine default, BSP content or embedded Blueprint; review required")); return false; }
 TMap<UObject*,FString> Allowed; Allowed.Add(World,TEXT("world")); Allowed.Add(Level,TEXT("level"));
 Allowed.Add(Settings,TEXT("world-settings")); Allowed.Add(Model,TEXT("empty-model")); Allowed.Add(Model->Polys,TEXT("empty-polys"));
 auto Config=Settings->GetNavigationSystemConfig();
 if(Config)
 {
  const FString Class=Config->GetClass()->GetPathName();
  if(Config->GetOuter()!=Settings || (Class!=TEXT("/Script/Engine.NavigationSystemConfig") &&
   Class!=TEXT("/Script/NavigationSystem.NavigationSystemModuleConfig")) || Config->NavigationSystemClass.IsValid())
  {
   auto StoredProperty=FindFProperty<FObjectPropertyBase>(AWorldSettings::StaticClass(),TEXT("NavigationSystemConfig"));
   auto LegacyProperty=FindFProperty<FBoolProperty>(AWorldSettings::StaticClass(),TEXT("bEnableNavigationSystem"));
   UObject* StoredConfig=StoredProperty && StoredProperty->GetOwnerStruct()==AWorldSettings::StaticClass() ? StoredProperty->GetObjectPropertyValue_InContainer(Settings) : nullptr;
   const bool LegacyEnabled=LegacyProperty && LegacyProperty->GetOwnerStruct()==AWorldSettings::StaticClass() && LegacyProperty->GetPropertyValue_InContainer(Settings);
   const auto Override=Settings->GetNavigationSystemConfigOverride();
   const FString NavClass=Config->NavigationSystemClass.ToString();
   T.AddError(FString::Printf(TEXT("Unreviewed or enabled navigation config default: config_path=%s class=%s outer=%s expected_outer=%s stored_property_found=%d stored_path=%s override_path=%s nav_class=%s nav_class_chars=%d nav_class_valid=%d legacy_flag_found=%d legacy_enabled=%d world_nav_enabled=%d world_ai_enabled=%d"),
    *Config->GetPathName(),*Class,*Config->GetOuter()->GetPathName(),*Settings->GetPathName(),StoredProperty&&StoredProperty->GetOwnerStruct()==AWorldSettings::StaticClass()?1:0,StoredConfig?*StoredConfig->GetPathName():TEXT("<null>"),Override?*Override->GetPathName():TEXT("<null>"),*NavClass.Left(512),NavClass.Len(),Config->NavigationSystemClass.IsValid()?1:0,LegacyProperty&&LegacyProperty->GetOwnerStruct()==AWorldSettings::StaticClass()?1:0,LegacyEnabled?1:0,Settings->IsNavigationSystemEnabled()?1:0,Settings->IsAISystemEnabled()?1:0));
   return false;
  }
  Allowed.Add(Config,TEXT("disabled-navigation-config"));
 }
 if(Level->ActorCluster)
 {
  if(Level->ActorCluster->GetClass()!=ULevelActorContainer::StaticClass() || Level->ActorCluster->GetOuter()!=Level || !Level->ActorCluster->HasAnyFlags(RF_Transient)) return false;
  Allowed.Add(Level->ActorCluster,TEXT("transient-actor-container"));
 }
 if(World->ThumbnailInfo)
 {
  if(World->ThumbnailInfo->GetOuter()!=World || World->ThumbnailInfo->GetClass()->GetPathName()!=TEXT("/Script/UnrealEd.WorldThumbnailInfo")) return false;
  Allowed.Add(World->ThumbnailInfo,TEXT("world-thumbnail-info"));
 }
 auto Script=Level->GetLevelScriptActor();
 if(Script)
 {
  if(Script->GetClass()!=ALevelScriptActor::StaticClass() || Script->GetOuter()!=Level) return false;
  Allowed.Add(Script,TEXT("native-level-script-actor"));
 }
 int32 NamedMarkers=0;
 for(AActor* Actor:Level->Actors) if(Actor)
 {
  if(Actor->GetName().StartsWith(TEXT("OwnedMarker_"))) ++NamedMarkers;
  else if(Actor!=Settings && Actor!=Script) { T.AddError(FString::Printf(TEXT("Unexpected additional level actor: path=%s class=%s transient=%d same_world=%d outer=%s"),*Actor->GetPathName(),*Actor->GetClass()->GetPathName(),Actor->HasAnyFlags(RF_Transient)?1:0,Actor->GetWorld()==World?1:0,*Actor->GetOuter()->GetPathName())); return false; }
 }
 if(NamedMarkers!=64) { T.AddError(TEXT("Exactly64 named markers required")); return false; }
 for(int32 Row=0; Row<8; ++Row) for(int32 Col=0; Col<8; ++Col)
 {
  const FString Name=FString::Printf(TEXT("OwnedMarker_Row%d_Col%d"),Row,Col);
  auto Actor=FindObject<AActor>(World->PersistentLevel,*Name); auto Root=Actor ? Actor->GetRootComponent() : nullptr;
  // ComponentToWorld is a transient cache; derive it only from already validated persisted fields.
  if(!Actor || Actor->GetClass()!=AActor::StaticClass() || Actor->GetOuter()!=Level || !Root ||
   Root->GetClass()!=USceneComponent::StaticClass() || Root->GetOuter()!=Actor || Root->GetOwner()!=Actor ||
   Root->GetName()!=TEXT("OwnedRoot") || Root->HasAnyFlags(RF_Transient) || Actor->HasAnyFlags(RF_Transient) ||
   Actor->GetInstanceComponents().Num()!=1 || Actor->GetInstanceComponents()[0]!=Root ||
   Root->IsRegistered() || Root->GetAttachParent() || !Root->GetAttachChildren().IsEmpty() ||
   !Root->GetRelativeLocation().Equals(FVector(Row*200,Col*200,0),0.0) ||
   !Root->GetRelativeRotation().IsNearlyZero(0.0) || !Root->GetRelativeScale3D().Equals(FVector::OneVector,0.0))
  { T.AddError(TEXT("Exact unattached unregistered marker root and persisted transform required before cache update")); return false; }
  const FVector RelativeLocation=Root->GetRelativeLocation(), RelativeScale=Root->GetRelativeScale3D();
  const FRotator RelativeRotation=Root->GetRelativeRotation();
  Root->UpdateComponentToWorld(EUpdateTransformFlags::SkipPhysicsUpdate,ETeleportType::None);
  if(Root->IsRegistered() || Root->GetAttachParent() || !Root->GetAttachChildren().IsEmpty() ||
   Root->GetRelativeLocation()!=RelativeLocation || Root->GetRelativeRotation()!=RelativeRotation || Root->GetRelativeScale3D()!=RelativeScale ||
   World->WorldType!=EWorldType::Editor || Actor->GetRootComponent()!=Root ||
   World->IsInitialized() || World->Scene || World->GetPhysicsScene() || World->GetNavigationSystem() || World->GetAISystem())
  { T.AddError(TEXT("Cache update changed persisted fields, attachment, registration or owned World state")); return false; }
  if(!Actor || Actor->GetClass()!=AActor::StaticClass() || Actor->GetOuter()!=World->PersistentLevel || !Root ||
   Root->GetClass()!=USceneComponent::StaticClass() || Root->GetName()!=TEXT("OwnedRoot") || Root->GetOuter()!=Actor ||
   Root->HasAnyFlags(RF_Transient) || Actor->HasAnyFlags(RF_Transient) || Actor->GetInstanceComponents().Num()!=1 ||
   Actor->GetInstanceComponents()[0]!=Root || Root->GetOwner()!=Actor ||
   !Actor->GetActorLocation().Equals(FVector(Row*200,Col*200,0),0.0) || !Actor->GetActorRotation().IsNearlyZero(0.0) ||
   !Actor->GetActorScale3D().Equals(FVector::OneVector,0.0) || !Actor->Tags.Contains(FName(*(TEXT("UEMCPWorld_")+R.Id))))
  { T.AddError(TEXT("Marker/root/class/outer/tag/transform witness")); return false; }
  auto J=JsonObject(), K=JsonObject(); J->SetStringField(TEXT("name"),Name); J->SetStringField(TEXT("path"),Actor->GetPathName());
  J->SetStringField(TEXT("outer"),Actor->GetOuter()->GetPathName()); J->SetStringField(TEXT("class"),Actor->GetClass()->GetPathName());
  J->SetNumberField(TEXT("instance_components"),Actor->GetInstanceComponents().Num());
  J->SetField(TEXT("location"),VectorJson(Actor->GetActorLocation())); J->SetField(TEXT("scale"),VectorJson(Actor->GetActorScale3D()));
  const FRotator Rot=Actor->GetActorRotation(); J->SetField(TEXT("rotation"),VectorJson(FVector(Rot.Pitch,Rot.Yaw,Rot.Roll)));
  K->SetStringField(TEXT("name"),Root->GetName()); K->SetStringField(TEXT("path"),Root->GetPathName());
  K->SetStringField(TEXT("class"),Root->GetClass()->GetPathName()); K->SetStringField(TEXT("outer"),Root->GetOuter()->GetPathName());
  J->SetObjectField(TEXT("root"),K); Markers.Add(JsonValue(J));
  Allowed.Add(Actor,TEXT("marker")); Allowed.Add(Root,TEXT("marker-root"));
 }
 int32 Objects=0; bool Valid=true; TSet<UObject*> Seen;
 ForEachObjectWithPackage(World->GetOutermost(),[&](UObject* Object)
 {
  const FString* Role=Allowed.Find(Object);
  if(++Objects>4096 || Object->IsPackageExternal() || !Role || Seen.Contains(Object)) { Valid=false; return false; }
  Seen.Add(Object); auto J=JsonObject(); J->SetStringField(TEXT("path"),Object->GetPathName());
  J->SetStringField(TEXT("class"),Object->GetClass()->GetPathName()); J->SetStringField(TEXT("outer"),Object->GetOuter()->GetPathName());
  J->SetStringField(TEXT("role"),*Role); J->SetBoolField(TEXT("transient"),Object->HasAnyFlags(RF_Transient)); Inventory.Add(JsonValue(J)); return true;
 });
 if(!Valid || Seen.Num()!=Allowed.Num()) { T.AddError(TEXT("Unexplained or missing owned/default object inventory")); return false; }
 return true;
}
static bool BindInventory(FAutomationTestBase& T,const FRun& R,const FWorldPackageTables& Tables,const TArray<TSharedPtr<FJsonValue>>& Inventory)
{
 TSet<int32> Seen;
 for(const auto& Value:Inventory)
 {
  auto J=Value->AsObject(); const FString Path=J->GetStringField(TEXT("path")),Class=J->GetStringField(TEXT("class"));
  if(J->GetBoolField(TEXT("transient")))
  {
   if(J->GetStringField(TEXT("role"))!=TEXT("transient-actor-container")) return false;
   J->SetNumberField(TEXT("disk_export_index"),0); continue;
  }
  int32 Index=INDEX_NONE;
  for(int32 I=0; I<Tables.ExportRows.Num(); ++I) if(Tables.ExportRows[I].Path==Path) { Index=I; break; }
  if(Index<0 || Seen.Contains(Index) || Tables.ExportRows[Index].Class!=Class)
  { T.AddError(TEXT("Loaded object missing/duplicated or class differs from disk export")); return false; }
  const auto& Row=Tables.ExportRows[Index];
  const FString Outer=Row.Outer==0 ? R.Package : Row.Outer>0 ? Tables.ExportRows[Row.Outer-1].Path : Tables.ImportRows[-Row.Outer-1].Path;
  if(J->GetStringField(TEXT("outer"))!=Outer) { T.AddError(TEXT("Loaded outer differs from disk")); return false; }
  Seen.Add(Index); J->SetNumberField(TEXT("disk_export_index"),Index+1);
 }
 if(Seen.Num()!=Tables.ExportRows.Num()) { T.AddError(TEXT("Unexplained/unloaded disk export")); return false; }
 return true;
}
static bool Author(FAutomationTestBase& T)
{
 FRun R; if(!Open(T,TEXT("author"),R)) return false;
 if(FindPackage(nullptr,*R.Package) || IFileManager::Get().FileExists(*R.Asset) || IFileManager::Get().FileExists(*R.Receipt) ||
  IFileManager::Get().FileExists(*R.Oracle) || IFileManager::Get().FileExists(*R.Sidecar) ||
  IFileManager::Get().FileExists(*R.LegacySidecar) ||
  IFileManager::Get().FileExists(*FPaths::ChangeExtension(R.Asset,TEXT("uexp"))) ||
  IFileManager::Get().FileExists(*FPaths::ChangeExtension(R.Asset,TEXT("ubulk"))) ||
  IFileManager::Get().FileExists(*FPaths::ChangeExtension(R.Asset,TEXT("uptnl"))) ||
  IFileManager::Get().DirectoryExists(*FPaths::GetPath(R.Asset)))
 { T.AddError(TEXT("Refusing existing owned World package/run directory/output")); return false; }
 if(!GEngine || GEngine->WorldSettingsClass!=AWorldSettings::StaticClass()) { T.AddError(TEXT("Standard native WorldSettings host required")); return false; }
 auto Package=CreatePackage(*R.Package);
 UWorld::InitializationValues IV; IV.InitializeScenes(false).AllowAudioPlayback(false).RequiresHitProxies(false).CreatePhysicsScene(false)
  .CreateNavigation(false).CreateAISystem(false).ShouldSimulatePhysics(false).EnableTraceCollision(false).SetTransactional(false)
  .CreateFXSystem(false).CreateWorldPartition(false).EnableWorldPartitionStreaming(false);
 UWorld* World=UWorld::CreateWorld(EWorldType::Editor,false,TEXT("L_PlacedActors"),Package,true,ERHIFeatureLevel::Num,&IV,true);
 if(!World) { T.AddError(TEXT("Owned World creation failed")); return false; }
 ON_SCOPE_EXIT { if(World->IsInitialized()) World->DestroyWorld(false); if(World->IsRooted()) World->RemoveFromRoot(); World->ClearFlags(RF_Standalone); };
 if(World->IsInitialized() || World->Scene || World->GetPhysicsScene()) { T.AddError(TEXT("Owned serialization World must remain uninitialized without scenes")); return false; }
 if(!World->PersistentLevel) { T.AddError(TEXT("Owned persistent Level creation failed")); return false; }
 World->SetFlags(RF_Public|RF_Standalone); Package->SetPackageFlags(PKG_ContainsMap);
 if(World->ThumbnailInfo) { T.AddError(TEXT("Fresh owned World thumbnail field must be null")); return false; }
 World->ThumbnailInfo=NewObject<UWorldThumbnailInfo>(World,TEXT("WorldThumbnailInfo"),RF_NoFlags);
 if(!World->ThumbnailInfo || World->ThumbnailInfo->GetClass()!=UWorldThumbnailInfo::StaticClass() ||
  World->ThumbnailInfo->GetOuter()!=World || World->ThumbnailInfo->GetName()!=TEXT("WorldThumbnailInfo") || World->ThumbnailInfo->HasAnyFlags(RF_Transient))
 { T.AddError(TEXT("Exact serializable owned World thumbnail required")); return false; }
 auto Settings=World->GetWorldSettings(false,false);
 if(!Settings) return false;
 // Configure only the new owned World; global engine/project defaults remain unchanged.
 Settings->KillZDamageType=UDamageType::StaticClass(); Settings->DefaultGameMode=nullptr;
 auto AIEnabled=FindFProperty<FBoolProperty>(AWorldSettings::StaticClass(),TEXT("bEnableAISystem"));
 if(!AIEnabled || AIEnabled->GetOwnerStruct()!=AWorldSettings::StaticClass())
 { T.AddError(TEXT("Exact native WorldSettings AI flag property required")); return false; }
 AIEnabled->SetPropertyValue_InContainer(Settings,false);
 if(Settings->IsAISystemEnabled()) { T.AddError(TEXT("Owned World AI flag did not clear")); return false; }
 Settings->AISystemClass.Reset();
 // Author the documented null configuration on this newly created owned World.
 // The legacy flag must also be false: PostLoad otherwise creates an enabled
 // default config. Never normalize either field on the read-only reload path.
 auto StoredNav=FindFProperty<FObjectPropertyBase>(AWorldSettings::StaticClass(),TEXT("NavigationSystemConfig"));
 auto LegacyNav=FindFProperty<FBoolProperty>(AWorldSettings::StaticClass(),TEXT("bEnableNavigationSystem"));
 if(!StoredNav || StoredNav->GetOwnerStruct()!=AWorldSettings::StaticClass() ||
  !LegacyNav || LegacyNav->GetOwnerStruct()!=AWorldSettings::StaticClass() || Settings->GetNavigationSystemConfigOverride())
 { T.AddError(TEXT("Exact native WorldSettings navigation properties required")); return false; }
 auto FreshConfig=Settings->GetNavigationSystemConfig();
 if(FreshConfig)
 {
  const FString FreshClass=FreshConfig->GetClass()->GetPathName();
  if(FreshConfig->GetOuter()!=Settings || StoredNav->GetObjectPropertyValue_InContainer(Settings)!=FreshConfig ||
   (FreshClass!=TEXT("/Script/Engine.NavigationSystemConfig") && FreshClass!=TEXT("/Script/NavigationSystem.NavigationSystemModuleConfig")))
  { T.AddError(TEXT("Exact newly created navigation config required")); return false; }
  // Relocate only the newly owned fixture default out of the package inventory.
  const FName TransientName=MakeUniqueObjectName(GetTransientPackage(),FreshConfig->GetClass(),TEXT("UEMCPOwnedNewNavConfig"));
  if(!FreshConfig->Rename(*TransientName.ToString(),GetTransientPackage(),REN_DontCreateRedirectors|REN_NonTransactional) ||
   FreshConfig->GetOuter()!=GetTransientPackage())
  { T.AddError(TEXT("Owned new navigation config relocation failed")); return false; }
 }
 StoredNav->SetObjectPropertyValue_InContainer(Settings,nullptr);
 LegacyNav->SetPropertyValue_InContainer(Settings,false);
 if(Settings->GetNavigationSystemConfig() || Settings->IsNavigationSystemEnabled() || LegacyNav->GetPropertyValue_InContainer(Settings))
 { T.AddError(TEXT("Owned World null navigation configuration did not apply")); return false; }
 for(int32 Row=0; Row<8; ++Row) for(int32 Col=0; Col<8; ++Col)
 {
  FActorSpawnParameters Params; Params.Name=FName(*FString::Printf(TEXT("OwnedMarker_Row%d_Col%d"),Row,Col));
  Params.OverrideLevel=World->PersistentLevel; Params.bCreateActorPackage=false; Params.SpawnCollisionHandlingOverride=ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
  auto Actor=World->SpawnActor<AActor>(FVector::ZeroVector,FRotator::ZeroRotator,Params);
  if(!Actor) { T.AddError(TEXT("Marker spawn failed")); return false; }
  auto Root=NewObject<USceneComponent>(Actor,TEXT("OwnedRoot"),RF_NoFlags);
  Actor->AddInstanceComponent(Root);
  if(!Actor->SetRootComponent(Root)) { T.AddError(TEXT("Marker root assignment failed")); return false; }
  Actor->Tags.Add(FName(*(TEXT("UEMCPWorld_")+R.Id)));
  if(!Actor->SetActorTransform(FTransform(FRotator::ZeroRotator,FVector(Row*200,Col*200,0),FVector::OneVector)))
  { T.AddError(TEXT("Marker transform assignment failed")); return false; }
 }
 TArray<TSharedPtr<FJsonValue>> Markers,Inventory;
 if(!Placement(T,R,World,Markers,Inventory)) return false;
 FAssetRegistryModule::AssetCreated(World);
 if(World->IsInitialized() || World->Scene || World->GetPhysicsScene()) { T.AddError(TEXT("Asset-created callback initialized owned serialization World")); return false; }
 if(!IFileManager::Get().MakeDirectory(*FPaths::GetPath(R.Asset),true)) { T.AddError(TEXT("Owned map directory creation failed")); return false; }
 FSavePackageArgs Args; Args.TopLevelFlags=RF_Public|RF_Standalone; Args.SaveFlags=SAVE_NoError;
 if(!UPackage::SavePackage(Package,World,*R.Asset,Args)) { T.AddError(TEXT("Owned uncooked map save failed")); return false; }
 if(Settings->GetNavigationSystemConfig() || Settings->GetNavigationSystemConfigOverride() ||
  Settings->IsNavigationSystemEnabled() || LegacyNav->GetPropertyValue_InContainer(Settings))
 { T.AddError(TEXT("Save changed owned null navigation configuration")); return false; }
 if(World->IsInitialized() || World->Scene || World->GetPhysicsScene()) { T.AddError(TEXT("Save initialized owned serialization World")); return false; }
 FReadGuard File; FWorldPackageTables Tables;
 if(!File.Open(R.Asset) || !Tables.Read(File.Bytes,R.Package) || !File.Unchanged())
 { T.AddError(TEXT("Saved map byte/table/count/identity qualification failed: ")+Tables.Error); return false; }
 auto Receipt=Provenance(R,TEXT("owned-world-map-author-v1"),TEXT("author"),File);
 Receipt->SetNumberField(TEXT("export_count"),Tables.Summary.ExportCount);
 return T.TestTrue(TEXT("Exclusive author receipt"),WriteExclusiveJson(R.Receipt,Receipt));
}
static bool ReaderControls(FAutomationTestBase& T,const FRun& R,const FReadGuard& File,const FWorldPackageTables& Baseline)
{
 const auto Reject=[&](const TCHAR* Label,TFunctionRef<void(TArray<uint8>&)> Mutate)
 {
  TArray<uint8> Copy=File.Bytes; Mutate(Copy); FWorldPackageTables Reader;
  return T.TestFalse(Label,Reader.Read(Copy,R.Package));
 };
 const auto I32=[](TArray<uint8>& Bytes,int64 At,int32 Value)
 { const uint32 Raw=uint32(Value); for(int32 I=0; I<4; ++I) Bytes[At+I]=uint8(Raw>>(I*8)); };
 const auto I64=[](TArray<uint8>& Bytes,int64 At,int64 Value)
 { const uint64 Raw=uint64(Value); for(int32 I=0; I<8; ++I) Bytes[At+I]=uint8(Raw>>(I*8)); };
 bool Good=true;
 // Mutate only copied authored bytes; the dependency boundary must be exact.
 {
  const int64 RegistryAt=Baseline.Summary.AssetRegistryDataOffset;
  const int64 Dependency=int64(Baseline.Registry->GetNumberField(TEXT("dependency_offset")));
  if(RegistryAt<0 || RegistryAt+12>File.Bytes.Num() || Dependency<=RegistryAt+12 ||
   int64(Baseline.Registry->GetNumberField(TEXT("end")))!=Dependency ||
   Dependency>=Baseline.Budget.SectionEnd(RegistryAt))
  { T.AddError(TEXT("Exact registry boundary control requires contiguous baseline and one dependency byte")); return false; }
  TArray<uint8> GapBytes=File.Bytes; I64(GapBytes,RegistryAt,Dependency+1);
  FWorldPackageTables GapReader;
  Good &= T.TestFalse(TEXT("Forward dependency offset leaves an unparsed byte"),GapReader.Read(GapBytes,R.Package));
  Good &= T.TestEqual(TEXT("Registry gap rejects at exact boundary"),GapReader.Error,FString(TEXT("Registry object data must end at dependency offset")));
  Good &= Reject(TEXT("Backward dependency offset truncates object data"),[&](auto& B){ I64(B,RegistryAt,Dependency-1); });
  const int32 RegistryObjects=Baseline.Registry->GetArrayField(TEXT("objects")).Num();
  if(RegistryObjects>1)
   Good &= Reject(TEXT("Positive underreported registry object count"),[&](auto& B){ I32(B,RegistryAt+8,RegistryObjects-1); });
  else
   T.AddInfo(TEXT("Positive underreported object count not exercised: authored registry contains one object"));
 }
 if(Baseline.Budget.SoftPaths==1)
 {
  const int64 At=Baseline.Budget.SoftPathOffset;
  FAllocationPreflight Scan(File.Bytes,Baseline.Summary.NameOffset,Baseline.Budget.SectionEnd(Baseline.Summary.NameOffset));
  for(int32 I=0; I<Baseline.Budget.SoftPathNameIndex; ++I) if(!Scan.String(NAME_SIZE,true) || !Scan.Skip(4)) { T.AddError(TEXT("Bounded null name control cursor")); return false; }
  const int64 NullNameWire=Scan.Tell();
  if(NullNameWire+4>=File.Bytes.Num() || File.Bytes[NullNameWire+4]!='N') { T.AddError(TEXT("Actual null name control byte required")); return false; }
  Good &= Reject(TEXT("Case changed null soft path name"),[&](auto& B){ B[NullNameWire+4]='n'; });
  const int32 AliasIndex=Baseline.Names.IndexOfByPredicate([](const FString& Name){return Name.Len()==4 && !Name.Equals(TEXT("None"),ESearchCase::IgnoreCase);});
  if(AliasIndex==INDEX_NONE) { T.AddError(TEXT("Four-character alias control name required")); return false; }
  FAllocationPreflight AliasScan(File.Bytes,Baseline.Summary.NameOffset,Baseline.Budget.SectionEnd(Baseline.Summary.NameOffset));
  for(int32 I=0; I<AliasIndex; ++I) if(!AliasScan.String(NAME_SIZE,true) || !AliasScan.Skip(4)) { T.AddError(TEXT("Bounded alias name control cursor")); return false; }
  const int64 AliasWire=AliasScan.Tell();
  if(AliasWire+9>File.Bytes.Num()) { T.AddError(TEXT("Alias control byte extent")); return false; }
  const int32 AliasLength=FAllocationPreflight(File.Bytes,AliasWire,Baseline.Budget.SectionEnd(Baseline.Summary.NameOffset)).I32();
  if(AliasLength!=5) { T.AddError(TEXT("ANSI alias control name required")); return false; }
  Good &= Reject(TEXT("Duplicate case-folded null name alias"),[&](auto& B){ B[AliasWire+4]='n'; B[AliasWire+5]='o'; B[AliasWire+6]='n'; B[AliasWire+7]='e'; });
  Good &= Reject(TEXT("Multiple soft paths outside null profile"),[&](auto& B){ I32(B,Baseline.Budget.SoftPathCountWire,2); });
  Good &= Reject(TEXT("Negative soft path count"),[&](auto& B){ I32(B,Baseline.Budget.SoftPathCountWire,-1); });
  Good &= Reject(TEXT("Soft path offset outside header"),[&](auto& B){ I32(B,Baseline.Budget.SoftPathCountWire+4,Baseline.Summary.TotalHeaderSize); });
  Good &= Reject(TEXT("Null soft path invalid name index"),[&](auto& B){ I32(B,At,Baseline.Names.Num()); I32(B,At+8,Baseline.Names.Num()); });
  Good &= Reject(TEXT("Null soft path name number"),[&](auto& B){ I32(B,At+4,1); });
  Good &= Reject(TEXT("Null soft path nonempty subpath"),[&](auto& B){ I32(B,At+16,1); });
  Good &= Reject(TEXT("Non-None soft path names"),[&](auto& B){ const int32 Other=(Baseline.Budget.SoftPathNameIndex+1)%Baseline.Names.Num(); I32(B,At,Other); I32(B,At+8,Other); });
 }
 // Native archive regression: cumulative registry string accounting survives section restarts.
 {
  FBoundedPackageArchive BudgetArchive(File.Bytes); FPackageFileSummary Header;
  if(!BudgetArchive.ReadSummary(Header)) { T.AddError(TEXT("Registry budget control summary")); return false; }
  bool AggregateRejected=false;
  for(int32 Repeat=0; Repeat<32; ++Repeat)
  {
   int64 Dependency=0; int32 Objects=0,Tags=0; FString Path,Class,Key,Value;
   if(!BudgetArchive.BeginSection(Header.AssetRegistryDataOffset) || !BudgetArchive.ReadRegistryDependency(Dependency) ||
    !BudgetArchive.ReadCount(Objects,4096,12) || Objects<1 || !BudgetArchive.ReadString(Path) || !BudgetArchive.ReadString(Class) ||
    !BudgetArchive.ReadCount(Tags,64,8) || Tags<1 || !BudgetArchive.ReadString(Key) || !Key.Equals(TEXT("ActorsMetaData"),ESearchCase::CaseSensitive))
   { T.AddError(TEXT("Registry budget control exact metadata prefix")); return false; }
   if(!BudgetArchive.ReadWorldActorsMetadata(Value)) { AggregateRejected=true; break; }
  }
  Good &= T.TestTrue(TEXT("Aggregate registry strings reject before crossing budget"),AggregateRejected);
 }
 {
  const auto& Objects=Baseline.Registry->GetArrayField(TEXT("objects"));
  if(Objects.Num()<1) { T.AddError(TEXT("Registry mutation control object")); return false; }
  const auto& Tags=Objects[0]->AsObject()->GetArrayField(TEXT("tags"));
  FAllocationPreflight Scan(File.Bytes,Baseline.Summary.AssetRegistryDataOffset,Baseline.Registry->GetNumberField(TEXT("dependency_offset")));
  if(!Scan.Skip(8) || Scan.I32()!=Objects.Num() || !Scan.String() || !Scan.String() || Scan.I32()!=Tags.Num())
  { T.AddError(TEXT("Registry mutation control prefix")); return false; }
  TMap<FString,int64> KeyWires; int64 MetadataValueWire=-1,MetadataEnd=-1;
  for(const auto& Tag:Tags)
  {
   const FString Key=Tag->AsObject()->GetStringField(TEXT("key")); const int64 KeyWire=Scan.Tell();
   if(!Scan.String()) { T.AddError(TEXT("Registry mutation control key")); return false; }
   const int64 ValueWire=Scan.Tell(); const bool Metadata=Key.Equals(TEXT("ActorsMetaData"),ESearchCase::CaseSensitive);
   if(!Scan.String(Metadata?65536:1024)) { T.AddError(TEXT("Registry mutation control value")); return false; }
   KeyWires.Add(Key,KeyWire); if(Metadata) { MetadataValueWire=ValueWire;MetadataEnd=Scan.Tell(); }
  }
  if(MetadataValueWire<0 || MetadataEnd<=MetadataValueWire+4) { T.AddError(TEXT("Metadata mutation control required")); return false; }
  Good &= Reject(TEXT("Oversized World metadata string"),[&](auto& B){ I32(B,MetadataValueWire,65537); });
  Good &= Reject(TEXT("Negative huge World metadata string"),[&](auto& B){ I32(B,MetadataValueWire,MIN_int32); });
  Good &= Reject(TEXT("World metadata embedded null"),[&](auto& B){ B[MetadataValueWire+4]=0; });
  Good &= Reject(TEXT("World metadata missing terminator"),[&](auto& B){ B[MetadataEnd-1]=1; });
  if(const int64* KeyWire=KeyWires.Find(TEXT("ActorsMetaData"))) Good &= Reject(TEXT("Case changed metadata key loses exception"),[&](auto& B){ B[*KeyWire+4]='a'; });
  const int64* NameWire=KeyWires.Find(TEXT("PrimaryAssetName")); const int64* TypeWire=KeyWires.Find(TEXT("PrimaryAssetType"));
  if(!NameWire || !TypeWire || (FAllocationPreflight(File.Bytes,*NameWire,File.Bytes.Num()).I32()!=17 || FAllocationPreflight(File.Bytes,*TypeWire,File.Bytes.Num()).I32()!=17)) { T.AddError(TEXT("Equal-length duplicate tag control required")); return false; }
  Good &= Reject(TEXT("Duplicate registry tag key"),[&](auto& B){ FMemory::Memcpy(B.GetData()+*TypeWire+4,B.GetData()+*NameWire+4,17); });
 }
 Good &= Reject(TEXT("Huge custom-version count before allocation"),[&](auto& B){ I32(B,48,MAX_int32); });
 Good &= Reject(TEXT("Negative custom-version count before allocation"),[&](auto& B){ I32(B,48,-1); });
 Good &= Reject(TEXT("Huge generation count before allocation"),[&](auto& B){ I32(B,Baseline.Budget.GenerationCountWire,MAX_int32); });
 Good &= Reject(TEXT("Huge chunk ID count before allocation"),[&](auto& B){ I32(B,Baseline.Budget.ChunkCountWire,MAX_int32); });
 Good &= Reject(TEXT("Positive preload with zero offset"),[&](auto& B){ I32(B,Baseline.Budget.PreloadCountWire,1); I32(B,Baseline.Budget.PreloadCountWire+4,0); });
 Good &= Reject(TEXT("Truncated registry section"),[&](auto& B){ B.SetNum(Baseline.Summary.AssetRegistryDataOffset+8); });
 Good &= Reject(TEXT("Zero encoded registry despite native World discovery"),[&](auto& B){ I32(B,Baseline.Summary.AssetRegistryDataOffset+8,0); });
 int32 World=INDEX_NONE,Level=INDEX_NONE,Actor=INDEX_NONE,Root=INDEX_NONE;
 for(int32 I=0; I<Baseline.ExportRows.Num(); ++I)
 {
  const auto& Row=Baseline.ExportRows[I];
  if(Row.Class==TEXT("/Script/Engine.World")) World=I;
  if(Row.Class==TEXT("/Script/Engine.Level")) Level=I;
  if(Row.Path.EndsWith(TEXT(".OwnedMarker_Row0_Col0"))) Actor=I;
  if(Row.Path.EndsWith(TEXT(".OwnedMarker_Row0_Col0.OwnedRoot"))) Root=I;
 }
 if(World<0 || Level<0 || Actor<0 || Root<0) return false;
 Good &= Reject(TEXT("World relabeled Actor"),[&](auto& B){ I32(B,Baseline.ExportRows[World].Start,Baseline.ExportRows[Actor].ClassIndex); });
 Good &= Reject(TEXT("Level relabeled Actor"),[&](auto& B){ I32(B,Baseline.ExportRows[Level].Start,Baseline.ExportRows[Actor].ClassIndex); });
 Good &= Reject(TEXT("Root outer points to World"),[&](auto& B){ I32(B,Baseline.ExportRows[Root].Start+12,World+1); });
 Good &= Reject(TEXT("Level self outer cycle"),[&](auto& B){ I32(B,Baseline.ExportRows[Level].Start+12,Level+1); });
 Good &= Reject(TEXT("Invalid FName index"),[&](auto& B){ I32(B,Baseline.ExportRows[Actor].Start+16,MAX_int32); });
 Good &= Reject(TEXT("Negative FName number"),[&](auto& B){ I32(B,Baseline.ExportRows[Actor].Start+20,-1); });
 const int32 Class=-Baseline.ExportRows[Actor].ClassIndex-1, PackageNameIndex=Baseline.Names.IndexOfByKey(TEXT("Package"));
 if(Class<0 || PackageNameIndex<0) return false;
 Good &= Reject(TEXT("Same-path wrong imported metaclass"),[&](auto& B){ I32(B,Baseline.ImportRows[Class].RawNames[1].Start,PackageNameIndex); });
 return Good;
}
static bool Reload(FAutomationTestBase& T)
{
 FRun R; if(!Open(T,TEXT("reload"),R)) return false;
 if(FindPackage(nullptr,*R.Package) || IFileManager::Get().FileExists(*R.Oracle) ||
  IFileManager::Get().FileExists(*R.Sidecar) || IFileManager::Get().FileExists(*R.LegacySidecar))
 { T.AddError(TEXT("Fresh unloaded World and exclusive oracle required")); return false; }
 TSharedPtr<FJsonObject> Receipt; FString Schema,Run,Stage,Project,PackageName,Phase,AuthorAttempt,Sha1,Engine; double Size=0;
 if(!ReadSmallJson(R.Receipt,Receipt) || !Receipt->TryGetStringField(TEXT("schema"),Schema) || Schema!=TEXT("owned-world-map-author-v1") ||
  !Receipt->TryGetStringField(TEXT("phase"),Phase) || Phase!=TEXT("author") || !Receipt->TryGetStringField(TEXT("run_id"),Run) || Run!=R.Id ||
  !Receipt->TryGetStringField(TEXT("stage_id"),Stage) || Stage!=R.Stage || !Receipt->TryGetStringField(TEXT("project_dir"),Project) || !FPaths::IsSamePath(Project,R.Project) ||
  !Receipt->TryGetStringField(TEXT("package"),PackageName) || PackageName!=R.Package || !Receipt->TryGetStringField(TEXT("attempt_id"),AuthorAttempt) ||
  !Hex32(AuthorAttempt) || AuthorAttempt==R.Attempt || !Receipt->TryGetStringField(TEXT("engine_version"),Engine) || Engine!=FEngineVersion::Current().ToString() ||
  !Receipt->TryGetStringField(TEXT("file_sha1"),Sha1) || !Receipt->TryGetNumberField(TEXT("file_size"),Size))
 { T.AddError(TEXT("Author phase receipt/provenance mismatch")); return false; }
 FReadGuard File; FWorldPackageTables Tables;
 if(!File.Open(R.Asset) || File.Sha1!=Sha1 || File.Bytes.Num()!=Size || !Tables.Read(File.Bytes,R.Package))
 { T.AddError(TEXT("Immutable author bytes and bounded independent tables required: ")+Tables.Error); return false; }
 UPackage* Package=nullptr;
 const FName OwnedPackageName(*R.Package);
 if(UWorld::WorldTypePreLoadMap.Contains(OwnedPackageName)) { T.AddError(TEXT("Refusing existing owned-package WorldType preload binding")); return false; }
 {
  UWorld::WorldTypePreLoadMap.Add(OwnedPackageName,EWorldType::Editor);
  ON_SCOPE_EXIT { UWorld::WorldTypePreLoadMap.Remove(OwnedPackageName); };
  Package=LoadPackage(nullptr,*R.Asset,LOAD_NoWarn);
 }
 if(UWorld::WorldTypePreLoadMap.Contains(OwnedPackageName)) { T.AddError(TEXT("Owned-package preload binding did not clear")); return false; }
 UWorld* World=Package ? FindObject<UWorld>(Package,TEXT("L_PlacedActors")) : nullptr;
 TArray<TSharedPtr<FJsonValue>> Markers,Inventory;
 if(!Placement(T,R,World,Markers,Inventory) || !BindInventory(T,R,Tables,Inventory) ||
  !File.Unchanged() || !ReaderControls(T,R,File,Tables)) return false;
 auto J=Provenance(R,TEXT("owned-world-map-native-v1"),TEXT("reload"),File);
 J->SetStringField(TEXT("author_attempt_id"),AuthorAttempt); J->SetBoolField(TEXT("fresh_package"),true);
 J->SetBoolField(TEXT("partitioned"),World->IsPartitionedWorld()); J->SetNumberField(TEXT("streaming_levels"),World->GetStreamingLevels().Num());
 J->SetBoolField(TEXT("tagged_properties"),!(Tables.Summary.GetPackageFlags()&PKG_UnversionedProperties));
 J->SetBoolField(TEXT("contains_map"),(Tables.Summary.GetPackageFlags()&PKG_ContainsMap)!=0);
 J->SetStringField(TEXT("persistent_level_path"),World->PersistentLevel->GetPathName());
 J->SetArrayField(TEXT("markers"),Markers); J->SetArrayField(TEXT("object_inventory"),Inventory);
 J->SetObjectField(TEXT("tables"),Tables.ToJson()); J->SetBoolField(TEXT("reader_negative_controls_passed"),true);
 return T.TestTrue(TEXT("Exclusive fresh-reload byte and placement oracle"),WriteExclusiveJson(R.Oracle,J));
}
}
#else
namespace UEMCP::WorldMapFixturePreparation
{
static bool UnsupportedEngine(FAutomationTestBase& Test)
{
	Test.AddError(TEXT("Unsupported World fixture engine: only the reviewed UE 5.6 package layout is supported"));
	return false;
}
static bool Author(FAutomationTestBase& Test) { return UnsupportedEngine(Test); }
static bool Reload(FAutomationTestBase& Test) { return UnsupportedEngine(Test); }
}
#endif

IMPLEMENT_COMPLEX_AUTOMATION_TEST(FUEMCPWorldMapAuthor, "UEMCP.WorldMapFixture.AuthorMap", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
void FUEMCPWorldMapAuthor::GetTests(TArray<FString>& OutBeautifiedNames, TArray<FString>& OutTestCommands) const
{
	if (UEMCP::WorldMapFixturePreparation::HasExplicitTestRequest(GetBeautifiedTestName()))
	{
		OutBeautifiedNames.Add(GetBeautifiedTestName());
		OutTestCommands.Add(FString());
	}
}
bool FUEMCPWorldMapAuthor::RunTest(const FString& Parameters) { return UEMCP::WorldMapFixturePreparation::Author(*this); }

IMPLEMENT_COMPLEX_AUTOMATION_TEST(FUEMCPWorldMapReload, "UEMCP.WorldMapFixture.ReloadAndReadOracle", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
void FUEMCPWorldMapReload::GetTests(TArray<FString>& OutBeautifiedNames, TArray<FString>& OutTestCommands) const
{
	if (UEMCP::WorldMapFixturePreparation::HasExplicitTestRequest(GetBeautifiedTestName()))
	{
		OutBeautifiedNames.Add(GetBeautifiedTestName());
		OutTestCommands.Add(FString());
	}
}
bool FUEMCPWorldMapReload::RunTest(const FString& Parameters) { return UEMCP::WorldMapFixturePreparation::Reload(*this); }
#endif
