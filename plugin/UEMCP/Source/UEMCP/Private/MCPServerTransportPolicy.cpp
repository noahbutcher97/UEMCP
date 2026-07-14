// Copyright Optimum Athena. All Rights Reserved.

#include "MCPServerTransportPolicy.h"

#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
THIRD_PARTY_INCLUDES_START
#include "WinSock2.h"
THIRD_PARTY_INCLUDES_END
#include "Windows/HideWindowsPlatformTypes.h"
#elif PLATFORM_UNIX
#include <cerrno>
#endif

namespace UEMCP::Transport::Private
{
constexpr ANSICHAR FramingPrefix[] = "content-length:";
constexpr uint8 HeaderTerminator[] = {'\r', '\n', '\r', '\n'};
constexpr uint8 Utf8Bom[] = {0xef, 0xbb, 0xbf};

struct FHeaderLine
{
	int32 Start = 0;
	int32 End = 0;
};

bool IsJsonWhitespace(uint8 Byte)
{
	return Byte == 0x20 || Byte == 0x09 || Byte == 0x0a || Byte == 0x0d;
}

uint8 AsciiLower(uint8 Byte)
{
	return Byte >= 'A' && Byte <= 'Z' ? Byte + ('a' - 'A') : Byte;
}

bool HasHeaderTerminator(const TArray<uint8>& Header, int32 HeaderBytes)
{
	if (HeaderBytes < UE_ARRAY_COUNT(HeaderTerminator))
	{
		return false;
	}
	const int32 Start = HeaderBytes - UE_ARRAY_COUNT(HeaderTerminator);
	for (int32 Index = 0; Index < UE_ARRAY_COUNT(HeaderTerminator); ++Index)
	{
		if (Header[Start + Index] != HeaderTerminator[Index])
		{
			return false;
		}
	}
	return true;
}

bool IsContentLengthName(const uint8* Header, const FHeaderLine& Line, int32 Colon)
{
	constexpr int32 NameLength = UE_ARRAY_COUNT(FramingPrefix) - 2;
	if (Colon - Line.Start != NameLength)
	{
		return false;
	}
	for (int32 Index = 0; Index < NameLength; ++Index)
	{
		if (AsciiLower(Header[Line.Start + Index]) != static_cast<uint8>(FramingPrefix[Index]))
		{
			return false;
		}
	}
	return true;
}

bool IsHeaderNameByte(uint8 Byte)
{
	return (Byte >= 'A' && Byte <= 'Z') || (Byte >= 'a' && Byte <= 'z')
		|| (Byte >= '0' && Byte <= '9') || Byte == '-';
}

FString ParseHeader(const uint8* Header, int32 HeaderBytes, int64& OutBodyLength)
{
	const int32 BlockEnd = HeaderBytes - UE_ARRAY_COUNT(HeaderTerminator);
	if (BlockEnd <= 0)
	{
		return TEXT("invalid_header");
	}

	for (int32 Index = 0; Index < BlockEnd; ++Index)
	{
		if (Header[Index] > 0x7f)
		{
			return TEXT("invalid_header");
		}
	}

	TArray<FHeaderLine, TInlineAllocator<8>> Lines;
	int32 LineStart = 0;
	for (int32 Index = 0; Index < BlockEnd; ++Index)
	{
		if (Header[Index] == '\r')
		{
			if (Index + 1 >= BlockEnd || Header[Index + 1] != '\n')
			{
				return TEXT("invalid_header");
			}
			Lines.Add({LineStart, Index});
			LineStart = Index + 2;
			++Index;
		}
		else if (Header[Index] == '\n')
		{
			return TEXT("invalid_header");
		}
	}
	Lines.Add({LineStart, BlockEnd});
	if (Lines.IsEmpty() || Lines[0].Start == Lines[0].End)
	{
		return TEXT("invalid_header");
	}

	const FHeaderLine& FirstLine = Lines[0];
	int32 FirstColon = INDEX_NONE;
	for (int32 Index = FirstLine.Start; Index < FirstLine.End; ++Index)
	{
		if (Header[Index] == ':')
		{
			FirstColon = Index;
			break;
		}
	}
	if (FirstColon == INDEX_NONE || !IsContentLengthName(Header, FirstLine, FirstColon))
	{
		return TEXT("invalid_header");
	}

	int32 ValueStart = FirstColon + 1;
	int32 ValueEnd = FirstLine.End;
	while (ValueStart < ValueEnd && (Header[ValueStart] == ' ' || Header[ValueStart] == '\t'))
	{
		++ValueStart;
	}
	while (ValueEnd > ValueStart && (Header[ValueEnd - 1] == ' ' || Header[ValueEnd - 1] == '\t'))
	{
		--ValueEnd;
	}
	if (ValueStart == ValueEnd)
	{
		return TEXT("invalid_content_length");
	}

	int64 ParsedLength = 0;
	for (int32 Index = ValueStart; Index < ValueEnd; ++Index)
	{
		if (Header[Index] < '0' || Header[Index] > '9')
		{
			return TEXT("invalid_content_length");
		}
		const int64 Digit = Header[Index] - '0';
		if (ParsedLength > (MAX_int64 - Digit) / 10)
		{
			return TEXT("content_length_overflow");
		}
		ParsedLength = ParsedLength * 10 + Digit;
	}

	for (int32 LineIndex = 1; LineIndex < Lines.Num(); ++LineIndex)
	{
		const FHeaderLine& Line = Lines[LineIndex];
		int32 Colon = INDEX_NONE;
		for (int32 Index = Line.Start; Index < Line.End; ++Index)
		{
			if (Header[Index] == ':')
			{
				Colon = Index;
				break;
			}
		}
		if (Colon <= Line.Start || IsContentLengthName(Header, Line, Colon))
		{
			return TEXT("invalid_header");
		}
		for (int32 Index = Line.Start; Index < Colon; ++Index)
		{
			if (!IsHeaderNameByte(Header[Index]))
			{
				return TEXT("invalid_header");
			}
		}
		for (int32 Index = Colon + 1; Index < Line.End; ++Index)
		{
			const uint8 Byte = Header[Index];
			if (Byte != '\t' && (Byte < 0x20 || Byte > 0x7e))
			{
				return TEXT("invalid_header");
			}
		}
	}

	OutBodyLength = ParsedLength;
	return {};
}

bool IsPartialBom(const TArray<uint8>& Body)
{
	return (Body.Num() == 1 && Body[0] == Utf8Bom[0])
		|| (Body.Num() == 2 && Body[0] == Utf8Bom[0] && Body[1] == Utf8Bom[1]);
}

bool StartsWithBom(const TArray<uint8>& Body, int32 Offset)
{
	return Offset >= 0 && Offset <= Body.Num() - UE_ARRAY_COUNT(Utf8Bom)
		&& Body[Offset] == Utf8Bom[0] && Body[Offset + 1] == Utf8Bom[1] && Body[Offset + 2] == Utf8Bom[2];
}

bool StartsWithPartialBom(const TArray<uint8>& Body, int32 Offset)
{
	const int32 Remaining = Body.Num() - Offset;
	return (Remaining == 1 && Body[Offset] == Utf8Bom[0])
		|| (Remaining == 2 && Body[Offset] == Utf8Bom[0] && Body[Offset + 1] == Utf8Bom[1]);
}

bool IsStrictUtf8(const uint8* Data, int32 NumBytes)
{
	int32 Index = 0;
	while (Index < NumBytes)
	{
		const uint8 Lead = Data[Index];
		if (Lead <= 0x7f)
		{
			++Index;
			continue;
		}

		if (Lead >= 0xc2 && Lead <= 0xdf)
		{
			if (Index + 1 >= NumBytes || Data[Index + 1] < 0x80 || Data[Index + 1] > 0xbf)
			{
				return false;
			}
			Index += 2;
			continue;
		}

		if (Lead >= 0xe0 && Lead <= 0xef)
		{
			if (Index + 2 >= NumBytes)
			{
				return false;
			}
			const uint8 Second = Data[Index + 1];
			const uint8 Third = Data[Index + 2];
			const bool bSecondValid = Lead == 0xe0 ? Second >= 0xa0 && Second <= 0xbf
				: Lead == 0xed ? Second >= 0x80 && Second <= 0x9f
				: Second >= 0x80 && Second <= 0xbf;
			if (!bSecondValid || Third < 0x80 || Third > 0xbf)
			{
				return false;
			}
			Index += 3;
			continue;
		}

		if (Lead >= 0xf0 && Lead <= 0xf4)
		{
			if (Index + 3 >= NumBytes)
			{
				return false;
			}
			const uint8 Second = Data[Index + 1];
			const bool bSecondValid = Lead == 0xf0 ? Second >= 0x90 && Second <= 0xbf
				: Lead == 0xf4 ? Second >= 0x80 && Second <= 0x8f
				: Second >= 0x80 && Second <= 0xbf;
			if (!bSecondValid
				|| Data[Index + 2] < 0x80 || Data[Index + 2] > 0xbf
				|| Data[Index + 3] < 0x80 || Data[Index + 3] > 0xbf)
			{
				return false;
			}
			Index += 4;
			continue;
		}

		return false;
	}
	return true;
}

bool HasTruncatedUtf8Tail(const TArray<uint8>& Body)
{
	if (Body.IsEmpty())
	{
		return false;
	}
	int32 Continuations = 0;
	int32 Index = Body.Num() - 1;
	while (Index >= 0 && Body[Index] >= 0x80 && Body[Index] <= 0xbf)
	{
		++Continuations;
		--Index;
	}
	if (Index < 0)
	{
		return false;
	}
	const uint8 Lead = Body[Index];
	const int32 Expected = Lead >= 0xc2 && Lead <= 0xdf ? 1
		: Lead >= 0xe0 && Lead <= 0xef ? 2
		: Lead >= 0xf0 && Lead <= 0xf4 ? 3
		: 0;
	return Expected > Continuations;
}

FString ValidateObjectBoundary(const TArray<uint8>& Body, int32 StartOffset)
{
	int32 Index = StartOffset;
	while (Index < Body.Num() && IsJsonWhitespace(Body[Index]))
	{
		++Index;
	}
	if (Index >= Body.Num() || Body[Index] != '{')
	{
		return {};
	}

	TArray<uint8, TInlineAllocator<32>> Delimiters;
	Delimiters.Add('{');
	bool bInString = false;
	bool bEscaped = false;
	for (++Index; Index < Body.Num(); ++Index)
	{
		const uint8 Byte = Body[Index];
		if (bInString)
		{
			if (bEscaped) bEscaped = false;
			else if (Byte == '\\') bEscaped = true;
			else if (Byte == '"') bInString = false;
			continue;
		}
		if (Byte == '"')
		{
			bInString = true;
			continue;
		}
		if (Byte == '{' || Byte == '[')
		{
			Delimiters.Add(Byte);
			continue;
		}
		if (Byte != '}' && Byte != ']')
		{
			continue;
		}
		const uint8 ExpectedOpen = Byte == '}' ? '{' : '[';
		if (Delimiters.IsEmpty() || Delimiters.Last() != ExpectedOpen)
		{
			return TEXT("mismatched_delimiter");
		}
		Delimiters.Pop(EAllowShrinking::No);
		if (!Delimiters.IsEmpty())
		{
			continue;
		}
		for (++Index; Index < Body.Num(); ++Index)
		{
			if (!IsJsonWhitespace(Body[Index]))
			{
				return TEXT("trailing_bytes");
			}
		}
		return {};
	}
	return {};
}

bool HasElidedJsonValue(const TArray<uint8>& Body, int32 StartOffset)
{
	bool bInString = false;
	bool bEscaped = false;
	for (int32 Index = StartOffset; Index < Body.Num(); ++Index)
	{
		const uint8 Byte = Body[Index];
		if (bInString)
		{
			if (bEscaped) bEscaped = false;
			else if (Byte == '\\') bEscaped = true;
			else if (Byte == '"') bInString = false;
			continue;
		}
		if (Byte == '"')
		{
			bInString = true;
			continue;
		}
		if (Byte != ':' && Byte != ',')
		{
			continue;
		}

		int32 Next = Index + 1;
		while (Next < Body.Num() && IsJsonWhitespace(Body[Next]))
		{
			++Next;
		}
		if (Next >= Body.Num() || Body[Next] == ',' || Body[Next] == '}' || Body[Next] == ']')
		{
			return true;
		}
	}
	return false;
}
}

namespace UEMCP::Transport
{
FMCPReceiveAttempt ReceiveWithCapturedError(FSocket* Socket, uint8* Buffer, int32 BufferSize)
{
	ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
	if (Socket == nullptr || SocketSubsystem == nullptr)
	{
		return {false, 0, SE_SYSTEM};
	}

	FMCPReceiveAttempt Attempt;

#if PLATFORM_WINDOWS
	WSASetLastError(0);
	Attempt.bSucceeded = Socket->Recv(Buffer, BufferSize, Attempt.BytesRead);
	if (!Attempt.bSucceeded)
	{
		const int32 NativeErrorCode = WSAGetLastError();
		Attempt.Error = SocketSubsystem->TranslateErrorCode(NativeErrorCode);
	}
#elif PLATFORM_UNIX
	errno = 0;
	Attempt.bSucceeded = Socket->Recv(Buffer, BufferSize, Attempt.BytesRead);
	if (!Attempt.bSucceeded)
	{
		const int32 NativeErrorCode = errno;
		Attempt.Error = SocketSubsystem->TranslateErrorCode(NativeErrorCode);
	}
#else
	Attempt.bSucceeded = Socket->Recv(Buffer, BufferSize, Attempt.BytesRead);
	if (!Attempt.bSucceeded)
	{
		Attempt.Error = SE_SYSTEM;
	}
#endif

	return Attempt;
}

EMCPReceiveAction ClassifyReceiveAttempt(const FMCPReceiveAttempt& Attempt)
{
	const bool bRetryable = Attempt.Error == SE_EWOULDBLOCK || Attempt.Error == SE_EINTR;
	if (Attempt.BytesRead < 0)
	{
		return bRetryable ? EMCPReceiveAction::Wait : EMCPReceiveAction::SocketError;
	}

	if (Attempt.bSucceeded)
	{
		return Attempt.BytesRead > 0
			? EMCPReceiveAction::ConsumeData
			: EMCPReceiveAction::Wait;
	}

	if (bRetryable)
	{
		return EMCPReceiveAction::Wait;
	}

	return Attempt.BytesRead == 0 && Attempt.Error == SE_NO_ERROR
		? EMCPReceiveAction::PeerClosed
		: EMCPReceiveAction::SocketError;
}

struct FMCPRequestDecoder::FImpl
{
	explicit FImpl(FMCPDecoderPolicy InPolicy)
	{
		Policy.MaxHeader = FMath::Clamp(InPolicy.MaxHeader, 1, MaxHeaderBytes);
		Policy.MaxBody = FMath::Clamp<int64>(InPolicy.MaxBody, 0, MaxRequestBodyBytes);
		Header.SetNumUninitialized(Policy.MaxHeader);
		RefreshPendingSnapshot();
	}

	const FMCPDecodeSnapshot& Consume(const uint8* Data, int32 NumBytes)
	{
		if (Snapshot.Status != EMCPDecodeStatus::Pending)
		{
			return Snapshot;
		}
		if (NumBytes < 0 || (NumBytes > 0 && Data == nullptr))
		{
			SetMalformed(TEXT("invalid_chunk"));
			return Snapshot;
		}
		if (NumBytes == 0)
		{
			return Snapshot;
		}
		if (Snapshot.BytesReceived > MAX_int64 - NumBytes)
		{
			SetMalformed(TEXT("byte_count_overflow"));
			return Snapshot;
		}

		Snapshot.BytesReceived += NumBytes;
		if (Snapshot.Framing == EMCPFramingMode::Undecided)
		{
			ConsumeUndecided(Data, NumBytes);
		}
		else if (Snapshot.Framing == EMCPFramingMode::Framed)
		{
			ConsumeFramed(Data, NumBytes, 0);
		}
		else
		{
			ConsumeLegacy(Data, NumBytes);
		}

		if (Snapshot.Status == EMCPDecodeStatus::Pending)
		{
			RefreshPendingSnapshot();
		}
		return Snapshot;
	}

	FString DescribeTerminalEof() const
	{
		if (Snapshot.Status != EMCPDecodeStatus::Pending)
		{
			return Snapshot.ReasonCode;
		}
		if (Snapshot.BytesReceived == 0)
		{
			return TEXT("no_request");
		}
		if (Snapshot.Framing == EMCPFramingMode::Undecided)
		{
			return TEXT("incomplete_prefix");
		}
		if (Snapshot.Framing == EMCPFramingMode::Framed && !bHeaderComplete)
		{
			return TEXT("incomplete_header");
		}
		if ((Snapshot.Framing == EMCPFramingMode::Legacy && LegacyBomProgress > 0)
			|| Private::IsPartialBom(Body))
		{
			return TEXT("partial_bom");
		}
		if (Private::HasTruncatedUtf8Tail(Body))
		{
			return TEXT("truncated_utf8");
		}
		return Snapshot.Framing == EMCPFramingMode::Framed
			? TEXT("incomplete_body")
			: TEXT("incomplete_legacy");
	}

	void RefreshPendingSnapshot()
	{
		Snapshot.Status = EMCPDecodeStatus::Pending;
		Snapshot.Object.Reset();
		Snapshot.ReasonCode.Reset();
	}

	void SetMalformed(const TCHAR* Reason)
	{
		Snapshot.Status = EMCPDecodeStatus::Malformed;
		Snapshot.Object.Reset();
		Snapshot.ReasonCode = Reason;
	}

	void SetTooLarge()
	{
		Snapshot.Status = EMCPDecodeStatus::TooLarge;
		Snapshot.Object.Reset();
		Snapshot.ReasonCode = TEXT("body_too_large");
	}

	void ConsumeUndecided(const uint8* Data, int32 NumBytes)
	{
		constexpr int32 PrefixBytes = UE_ARRAY_COUNT(Private::FramingPrefix) - 1;
		for (int32 Index = 0; Index < NumBytes; ++Index)
		{
			Header[HeaderBytes++] = Data[Index];
			if (Private::AsciiLower(Data[Index])
				!= static_cast<uint8>(Private::FramingPrefix[PrefixBytesMatched]))
			{
				Snapshot.Framing = EMCPFramingMode::Legacy;
				ConsumeLegacy(Header.GetData(), HeaderBytes);
				if (Snapshot.Status == EMCPDecodeStatus::Pending && Index + 1 < NumBytes)
				{
					ConsumeLegacy(Data + Index + 1, NumBytes - Index - 1);
				}
				return;
			}

			++PrefixBytesMatched;
			if (PrefixBytesMatched == PrefixBytes)
			{
				Snapshot.Framing = EMCPFramingMode::Framed;
				if (Index + 1 < NumBytes)
				{
					ConsumeFramed(Data, NumBytes, Index + 1);
				}
				return;
			}
			if (HeaderBytes == Policy.MaxHeader)
			{
				Snapshot.Framing = EMCPFramingMode::Framed;
				SetMalformed(TEXT("header_too_large"));
				return;
			}
		}
	}

	void ConsumeFramed(const uint8* Data, int32 NumBytes, int32 StartIndex)
	{
		if (bHeaderComplete)
		{
			ConsumeFramedBody(Data + StartIndex, NumBytes - StartIndex);
			return;
		}

		for (int32 Index = StartIndex; Index < NumBytes; ++Index)
		{
			if (HeaderBytes >= Policy.MaxHeader)
			{
				SetMalformed(TEXT("header_too_large"));
				return;
			}
			Header[HeaderBytes++] = Data[Index];
			if (Private::HasHeaderTerminator(Header, HeaderBytes))
			{
				int64 DeclaredLength = -1;
				const FString HeaderError = Private::ParseHeader(Header.GetData(), HeaderBytes, DeclaredLength);
				if (!HeaderError.IsEmpty())
				{
					SetMalformed(*HeaderError);
					return;
				}

				bHeaderComplete = true;
				Snapshot.DeclaredBodyLength = DeclaredLength;
				if (DeclaredLength > Policy.MaxBody)
				{
					SetTooLarge();
					return;
				}
				if (DeclaredLength > MAX_int64 - HeaderBytes)
				{
					SetMalformed(TEXT("content_length_overflow"));
					return;
				}
				const int64 ExpectedFrameBytes = HeaderBytes + DeclaredLength;
				if (Snapshot.BytesReceived > ExpectedFrameBytes)
				{
					SetMalformed(TEXT("trailing_bytes"));
					return;
				}
				if (DeclaredLength > 0)
				{
					Body.Reserve(static_cast<int32>(DeclaredLength));
				}

				const int32 BodyStart = Index + 1;
				const int32 BufferedBodyBytes = NumBytes - BodyStart;
				if (BufferedBodyBytes > 0)
				{
					AppendFramedBody(Data + BodyStart, BufferedBodyBytes);
				}
				if (Snapshot.Status == EMCPDecodeStatus::Pending && Body.Num() == DeclaredLength)
				{
					FinalizeBody();
				}
				return;
			}
			if (HeaderBytes == Policy.MaxHeader)
			{
				SetMalformed(TEXT("header_too_large"));
				return;
			}
		}
	}

	void ConsumeFramedBody(const uint8* Data, int32 NumBytes)
	{
		const int64 Remaining = Snapshot.DeclaredBodyLength - Body.Num();
		if (NumBytes > Remaining)
		{
			SetMalformed(TEXT("trailing_bytes"));
			return;
		}
		if (NumBytes > 0)
		{
			AppendFramedBody(Data, NumBytes);
		}
		if (Snapshot.Status == EMCPDecodeStatus::Pending && Body.Num() == Snapshot.DeclaredBodyLength)
		{
			FinalizeBody();
		}
	}

	void AppendFramedBody(const uint8* Data, int32 NumBytes)
	{
		if (NumBytes < 0 || Body.Num() > Policy.MaxBody - NumBytes)
		{
			SetTooLarge();
			return;
		}
		Body.Append(Data, NumBytes);
	}

	void ConsumeLegacy(const uint8* Data, int32 NumBytes)
	{
		for (int32 Index = 0; Index < NumBytes; ++Index)
		{
			if (Body.Num() >= Policy.MaxBody)
			{
				SetTooLarge();
				return;
			}
			Body.Add(Data[Index]);
			const int64 Position = LegacyBytesScanned++;
			ScanLegacyByte(Data[Index], Position);
			if (Snapshot.Status != EMCPDecodeStatus::Pending)
			{
				return;
			}
		}

		if (bLegacyRootComplete)
		{
			FinalizeBody();
		}
	}

	void ScanLegacyByte(uint8 Byte, int64 Position)
	{
		if (bLegacyBeforeRoot)
		{
			ScanLegacyBeforeRoot(Byte, Position);
			return;
		}
		if (bLegacyRootComplete)
		{
			if (!Private::IsJsonWhitespace(Byte))
			{
				SetMalformed(TEXT("trailing_bytes"));
			}
			return;
		}
		if (bLegacyInString)
		{
			if (bLegacyEscaped) bLegacyEscaped = false;
			else if (Byte == '\\') bLegacyEscaped = true;
			else if (Byte == '"') bLegacyInString = false;
			return;
		}
		if (Byte == '"')
		{
			bLegacyInString = true;
			return;
		}
		if (Byte == '{' || Byte == '[')
		{
			LegacyDelimiters.Add(Byte);
			return;
		}
		if (Byte != '}' && Byte != ']')
		{
			return;
		}
		const uint8 ExpectedOpen = Byte == '}' ? '{' : '[';
		if (LegacyDelimiters.IsEmpty() || LegacyDelimiters.Last() != ExpectedOpen)
		{
			SetMalformed(TEXT("mismatched_delimiter"));
			return;
		}
		LegacyDelimiters.Pop(EAllowShrinking::No);
		bLegacyRootComplete = LegacyDelimiters.IsEmpty();
	}

	void ScanLegacyBeforeRoot(uint8 Byte, int64 Position)
	{
		if (LegacyBomProgress == 1)
		{
			if (Byte != Private::Utf8Bom[1]) SetMalformed(TEXT("invalid_bom"));
			else LegacyBomProgress = 2;
			return;
		}
		if (LegacyBomProgress == 2)
		{
			if (Byte != Private::Utf8Bom[2]) SetMalformed(TEXT("invalid_bom"));
			else
			{
				LegacyBomProgress = 0;
				bLegacyBomSeen = true;
			}
			return;
		}
		if (Byte == Private::Utf8Bom[0])
		{
			if (Position != 0 || bLegacyBomSeen) SetMalformed(TEXT("invalid_bom"));
			else LegacyBomProgress = 1;
			return;
		}
		if (Private::IsJsonWhitespace(Byte))
		{
			return;
		}
		if (Byte != '{')
		{
			SetMalformed(TEXT("root_not_object"));
			return;
		}
		bLegacyBeforeRoot = false;
		LegacyDelimiters.Add(Byte);
	}

	void FinalizeBody()
	{
		if (Private::IsPartialBom(Body))
		{
			SetMalformed(TEXT("invalid_bom"));
			return;
		}

		int32 BodyOffset = 0;
		if (Private::StartsWithBom(Body, 0))
		{
			BodyOffset = UE_ARRAY_COUNT(Private::Utf8Bom);
		}
		int32 RootOffset = BodyOffset;
		while (RootOffset < Body.Num() && Private::IsJsonWhitespace(Body[RootOffset]))
		{
			++RootOffset;
		}
		if (Private::StartsWithBom(Body, RootOffset) || Private::StartsWithPartialBom(Body, RootOffset))
		{
			SetMalformed(TEXT("invalid_bom"));
			return;
		}
		if (!Private::IsStrictUtf8(Body.GetData(), Body.Num()))
		{
			SetMalformed(TEXT("invalid_utf8"));
			return;
		}

		const FString BoundaryError = Private::ValidateObjectBoundary(Body, BodyOffset);
		if (!BoundaryError.IsEmpty())
		{
			SetMalformed(*BoundaryError);
			return;
		}

		FString JsonText;
		const int32 JsonBytes = Body.Num() - BodyOffset;
		if (JsonBytes > 0)
		{
			const FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Body.GetData() + BodyOffset), JsonBytes);
			JsonText = FString(Converter.Length(), Converter.Get());
		}
		++JsonParseCount;
		TSharedPtr<FJsonValue> RootValue;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
		if (!FJsonSerializer::Deserialize(Reader, RootValue) || !RootValue.IsValid())
		{
			SetMalformed(RootOffset < Body.Num() && Body[RootOffset] != '{'
				? TEXT("root_not_object")
				: TEXT("invalid_json"));
			return;
		}
		if (Private::HasElidedJsonValue(Body, BodyOffset))
		{
			SetMalformed(TEXT("invalid_json"));
			return;
		}
		if (RootValue->Type != EJson::Object || !RootValue->AsObject().IsValid())
		{
			SetMalformed(TEXT("root_not_object"));
			return;
		}

		Snapshot.Status = EMCPDecodeStatus::Complete;
		Snapshot.Object = RootValue->AsObject();
		Snapshot.ReasonCode.Reset();
	}

	FMCPDecoderPolicy Policy;
	FMCPDecodeSnapshot Snapshot;
	TArray<uint8> Header;
	TArray<uint8> Body;
	int32 HeaderBytes = 0;
	int32 PrefixBytesMatched = 0;
	bool bHeaderComplete = false;
	int32 LegacyBomProgress = 0;
	bool bLegacyBomSeen = false;
	bool bLegacyBeforeRoot = true;
	bool bLegacyRootComplete = false;
	TArray<uint8> LegacyDelimiters;
	bool bLegacyInString = false;
	bool bLegacyEscaped = false;

	int32 JsonParseCount = 0;
	int64 LegacyBytesScanned = 0;
};

FMCPRequestDecoder::FMCPRequestDecoder(FMCPDecoderPolicy InPolicy)
	: Impl(MakeUnique<FImpl>(InPolicy))
{
}

FMCPRequestDecoder::~FMCPRequestDecoder() = default;

const FMCPDecodeSnapshot& FMCPRequestDecoder::Consume(const uint8* Data, int32 NumBytes)
{
	return Impl->Consume(Data, NumBytes);
}

const FMCPDecodeSnapshot& FMCPRequestDecoder::Snapshot() const
{
	return Impl->Snapshot;
}

FString FMCPRequestDecoder::DescribeTerminalEof() const
{
	return Impl->DescribeTerminalEof();
}

#if WITH_DEV_AUTOMATION_TESTS
int32 FMCPRequestDecoder::GetJsonParseCountForTests() const
{
	return Impl->JsonParseCount;
}

int64 FMCPRequestDecoder::GetLegacyBytesScannedForTests() const
{
	return Impl->LegacyBytesScanned;
}
#endif
}
