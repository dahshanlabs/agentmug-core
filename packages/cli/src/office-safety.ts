import { inflateRawSync } from "node:zlib";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_OFFICE_XML_ELEMENTS,
  MAX_WORKBOOK_EMITTED_CELLS,
  MAX_WORKBOOK_ROWS,
  MAX_WORKBOOK_TOTAL_ROWS,
  MAX_WORKBOOK_SHEETS,
  MAX_WORKSHEET_XML_BYTES,
} from "./source-limits.js";

export type OfficeArtifactKind = "docx" | "xlsx";

type ArchiveEntryInspection = {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
  dataEnd: number;
};

export type ArchiveInspection = {
  expected: OfficeArtifactKind;
  entries: number;
  uncompressedBytes: number;
  names: string[];
  entryDetails: ArchiveEntryInspection[];
};

function hasZip64Extra(
  view: DataView,
  offset: number,
  length: number,
): boolean {
  const end = offset + length;
  let cursor = offset;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    cursor += 4;
    if (cursor + size > end) return true;
    if (id === 0x0001) return true;
    cursor += size;
  }
  return cursor !== end;
}

function safeEntryName(name: string): boolean {
  return (
    Boolean(name) &&
    !name.startsWith("/") &&
    !/^[a-z]:\//i.test(name) &&
    !name.split("/").includes("..") &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(
      name,
    )
  );
}

/**
 * Inspect ZIP metadata before an OOXML parser receives any bytes. ZIP64,
 * encryption, traversal, overlapping payloads, duplicate names, and declared
 * size/ratio bombs are rejected.
 */
export function inspectOoxmlArchive(
  bytes: Uint8Array,
  expected: OfficeArtifactKind,
): ArchiveInspection {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  let eocd = -1;
  const searchStart = Math.max(0, bytes.length - 65_557);
  for (
    let offset = bytes.length - minimumEocd;
    offset >= searchStart;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Office archive is missing its ZIP directory.");
  }

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error("Multi-disk and ZIP64 Office archives are not supported.");
  }
  if (
    entries <= 0 ||
    entries > MAX_ARCHIVE_ENTRIES ||
    eocd + minimumEocd + commentLength !== bytes.length ||
    directoryOffset + directorySize > eocd
  ) {
    throw new Error("Office archive directory is malformed or too large.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const names: string[] = [];
  const seenNames = new Set<string>();
  const entryDetails: ArchiveEntryInspection[] = [];
  let uncompressedBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new Error("Office archive contains a malformed ZIP entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entryEnd =
      offset + 46 + nameLength + extraLength + entryCommentLength;
    if (
      entryEnd > bytes.length ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      entryDisk !== 0 ||
      (flags & ~0x080e) !== 0 ||
      (method !== 0 && method !== 8) ||
      hasZip64Extra(view, offset + 46 + nameLength, extraLength)
    ) {
      throw new Error(
        "Office archive contains an encrypted, ZIP64, or unsupported entry.",
      );
    }

    const rawName = decoder
      .decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
      .replace(/\\/g, "/");
    const normalizedName = rawName.toLowerCase();
    if (!safeEntryName(rawName) || seenNames.has(normalizedName)) {
      throw new Error(
        "Office archive contains an unsafe or duplicate entry name.",
      );
    }
    seenNames.add(normalizedName);

    const entryLimit =
      normalizedName.startsWith("xl/worksheets/") &&
      normalizedName.endsWith(".xml")
        ? MAX_WORKSHEET_XML_BYTES
        : MAX_ARCHIVE_ENTRY_BYTES;
    if (uncompressedSize > entryLimit) {
      throw new Error(
        `Office archive entry '${rawName}' expands beyond the safe limit.`,
      );
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO)
    ) {
      throw new Error(
        `Office archive entry '${rawName}' has an unsafe compression ratio.`,
      );
    }

    if (
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new Error("Office archive contains a malformed local ZIP header.");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localDataOffset =
      localNameStart + localNameLength + localExtraLength;
    const localDataEnd = localDataOffset + compressedSize;
    const localName = decoder
      .decode(
        bytes.subarray(localNameStart, localNameStart + localNameLength),
      )
      .replace(/\\/g, "/");
    const usesDataDescriptor = (flags & 0x08) !== 0;
    if (
      localDataOffset > directoryOffset ||
      localDataEnd > directoryOffset ||
      localFlags !== flags ||
      localMethod !== method ||
      localName !== rawName ||
      hasZip64Extra(
        view,
        localNameStart + localNameLength,
        localExtraLength,
      ) ||
      (!usesDataDescriptor &&
        (localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize))
    ) {
      throw new Error(
        "Office archive local and central ZIP metadata do not match.",
      );
    }

    uncompressedBytes += uncompressedSize;
    if (
      !Number.isSafeInteger(uncompressedBytes) ||
      uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES
    ) {
      throw new Error("Office archive expands beyond the safe total limit.");
    }
    names.push(normalizedName);
    entryDetails.push({
      name: rawName,
      method: method as 0 | 8,
      compressedSize,
      uncompressedSize,
      dataOffset: localDataOffset,
      dataEnd: localDataEnd,
    });
    offset = entryEnd;
  }
  if (offset !== directoryOffset + directorySize) {
    throw new Error(
      "Office archive directory length does not match its entries.",
    );
  }

  const ranges = [...entryDetails].sort(
    (left, right) => left.dataOffset - right.dataOffset,
  );
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.dataOffset < ranges[index - 1]!.dataEnd) {
      throw new Error("Office archive contains overlapping entry payloads.");
    }
  }

  if (!names.includes("[content_types].xml")) {
    throw new Error("Office archive is missing [Content_Types].xml.");
  }
  if (expected === "docx" && !names.includes("word/document.xml")) {
    throw new Error("DOCX archive is missing word/document.xml.");
  }
  if (expected === "xlsx") {
    if (!names.includes("xl/workbook.xml")) {
      throw new Error("XLSX archive is missing xl/workbook.xml.");
    }
    const sheets = names.filter(
      (name) =>
        name.startsWith("xl/worksheets/") && name.endsWith(".xml"),
    ).length;
    if (sheets === 0 || sheets > MAX_WORKBOOK_SHEETS) {
      throw new Error(
        `Workbook must contain between 1 and ${MAX_WORKBOOK_SHEETS} worksheets.`,
      );
    }
  }
  if (
    names.some(
      (name) =>
        name.endsWith("/vbaproject.bin") ||
        name.startsWith("xl/externallinks/"),
    )
  ) {
    throw new Error(
      "Macro-enabled and external-link Office content is not supported.",
    );
  }
  return { expected, entries, uncompressedBytes, names, entryDetails };
}

function countStartTag(bytes: Uint8Array, tag: string): number {
  const encoded = Buffer.from(`<${tag}`, "ascii");
  let count = 0;
  outer: for (
    let offset = 0;
    offset + encoded.length <= bytes.length;
    offset += 1
  ) {
    for (let index = 0; index < encoded.length; index += 1) {
      if (bytes[offset + index] !== encoded[index]) continue outer;
    }
    const boundary = bytes[offset + encoded.length];
    if (
      boundary === undefined ||
      boundary === 0x20 ||
      boundary === 0x09 ||
      boundary === 0x0a ||
      boundary === 0x0d ||
      boundary === 0x2f ||
      boundary === 0x3e
    ) {
      count += 1;
    }
  }
  return count;
}

function countXmlElements(bytes: Uint8Array): number {
  let count = 0;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] !== 0x3c) continue;
    const next = bytes[index + 1]!;
    if (next !== 0x2f && next !== 0x21 && next !== 0x3f) count += 1;
  }
  return count;
}

function containsAsciiCaseInsensitive(
  bytes: Uint8Array,
  value: string,
): boolean {
  return Buffer.from(bytes)
    .toString("latin1")
    .toLowerCase()
    .includes(value.toLowerCase());
}

/**
 * Inflate every payload with a hard output cap and prove the real sizes match
 * the central directory. This closes forged-metadata ZIP bomb bypasses.
 */
export function verifyOoxmlArchiveInflation(
  bytes: Uint8Array,
  inspection: ArchiveInspection,
): void {
  let total = 0;
  let xmlElements = 0;
  let workbookRows = 0;
  let workbookCells = 0;
  for (const entry of inspection.entryDetails) {
    let inflated: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new Error(
          `Office archive entry '${entry.name}' has inconsistent stored sizes.`,
        );
      }
      inflated = bytes.subarray(entry.dataOffset, entry.dataEnd);
    } else {
      try {
        inflated = inflateRawSync(
          bytes.subarray(entry.dataOffset, entry.dataEnd),
          { maxOutputLength: Math.min(
            MAX_ARCHIVE_ENTRY_BYTES,
            entry.uncompressedSize + 1,
          ) },
        );
      } catch {
        throw new Error(
          `Office archive entry '${entry.name}' cannot be safely inflated.`,
        );
      }
    }
    if (inflated.byteLength !== entry.uncompressedSize) {
      throw new Error(
        `Office archive entry '${entry.name}' does not match its declared expanded size.`,
      );
    }
    total += inflated.byteLength;
    if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error("Office archive expands beyond the safe total limit.");
    }
    const normalizedName = entry.name.toLowerCase();
    if (normalizedName.endsWith(".xml") || normalizedName.endsWith(".rels")) {
      if (
        containsAsciiCaseInsensitive(inflated, "<!doctype") ||
        containsAsciiCaseInsensitive(inflated, "<!entity")
      ) {
        throw new Error("Office XML document types and entities are not supported.");
      }
      xmlElements += countXmlElements(inflated);
      if (xmlElements > MAX_OFFICE_XML_ELEMENTS) {
        throw new Error(
          `Office XML exceeds the safe ${MAX_OFFICE_XML_ELEMENTS.toLocaleString()}-element limit.`,
        );
      }
      if (
        inspection.expected === "xlsx" &&
        normalizedName.startsWith("xl/worksheets/") &&
        normalizedName.endsWith(".xml")
      ) {
        const rows = countStartTag(inflated, "row");
        const cells = countStartTag(inflated, "c");
        if (rows > MAX_WORKBOOK_ROWS) {
          throw new Error(
            `Worksheet XML exceeds the safe ${MAX_WORKBOOK_ROWS.toLocaleString()}-row limit.`,
          );
        }
        workbookRows += rows;
        workbookCells += cells;
        if (workbookRows > MAX_WORKBOOK_TOTAL_ROWS) {
          throw new Error(
            `Workbook XML exceeds the safe ${MAX_WORKBOOK_TOTAL_ROWS.toLocaleString()}-row total.`,
          );
        }
        if (workbookCells > MAX_WORKBOOK_EMITTED_CELLS) {
          throw new Error(
            `Workbook XML exceeds the complete-extraction limit of ${MAX_WORKBOOK_EMITTED_CELLS.toLocaleString()} populated cells.`,
          );
        }
      }
    }
  }
  if (total !== inspection.uncompressedBytes) {
    throw new Error(
      "Office archive does not match its declared expanded size.",
    );
  }
}
