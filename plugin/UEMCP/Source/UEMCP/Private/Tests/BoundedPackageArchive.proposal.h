// Source-only proposal; not compiled, integrated or authorized to run.
// Public UE package serializers supply field consumption; this adapter only
// supplies bounded byte access and the package FName wire representation.
#pragma once
#include "CoreMinimal.h"
#include "UObject/NameTypes.h"
#include "UObject/PackageFileSummary.h"
#include "UObject/ObjectResource.h"
#include "SummaryAllocationPreflight.proposal.h"

namespace UEMCP::WorldMapFixturePreparation
{
struct FRawNameRead
{
 int64 Start, End;
 int32 Index, Number;
 FString Resolved;
};

// Private inheritance prevents callers from passing this to arbitrary UE
// container serializers. Only the explicitly gated readers below are exposed.
class FBoundedPackageArchive final : private FArchive
{
 TArray<uint8> Bytes;
 TArray<FString> Names;
 int64 Position = 0, SectionEnd = 0;
 FSummaryAllocationBudget Budget;
 bool SummaryRead = false;
 int64 RegistryStringBytes=0;
public:
 TArray<FRawNameRead> NameReads;
 explicit FBoundedPackageArchive(const TArray<uint8>& InBytes)
 {
  SetIsLoading(true);
  SetIsPersistent(true);
  // Hint only; explicit allocation-free preflight controls allocations.
  ArMaxSerializeSize = 65536;
  if(InBytes.Num() == 0 || InBytes.Num() > 16 * 1024 * 1024) { SetError(); return; }
  Bytes=InBytes; // bounded immutable snapshot prevents post-preflight mutation
  if(!FAllocationPreflight(Bytes).Summary(Budget)) { SetError(); return; }
  SectionEnd=Budget.End;
 }
 bool HasError() const { return IsError(); }
 int64 Cursor() const { return Position; }
 int64 Limit() const { return SectionEnd; }
 const FSummaryAllocationBudget& Layout() const { return Budget; }
 bool ReadSummary(FPackageFileSummary& Summary)
 {
  if(IsError() || SummaryRead || Position != 0) { SetError(); return false; }
  // The entire count-bearing summary was checked before this first UE read.
  static_cast<FArchive&>(*this) << Summary;
  if(IsError() || Position != Budget.End) { SetError(); return false; }
  SetUEVer(Summary.GetFileVersionUE());
  SetLicenseeUEVer(Summary.GetFileVersionLicenseeUE());
  SetCustomVersions(Summary.GetCustomVersionContainer());
  SetUseUnversionedPropertySerialization(false);
  SummaryRead=true;
  return true;
 }
 bool BeginSection(int32 Start)
 {
  if(IsError() || !SummaryRead) { SetError(); return false; }
  const int32 Offsets[]={Budget.NameOffset,Budget.ImportOffset,Budget.ExportOffset,Budget.RegistryOffset};
  bool Known=false; SectionEnd=Budget.SectionEnd(Start);
  for(int32 Offset:Offsets) Known |= Offset==Start;
  if(!Known) { SetError(); return false; } Position=Start; return true;
 }
 bool ReadNameEntry(FNameEntrySerialized& Entry)
 {
  if(IsError() || !SummaryRead) return false;
  FAllocationPreflight Check(Bytes,Position,SectionEnd);
  if(!Check.String(NAME_SIZE,true) || !Check.Skip(4)) { SetError(); return false; }
  static_cast<FArchive&>(*this) << Entry;
  if(Position!=Check.Tell()) SetError(); return !IsError();
 }
 bool ReadImport(FObjectImport& Row)
 {
  if(IsError() || Names.IsEmpty() || SectionEnd-Position<40) { SetError(); return false; }
  const int64 Start=Position; static_cast<FArchive&>(*this) << Row;
  if(Position-Start!=40) SetError(); return !IsError();
 }
 bool ReadExport(FObjectExport& Row)
 {
  if(IsError() || Names.IsEmpty() || SectionEnd-Position<112) { SetError(); return false; }
  const int64 Start=Position; static_cast<FArchive&>(*this) << Row;
  if(Position-Start!=112) SetError(); return !IsError();
 }
 bool ReadCount(int32& Count,int32 Max,int32 MinimumBytes)
 {
  if(IsError() || !SummaryRead || Max<0 || Max>4096 || MinimumBytes<1) { SetError(); return false; }
  FAllocationPreflight Check(Bytes,Position,SectionEnd); Count=Check.I32();
  if(!Check.Count(Count,Max,MinimumBytes)) { SetError(); return false; }
  Position=Check.Tell(); return true; // caller must use this count before Reserve
 }
 bool ReadRegistryDependency(int64& Offset)
 {
  if(IsError() || !SummaryRead || SectionEnd-Position<8) { SetError(); return false; }
  static_cast<FArchive&>(*this) << Offset;
  if(Offset<Position+4 || Offset>SectionEnd) SetError();
  if(!IsError()) SectionEnd=Offset; // object/tag reads cannot consume dependency bytes
  return !IsError();
 }
 bool ReadString(FString& Value) { return ReadRegistryString(Value,1024); }
 bool ReadWorldActorsMetadata(FString& Value) { return ReadRegistryString(Value,65536); }
 bool SetNameMap(const TArray<FString>& InNames)
 {
  if(IsError() || !SummaryRead || InNames.Num()!=Budget.Names) { SetError(); return false; }
  for(const FString& Name:InNames) if(Name.IsEmpty() || Name.Len()>=NAME_SIZE) { SetError(); return false; }
  Names = InNames; // bounded immutable name-map snapshot
  return true;
 }
private:
 bool ReadRegistryString(FString& Value,int32 MaxChars)
 {
  if(IsError() || !SummaryRead) return false;
  FAllocationPreflight Check(Bytes,Position,SectionEnd);
  if(!Check.String(MaxChars) || Check.Tell()-Position>256*1024-RegistryStringBytes) { SetError(); return false; }
  RegistryStringBytes+=Check.Tell()-Position;
  static_cast<FArchive&>(*this) << Value;
  if(Position!=Check.Tell()) SetError(); return !IsError();
 }
 virtual int64 Tell() override { return Position; }
 virtual int64 TotalSize() override { return Bytes.Num(); }
 virtual void Seek(int64 Next) override
 {
  if(Next < 0 || Next > SectionEnd) { SetError(); return; }
  Position = Next;
 }
 virtual void Serialize(void* Out, int64 Length) override
 {
  if(IsError() || Length < 0 || Position < 0 || Position > SectionEnd || Length > SectionEnd - Position)
  { SetError(); return; }
  if(Length) FMemory::Memcpy(Out, Bytes.GetData() + Position, Length);
  Position += Length;
 }
 using FArchive::operator<<;
 virtual FArchive& operator<<(FName& Value) override
 {
  const int64 Start = Tell();
  int32 Index = INDEX_NONE, Number = INDEX_NONE;
  *this << Index; *this << Number;
  if(IsError() || !Names.IsValidIndex(Index) || Number < 0 || NameReads.Num() >= 32768)
  { SetError(); Value = NAME_None; return *this; }
  const FString& Base = Names[Index];
  if(Base.IsEmpty() || Base.Len() >= NAME_SIZE) { SetError(); Value = NAME_None; return *this; }
  // Preserve the raw numeric field rather than parsing a suffix in Base.
  Value = FName(*Base, Number, false);
  NameReads.Add({ Start, Tell(), Index, Number, Value.ToString() });
  return *this;
 }
};
}
