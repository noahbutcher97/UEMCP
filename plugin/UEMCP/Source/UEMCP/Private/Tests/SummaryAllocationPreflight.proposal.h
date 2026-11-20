// Allocation-free preflight for the installed UE5.6 current, editor-only,
// little-endian, tagged, uncooked summary. All other layouts fail closed.
#pragma once
#include "CoreMinimal.h"
#include "UObject/ObjectVersion.h"
#include "UObject/ObjectMacros.h"

namespace UEMCP::WorldMapFixturePreparation
{
static_assert(VER_UE4_AUTOMATIC_VERSION == 522 &&
 int32(EUnrealEngineObjectUE5Version::AUTOMATIC_VERSION) == 1017,
 "This preflight requires separately reviewed UE5.6 summary layout");
struct FSummaryAllocationBudget
{
 int64 End = 0;
 int32 Header = 0, Names = 0, NameOffset = 0;
 int32 Imports = 0, ImportOffset = 0, Exports = 0, ExportOffset = 0, RegistryOffset = 0;
 int32 Boundaries[20] = {}, BoundaryCount = 0;
 int64 GenerationCountWire=0, ChunkCountWire=0, PreloadCountWire=0, SoftPathCountWire=0;
 int32 SoftPaths=0, SoftPathOffset=0, SoftPathNameIndex=-1;
 int64 SectionEnd(int32 Start) const
 {
  int64 Result=Header;
  for(int32 I=0; I<BoundaryCount; ++I) if(Boundaries[I]>Start) Result=FMath::Min<int64>(Result,Boundaries[I]);
  return Result;
 }
};
class FAllocationPreflight
{
 const TArray<uint8>& Bytes;
 int64 Position = 0, Limit;
 bool Good = true;
public:
 explicit FAllocationPreflight(const TArray<uint8>& InBytes, int64 Start = 0, int64 End = -1)
  : Bytes(InBytes), Position(Start), Limit(End < 0 ? InBytes.Num() : End)
 {
  Good = Start >= 0 && Limit >= Start && Limit <= InBytes.Num();
 }
 bool Skip(int64 Length)
 {
  if(!Good || Length < 0 || Length > Limit - Position) { Good = false; return false; }
  Position += Length; return true;
 }
 uint32 U32()
 {
  const int64 Start = Position;
  if(!Skip(4)) return 0;
  return uint32(Bytes[Start]) | uint32(Bytes[Start+1]) << 8 |
   uint32(Bytes[Start+2]) << 16 | uint32(Bytes[Start+3]) << 24;
 }
 int32 I32() { const uint32 Raw = U32(); int32 Value; FMemory::Memcpy(&Value, &Raw, 4); return Value; }
 int64 I64()
 {
  const uint64 Low=U32(), High=U32(), Raw=Low | (High<<32);
  int64 Value; FMemory::Memcpy(&Value,&Raw,8); return Value;
 }
 bool Equal(int64 Actual, int64 Expected) { if(Actual != Expected) Good = false; return Good; }
 bool Count(int32 N, int32 Max, int32 MinimumBytes = 0)
 {
  if(N < 0 || N > Max || int64(N) * MinimumBytes > Limit - Position) Good = false;
  return Good;
 }
 bool Array(int32 Max, int32 WireStride)
 {
  const int32 N = I32(); return Count(N, Max, WireStride) && Skip(int64(N) * WireStride);
 }
 bool String(int32 MaxChars = 1024, bool RequireNonempty = false)
 {
  const int32 N = I32();
  // Convert to int64 before negation: INT32_MIN never wraps.
  const int64 Chars = N < 0 ? -int64(N) : int64(N), Width = N < 0 ? 2 : 1;
  if(!Good || Chars > MaxChars || (RequireNonempty && Chars < 2)) { Good = false; return false; }
  const int64 Start = Position;
  if(!Skip(Chars * Width)) return false;
  if(Chars && (Bytes[Position-1] != 0 || (Width == 2 && Bytes[Position-2] != 0))) Good = false;
  // Reject embedded nulls; engine path/name resolution must see the same length.
  for(int64 I = 0; Good && I + 1 < Chars; ++I)
   if(Bytes[Start + I*Width] == 0 && (Width == 1 || Bytes[Start + I*Width+1] == 0)) Good = false;
  return Good;
 }
 bool Summary(FSummaryAllocationBudget& Out)
 {
#if !WITH_EDITORONLY_DATA
  return false;
#endif
  if(Position != 0 || Bytes.Num() < 32 || Bytes.Num() > 16*1024*1024) return false;
  Limit = FMath::Min<int64>(Limit, 65536);
  Equal(U32(), PACKAGE_FILE_TAG); Equal(I32(), -9); Equal(I32(), 864);
  Equal(I32(), VER_UE4_AUTOMATIC_VERSION);
  Equal(I32(), int32(EUnrealEngineObjectUE5Version::AUTOMATIC_VERSION));
  Equal(I32(), 0); // licensed/unversioned/older/newer layouts are not this proposal
  if(!Good) return false;
  Skip(20); Out.Header = I32(); // SavedHash and TotalHeaderSize
  if(Out.Header <= 0 || Out.Header > Bytes.Num()) Good = false;
  Array(512, 20); // optimized custom versions: GUID + int32
  String(); const uint32 Flags = U32();
  if(!(Flags & PKG_ContainsMap) || (Flags & (PKG_Cooked | PKG_FilterEditorOnly | PKG_UnversionedProperties))) Good = false;
  Out.Names=I32(); Out.NameOffset=I32(); Count(Out.Names,4096);
  Out.SoftPathCountWire=Position; Out.SoftPaths=I32(); if(Out.SoftPaths<0 || Out.SoftPaths>1) Good=false;
  const int32 SoftObjects=I32(); Out.SoftPathOffset=SoftObjects;
  String(); // localization ID
  Equal(I32(),0); const int32 Text=I32();
  Out.Exports=I32(); Out.ExportOffset=I32(); Count(Out.Exports,4096);
  Out.Imports=I32(); Out.ImportOffset=I32(); Count(Out.Imports,4096);
  Equal(I32(),0); const int32 Cells=I32(); Equal(I32(),0); const int32 CellImports=I32();
  const int32 Metadata=I32(), Depends=I32();
  Equal(I32(),0); const int32 SoftPackages=I32();
  const int32 Searchable=I32(), Thumbnails=I32();
  Skip(16); Out.GenerationCountWire=Position; Array(32,8);
  Skip(10); String(); Skip(10); String(); // two engine versions
  Equal(U32(),0); Array(0,16); // no package compression/chunks
  U32(); Array(0,4); // package source; no additional packages to cook
  Out.RegistryOffset=I32(); const int64 Bulk=I64(); Equal(I32(),0);
  Out.ChunkCountWire=Position; Array(64,4);
  Out.PreloadCountWire=Position;
  const int32 Preloads=I32(), PreloadOffset=I32(); if(Preloads < -1 || Preloads > 4096) Good=false;
  const int32 Referenced=I32(); if(Referenced < 0 || Referenced > Out.Names) Good=false;
  const int64 Payload=I64(); const int32 DataResources=I32();
  Out.End=Position;
  if(!Good || Out.End > Out.Header || Out.Names == 0 || Out.Exports <= 100) return false;
  // Actual table spans must fit their own distinct header sections, not just EOF.
  const int32 Offsets[] = {Out.NameOffset,Out.ImportOffset,Out.ExportOffset,Out.RegistryOffset};
  for(int32 I=0; I<4; ++I)
  {
   if(Offsets[I] < Out.End || Offsets[I] >= Out.Header) return false;
   for(int32 J=0; J<I; ++J) if(Offsets[I]==Offsets[J]) return false;
  }
  for(int32 Offset:Offsets) Out.Boundaries[Out.BoundaryCount++]=Offset;
  // Empty sections may share the next section's start, but contain no bytes.
  for(int32 Offset:{Text,Cells,CellImports,SoftPackages})
   if(Offset!=0 && (Offset<Out.End || Offset>Out.Header)) return false;
  const auto AddBoundary=[&](int64 Offset,int64 Minimum,bool AllowMinusOne=false)
  {
   if(Offset==0 || (AllowMinusOne && Offset==-1)) return true;
   if(Offset<Out.End || Offset>=Out.Header || Minimum>Out.Header-Offset || Out.BoundaryCount>=20) return false;
   for(int32 I=0; I<Out.BoundaryCount; ++I) if(Out.Boundaries[I]==Offset) return false;
   Out.Boundaries[Out.BoundaryCount++]=int32(Offset); return true;
  };
  if(Out.SoftPaths==1) { if(!AddBoundary(SoftObjects,20)) return false; }
  else if(SoftObjects!=0 && (SoftObjects<Out.End || SoftObjects>Out.Header)) return false;
  if(!AddBoundary(Metadata,8) || !AddBoundary(Depends,int64(Out.Exports)*4) ||
   !AddBoundary(Searchable,4) || !AddBoundary(Thumbnails,4) || !AddBoundary(DataResources,8,true)) return false;
  if(Preloads>0)
  {
   if(PreloadOffset<Out.End || PreloadOffset>=Out.Header || !AddBoundary(PreloadOffset,int64(Preloads)*4)) return false;
  }
  else if(PreloadOffset!=0 && (PreloadOffset<Out.End || PreloadOffset>Out.Header)) return false;
  if((Bulk!=0 && (Bulk<Out.Header || Bulk>Bytes.Num())) ||
   (Payload!=-1 && Payload!=0 && (Payload<Out.Header || Payload>=Bytes.Num()))) return false;
  const auto Fits=[&](int32 Offset,int64 BytesNeeded)
  {
   const int64 End=Out.SectionEnd(Offset);
   return BytesNeeded >= 0 && BytesNeeded <= End-Offset;
  };
  for(int32 Offset:{Metadata,Depends,Searchable,Thumbnails,DataResources})
   if(Offset>0 && !Fits(Offset, Offset==Metadata ? 8 : Offset==Depends ? int64(Out.Exports)*4 : Offset==DataResources ? 8 : 4)) return false;
  if(Preloads>0 && !Fits(PreloadOffset,int64(Preloads)*4)) return false;
  if(Out.SoftPaths==1)
  {
   if(!Fits(SoftObjects,20) || Out.SectionEnd(SoftObjects)-SoftObjects!=20) return false;
   FAllocationPreflight Soft(Bytes,SoftObjects,Out.SectionEnd(SoftObjects));
   const int32 PackageName=Soft.I32(), PackageNumber=Soft.I32(), AssetName=Soft.I32(), AssetNumber=Soft.I32();
   if(PackageName<0 || PackageName>=Out.Names || PackageName!=AssetName || PackageNumber!=0 || AssetNumber!=0) return false;
   if(!Soft.Equal(Soft.I32(),0) || !Soft.IsGood() || Soft.Tell()!=int64(SoftObjects)+20) return false;
   Out.SoftPathNameIndex=PackageName; // actual name must resolve exactly None after bounded name decoding
  }
  return Fits(Out.NameOffset,int64(Out.Names)*8) && Fits(Out.ImportOffset,int64(Out.Imports)*40)
   && Fits(Out.ExportOffset,int64(Out.Exports)*112) && Fits(Out.RegistryOffset,12);
 }
 int64 Tell() const { return Position; }
 bool IsGood() const { return Good; }
};
}
