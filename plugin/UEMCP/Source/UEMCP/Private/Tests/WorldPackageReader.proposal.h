// Local-only source proposal. No file IO, native launch or Automation registration.
#pragma once
#include "BoundedPackageArchive.proposal.h"
#include "Dom/JsonObject.h"

namespace UEMCP::WorldMapFixturePreparation
{
inline TSharedPtr<FJsonObject> JsonObject() { return MakeShared<FJsonObject>(); }
inline TSharedPtr<FJsonValue> JsonValue(const TSharedPtr<FJsonObject>& O) { return MakeShared<FJsonValueObject>(O); }
struct FDiskObjectRow
{
 FString Name, Path, Class;
 int32 NameIndex=0, NameNumber=0, Outer=0, ClassIndex=0;
 int32 SuperIndex=0, TemplateIndex=0;
 FString ClassPackage,ClassName,PackageName;
 bool ImportOptional=false;
 TArray<FRawNameRead> RawNames;
 int64 Start=0, End=0, SerialOffset=0, SerialSize=0;
};
struct FWorldPackageTables
{
 FPackageFileSummary Summary;
 FSummaryAllocationBudget Budget;
 TArray<FString> Names;
 TArray<FObjectImport> Imports;
 TArray<FObjectExport> Exports;
 TArray<FDiskObjectRow> ImportRows, ExportRows;
 TArray<int32> SectionBoundaries;
 int64 SummaryEnd=0, NameEnd=0, ImportEnd=0, ExportEnd=0;
 TSharedPtr<FJsonObject> Registry;
 FString Error;
 bool Fail(const TCHAR* Reason) { Error=Reason; return false; }
 bool Read(const TArray<uint8>& Bytes,const FString& Package)
 {
  if(!Names.IsEmpty() || !Imports.IsEmpty() || !Exports.IsEmpty()) return Fail(TEXT("Reader instance cannot be reused"));
  FBoundedPackageArchive Ar(Bytes);
  if(!Ar.ReadSummary(Summary)) return Fail(TEXT("Summary/version/allocation preflight failed"));
  SummaryEnd=Ar.Cursor();
  const auto& B=Ar.Layout();
  Budget=B;
  SectionBoundaries.Append(B.Boundaries,B.BoundaryCount);
  if(Summary.NameCount!=B.Names || Summary.ExportCount!=B.Exports || Summary.ImportCount!=B.Imports ||
   Summary.NameOffset!=B.NameOffset || Summary.ExportOffset!=B.ExportOffset || Summary.ImportOffset!=B.ImportOffset ||
   Summary.AssetRegistryDataOffset!=B.RegistryOffset || Summary.TotalHeaderSize!=B.Header ||
   Summary.SoftObjectPathsCount!=B.SoftPaths || Summary.SoftObjectPathsOffset!=B.SoftPathOffset)
   return Fail(TEXT("Engine summary disagrees with preflight"));
  if(!Ar.BeginSection(B.NameOffset)) return Fail(TEXT("Name section"));
  Names.Reserve(B.Names); // count/span already prevalidated before Reserve
  for(int32 I=0; I<B.Names; ++I)
  {
   FNameEntrySerialized Name(ENAME_LinkerConstructor);
   if(!Ar.ReadNameEntry(Name)) return Fail(TEXT("Bounded serialized name"));
   const FString Plain=Name.GetPlainNameString();
   if(Plain.IsEmpty() || Plain.Len()>=NAME_SIZE) return Fail(TEXT("Invalid decoded name"));
   Names.Add(Plain);
  }
  NameEnd=Ar.Cursor();
  int32 NoneNames=0; if(B.SoftPaths==1) for(const FString& Name:Names) if(Name.Equals(TEXT("None"),ESearchCase::IgnoreCase)) ++NoneNames;
  if(B.SoftPaths==1 && (!Names.IsValidIndex(B.SoftPathNameIndex) || !Names[B.SoftPathNameIndex].Equals(TEXT("None"),ESearchCase::CaseSensitive) || NoneNames!=1))
   return Fail(TEXT("Only exact null soft-object path is supported"));
  if(!Ar.SetNameMap(Names) || !Ar.BeginSection(B.ImportOffset)) return Fail(TEXT("Name provenance/import section"));
  Imports.Reserve(B.Imports); ImportRows.Reserve(B.Imports);
  for(int32 I=0; I<B.Imports; ++I)
  {
   FObjectImport Row; const int32 First=Ar.NameReads.Num(); const int64 Start=Ar.Cursor();
   if(!Ar.ReadImport(Row) || Ar.NameReads.Num()!=First+4) return Fail(TEXT("Import field/cursor count"));
   const FRawNameRead& Raw=Ar.NameReads[First+2];
   if(Raw.Resolved!=Row.ObjectName.ToString()) return Fail(TEXT("Import raw FName disagreement"));
   FDiskObjectRow Fact; Fact.Name=Raw.Resolved; Fact.NameIndex=Raw.Index; Fact.NameNumber=Raw.Number;
   Fact.Outer=Row.OuterIndex.ForDebugging(); Fact.Start=Start; Fact.End=Ar.Cursor();
   Fact.ClassPackage=Row.ClassPackage.ToString(); Fact.ClassName=Row.ClassName.ToString();
   Fact.PackageName=Row.PackageName.ToString(); Fact.ImportOptional=Row.bImportOptional;
   Fact.RawNames.Append(Ar.NameReads.GetData()+First,4);
   ImportRows.Add(Fact); Imports.Add(Row);
  }
  ImportEnd=Ar.Cursor();
  if(!Ar.BeginSection(B.ExportOffset)) return Fail(TEXT("Export section"));
  Exports.Reserve(B.Exports); ExportRows.Reserve(B.Exports);
  for(int32 I=0; I<B.Exports; ++I)
  {
   FObjectExport Row; const int32 First=Ar.NameReads.Num(); const int64 Start=Ar.Cursor();
   if(!Ar.ReadExport(Row) || Ar.NameReads.Num()!=First+1) return Fail(TEXT("Export field/cursor count"));
   const FRawNameRead& Raw=Ar.NameReads[First];
   if(Raw.Resolved!=Row.ObjectName.ToString() || Row.SerialOffset<Summary.TotalHeaderSize || Row.SerialSize<0 ||
    Row.SerialOffset>Bytes.Num() || Row.SerialSize>Bytes.Num()-Row.SerialOffset ||
    Row.SuperIndex.ForDebugging()<-B.Imports || Row.SuperIndex.ForDebugging()>B.Exports ||
    Row.TemplateIndex.ForDebugging()<-B.Imports || Row.TemplateIndex.ForDebugging()>B.Exports)
    return Fail(TEXT("Export name/serial range"));
   FDiskObjectRow Fact; Fact.Name=Raw.Resolved; Fact.NameIndex=Raw.Index; Fact.NameNumber=Raw.Number;
   Fact.Outer=Row.OuterIndex.ForDebugging(); Fact.ClassIndex=Row.ClassIndex.ForDebugging();
   Fact.SuperIndex=Row.SuperIndex.ForDebugging(); Fact.TemplateIndex=Row.TemplateIndex.ForDebugging();
   Fact.RawNames.Add(Raw);
   Fact.Start=Start; Fact.End=Ar.Cursor(); Fact.SerialOffset=Row.SerialOffset; Fact.SerialSize=Row.SerialSize;
   ExportRows.Add(Fact); Exports.Add(Row);
  }
  ExportEnd=Ar.Cursor();
  if(!Resolve(Package)) return false;
  if(!Ar.BeginSection(B.RegistryOffset)) return Fail(TEXT("Registry section"));
  int64 Dependency=0;
  if(!Ar.ReadRegistryDependency(Dependency)) return Fail(TEXT("Registry dependency boundary"));
  int32 ObjectCount=0;
  if(!Ar.ReadCount(ObjectCount,4096,12) || ObjectCount<1) return Fail(TEXT("Encoded registry object count"));
  TArray<TSharedPtr<FJsonValue>> Objects; Objects.Reserve(ObjectCount);
  int32 TotalTags=0;
  for(int32 I=0; I<ObjectCount; ++I)
  {
   FString ObjectPath,ClassName; int32 TagCount=0;
   if(!Ar.ReadString(ObjectPath) || !Ar.ReadString(ClassName) || ObjectPath.IsEmpty() || ClassName.IsEmpty() ||
    !Ar.ReadCount(TagCount,64,8) || TotalTags>8192-TagCount) return Fail(TEXT("Registry string/tag budget"));
   TotalTags+=TagCount;
   TArray<TSharedPtr<FJsonValue>> Tags; Tags.Reserve(TagCount); TArray<FString> SeenKeys; SeenKeys.Reserve(TagCount);
   for(int32 Tag=0; Tag<TagCount; ++Tag)
   {
    FString Key,Value;
    if(!Ar.ReadString(Key) || Key.IsEmpty()) return Fail(TEXT("Registry tag key"));
    for(const FString& Seen:SeenKeys) if(Seen.Equals(Key,ESearchCase::CaseSensitive)) return Fail(TEXT("Duplicate registry tag key"));
    SeenKeys.Add(Key);
    const bool ActorsMetadata=I==0 && ObjectPath.Equals(TEXT("L_PlacedActors"),ESearchCase::CaseSensitive) &&
     (ClassName.Equals(TEXT("World"),ESearchCase::CaseSensitive) || ClassName.Equals(TEXT("/Script/Engine.World"),ESearchCase::CaseSensitive)) && Key.Equals(TEXT("ActorsMetaData"),ESearchCase::CaseSensitive);
    if(!(ActorsMetadata ? Ar.ReadWorldActorsMetadata(Value) : Ar.ReadString(Value))) return Fail(TEXT("Registry tag value budget"));
    auto J=JsonObject(); J->SetStringField(TEXT("key"),Key); J->SetStringField(TEXT("value"),Value); Tags.Add(JsonValue(J));
   }
   auto J=JsonObject(); J->SetStringField(TEXT("path"),ObjectPath); J->SetStringField(TEXT("class"),ClassName);
   J->SetArrayField(TEXT("tags"),Tags); Objects.Add(JsonValue(J));
  }
  if(Ar.HasError() || Ar.Cursor()>Dependency) return Fail(TEXT("Registry consumed dependency bytes"));
  FString FirstClass,FirstPath; Objects[0]->AsObject()->TryGetStringField(TEXT("class"),FirstClass);
  Objects[0]->AsObject()->TryGetStringField(TEXT("path"),FirstPath);
  if(FirstClass!=TEXT("World") && FirstClass!=TEXT("/Script/Engine.World")) return Fail(TEXT("First serialized registry class must be World"));
  if(FirstPath!=TEXT("L_PlacedActors")) return Fail(TEXT("First serialized registry path must be owned World"));
  Registry=JsonObject(); Registry->SetNumberField(TEXT("count"),ObjectCount); Registry->SetArrayField(TEXT("objects"),Objects);
  Registry->SetNumberField(TEXT("end"),Ar.Cursor()); Registry->SetNumberField(TEXT("dependency_offset"),Dependency);
  Registry->SetBoolField(TEXT("contiguous_dependency"),Ar.Cursor()==Dependency);
  return true;
 }
 bool Resolve(const FString& Package)
 {
  TMap<int32,FString> Cache; TMap<int32,int32> Depths; TSet<int32> Active; TSet<FString> Unique;
  const auto NameIsSimple=[](const FString& Name)
  { for(TCHAR C:Name) if(!FChar::IsAlnum(C) && C!=TEXT('_')) return false; return !Name.IsEmpty(); };
  TFunction<bool(int32,int32,FString&)> Path;
  Path=[&](int32 Index,int32 Depth,FString& Out)
  {
   if(Index==0 || Index<-ImportRows.Num() || Index>ExportRows.Num() || Depth>=64 || Active.Contains(Index)) return false;
   if(const FString* Found=Cache.Find(Index)) { Out=*Found; return true; }
   Active.Add(Index);
   FDiskObjectRow& Row=Index<0 ? ImportRows[-Index-1] : ExportRows[Index-1];
   int32 TotalDepth=1;
   if(Row.Outer==0)
   {
    if(Index<0)
    {
     if(!Row.Name.StartsWith(TEXT("/Script/")) || !NameIsSimple(Row.Name.Mid(8))) return false;
     Out=Row.Name;
    }
    else { if(!NameIsSimple(Row.Name)) return false; Out=Package+TEXT(".")+Row.Name; }
   }
   else
   {
    FString Parent;
    if(!NameIsSimple(Row.Name) || !Path(Row.Outer,Depth+1,Parent)) return false;
    TotalDepth=Depths[Row.Outer]+1;
    const bool Subobject=Row.Outer>0 && ExportRows[Row.Outer-1].Outer==0;
    Out=Parent+(Subobject ? TEXT(":") : TEXT("."))+Row.Name;
   }
   if(TotalDepth>64 || Out.Len()>4096) return false;
   Active.Remove(Index); Cache.Add(Index,Out); Depths.Add(Index,TotalDepth); Row.Path=Out; return true;
  };
  for(int32 I=0; I<ImportRows.Num(); ++I) { FString P; if(!Path(-I-1,0,P)) return Fail(TEXT("Import outer/path cycle or budget")); }
  for(int32 I=0; I<ExportRows.Num(); ++I)
  {
   FString P; auto& Row=ExportRows[I];
   if(!Path(I+1,0,P) || Unique.Contains(P)) return Fail(TEXT("Export outer/path cycle or duplicate")); Unique.Add(P);
   // The reviewed ordinary Actor/SceneComponent fixture uses imported native classes.
   if(Row.ClassIndex>=0 || Row.ClassIndex<-ImportRows.Num()) return Fail(TEXT("Unsupported export-defined class"));
   const auto& Class=ImportRows[-Row.ClassIndex-1];
   if(Class.Outer>=0 || ImportRows[-Class.Outer-1].Outer!=0) return Fail(TEXT("Class package outer"));
   const auto& ClassImport=Imports[-Row.ClassIndex-1]; const auto& PackageImport=Imports[-Class.Outer-1];
   if(ClassImport.ClassName!=TEXT("Class") || ClassImport.ClassPackage!=TEXT("/Script/CoreUObject") ||
    PackageImport.ClassName!=TEXT("Package") || PackageImport.ClassPackage!=TEXT("/Script/CoreUObject"))
    return Fail(TEXT("Typed native class/package imports"));
   Row.Class=Class.Path;
  }
  const FString World=Package+TEXT(".L_PlacedActors"), Level=World+TEXT(":PersistentLevel");
  int32 WorldIndex=0,WorldCount=0,LevelIndex=0,LevelCount=0;
  for(int32 I=0; I<ExportRows.Num(); ++I)
  {
   const auto& Row=ExportRows[I];
   if(Row.Class==TEXT("/Script/Engine.World")) { ++WorldCount; if(Row.Path==World && Row.Outer==0) WorldIndex=I+1; }
   if(Row.Class==TEXT("/Script/Engine.Level")) { ++LevelCount; if(Row.Path==Level) LevelIndex=I+1; }
  }
  if(WorldCount!=1 || LevelCount!=1 || WorldIndex==0 || LevelIndex==0 || ExportRows[LevelIndex-1].Outer!=WorldIndex)
   return Fail(TEXT("Exact World/Level hierarchy"));
  for(int32 R=0; R<8; ++R) for(int32 C=0; C<8; ++C)
  {
   const FString Marker=Level+FString::Printf(TEXT(".OwnedMarker_Row%d_Col%d"),R,C), Root=Marker+TEXT(".OwnedRoot");
   int32 ActorIndex=0,RootIndex=0;
   for(int32 I=0; I<ExportRows.Num(); ++I) { if(ExportRows[I].Path==Marker) ActorIndex=I+1; if(ExportRows[I].Path==Root) RootIndex=I+1; }
   if(ActorIndex==0 || RootIndex==0 || ExportRows[ActorIndex-1].Class!=TEXT("/Script/Engine.Actor") ||
    ExportRows[ActorIndex-1].Outer!=LevelIndex || ExportRows[RootIndex-1].Class!=TEXT("/Script/Engine.SceneComponent") ||
    ExportRows[RootIndex-1].Outer!=ActorIndex) return Fail(TEXT("Disk marker/root class and outer"));
  }
  return true;
 }
 TSharedPtr<FJsonObject> ToJson() const
 {
  auto J=JsonObject(), S=JsonObject();
  S->SetNumberField(TEXT("export_count"),Summary.ExportCount); S->SetNumberField(TEXT("import_count"),Summary.ImportCount);
  S->SetNumberField(TEXT("name_count"),Summary.NameCount); S->SetNumberField(TEXT("export_offset"),Summary.ExportOffset);
  S->SetNumberField(TEXT("import_offset"),Summary.ImportOffset); S->SetNumberField(TEXT("name_offset"),Summary.NameOffset);
  S->SetNumberField(TEXT("registry_offset"),Summary.AssetRegistryDataOffset); J->SetObjectField(TEXT("summary"),S);
  auto V=JsonObject(); V->SetNumberField(TEXT("ue4"),Summary.GetFileVersionUE().FileVersionUE4);
  V->SetNumberField(TEXT("ue5"),Summary.GetFileVersionUE().FileVersionUE5); V->SetNumberField(TEXT("licensee"),Summary.GetFileVersionLicenseeUE());
  V->SetNumberField(TEXT("flags"),Summary.GetPackageFlags()); V->SetNumberField(TEXT("header_size"),Summary.TotalHeaderSize);
  V->SetNumberField(TEXT("metadata_offset"),Summary.MetaDataOffset); V->SetNumberField(TEXT("depends_offset"),Summary.DependsOffset);
  V->SetNumberField(TEXT("searchable_offset"),Summary.SearchableNamesOffset); V->SetNumberField(TEXT("thumbnail_offset"),Summary.ThumbnailTableOffset);
  V->SetNumberField(TEXT("preload_count"),Summary.PreloadDependencyCount); V->SetNumberField(TEXT("preload_offset"),Summary.PreloadDependencyOffset);
  V->SetNumberField(TEXT("data_resource_offset"),Summary.DataResourceOffset);
  // Decimal strings preserve int64 payload/bulk sentinels without JSON precision loss.
  V->SetStringField(TEXT("bulk_offset"),LexToString(Summary.BulkDataStartOffset));
  V->SetStringField(TEXT("payload_offset"),LexToString(Summary.PayloadTocOffset));
  V->SetNumberField(TEXT("soft_path_count"),Budget.SoftPaths); V->SetNumberField(TEXT("soft_path_offset"),Budget.SoftPathOffset);
  V->SetNumberField(TEXT("soft_path_name_index"),Budget.SoftPathNameIndex);
  J->SetObjectField(TEXT("versions"),V);
  TArray<TSharedPtr<FJsonValue>> Bounds; for(int32 Offset:SectionBoundaries) Bounds.Add(MakeShared<FJsonValueNumber>(Offset));
  J->SetArrayField(TEXT("section_boundaries"),Bounds);
  TArray<TSharedPtr<FJsonValue>> NameJson; for(const FString& Name:Names) NameJson.Add(MakeShared<FJsonValueString>(Name));
  J->SetArrayField(TEXT("names"),NameJson);
  const auto Rows=[](const TArray<FDiskObjectRow>& Facts,bool IsExport)
  {
   TArray<TSharedPtr<FJsonValue>> Result; Result.Reserve(Facts.Num());
   for(const auto& Fact:Facts)
   {
    auto Row=JsonObject(); Row->SetStringField(TEXT("object_name"),Fact.Name); Row->SetNumberField(TEXT("name_index"),Fact.NameIndex);
    Row->SetNumberField(TEXT("name_number"),Fact.NameNumber); Row->SetNumberField(TEXT("outer_index"),Fact.Outer);
    Row->SetStringField(TEXT("native_path"),Fact.Path); Row->SetNumberField(TEXT("start"),Fact.Start); Row->SetNumberField(TEXT("end"),Fact.End);
    TArray<TSharedPtr<FJsonValue>> RawJson;
    for(const auto& Raw:Fact.RawNames) { auto N=JsonObject(); N->SetNumberField(TEXT("index"),Raw.Index); N->SetNumberField(TEXT("number"),Raw.Number);
     N->SetNumberField(TEXT("start"),Raw.Start); N->SetNumberField(TEXT("end"),Raw.End); N->SetStringField(TEXT("resolved"),Raw.Resolved); RawJson.Add(JsonValue(N)); }
    Row->SetArrayField(TEXT("raw_names"),RawJson);
    if(!IsExport) { Row->SetStringField(TEXT("class_package"),Fact.ClassPackage); Row->SetStringField(TEXT("class_name"),Fact.ClassName);
     Row->SetStringField(TEXT("package_name"),Fact.PackageName); Row->SetBoolField(TEXT("import_optional"),Fact.ImportOptional); }
    if(IsExport) { Row->SetNumberField(TEXT("class_index"),Fact.ClassIndex); Row->SetStringField(TEXT("native_class"),Fact.Class);
     Row->SetNumberField(TEXT("super_index"),Fact.SuperIndex); Row->SetNumberField(TEXT("template_index"),Fact.TemplateIndex);
     Row->SetNumberField(TEXT("serial_offset"),Fact.SerialOffset); Row->SetNumberField(TEXT("serial_size"),Fact.SerialSize); }
    Result.Add(JsonValue(Row));
   }
   return Result;
  };
  J->SetArrayField(TEXT("imports"),Rows(ImportRows,false)); J->SetArrayField(TEXT("exports"),Rows(ExportRows,true));
  J->SetNumberField(TEXT("summary_end"),SummaryEnd); J->SetNumberField(TEXT("name_end"),NameEnd);
  J->SetNumberField(TEXT("import_end"),ImportEnd); J->SetNumberField(TEXT("export_end"),ExportEnd); J->SetObjectField(TEXT("registry"),Registry);
  return J;
 }
};
}
