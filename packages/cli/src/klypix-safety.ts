import { inflateRawSync } from "node:zlib";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_KLYPIX_ASSET_BYTES,
  MAX_KLYPIX_CANVAS_BYTES,
  MAX_KLYPIX_ITEM_BYTES,
  MAX_KLYPIX_ITEM_FILES,
  MAX_KLYPIX_MANIFEST_BYTES,
  MAX_KLYPIX_RAW_BYTES,
} from "./source-limits.js";

export type KlypixArchiveEntry = {
  name: string;
  normalizedName: string;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
  directory: boolean;
};

export type KlypixArchiveInspection = {
  entries: KlypixArchiveEntry[];
  uncompressedBytes: number;
};

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/\\/g, "/");
  } catch {
    throw new Error("Klypix archive contains a non-UTF-8 entry name.");
  }
}

function safeEntryName(name: string): boolean {
  return (
    Boolean(name) &&
    !name.startsWith("/") &&
    !/^[a-z]:\//i.test(name) &&
    !name.split("/").includes("..") &&
    !name.includes("\u0000")
  );
}

function entryLimit(name: string, directory: boolean): number {
  if (directory) return 0;
  if (name === "manifest.json") return MAX_KLYPIX_MANIFEST_BYTES;
  if (name === "canvas.json") return MAX_KLYPIX_CANVAS_BYTES;
  if (
    /^assets\/(?:files|images)\/[a-z0-9_]{2}\/[a-z0-9][a-z0-9_.:-]{0,199}(?:\.[a-z0-9]{1,8})?$/.test(
      name,
    ) ||
    /^assets\/thumbs\/[a-z0-9][a-z0-9_.:-]{0,199}\.png$/.test(name)
  ) {
    return MAX_KLYPIX_ASSET_BYTES;
  }
  if (
    /^items\/[a-z0-9_]{2}\/[a-z0-9][a-z0-9_.:-]{0,199}\.json$/.test(
      name,
    )
  ) {
    return MAX_KLYPIX_ITEM_BYTES;
  }
  return MAX_ARCHIVE_ENTRY_BYTES;
}

function expectedEntryName(name: string, directory: boolean): boolean {
  if (directory) {
    return (
      name === "items/" ||
      /^items\/[a-z0-9_]{2}\/$/.test(name) ||
      name === "assets/" ||
      /^assets\/(?:files|images)\/$/.test(name) ||
      /^assets\/(?:files|images)\/[a-z0-9_]{2}\/$/.test(name) ||
      name === "assets/thumbs/"
    );
  }
  return (
    name === "manifest.json" ||
    name === "canvas.json" ||
    /^items\/[a-z0-9_]{2}\/[a-z0-9][a-z0-9_.:-]{0,199}\.json$/.test(
      name,
    ) ||
    /^assets\/(?:files|images)\/[a-z0-9_]{2}\/[a-z0-9][a-z0-9_.:-]{0,199}(?:\.[a-z0-9]{1,8})?$/.test(
      name,
    ) ||
    /^assets\/thumbs\/[a-z0-9][a-z0-9_.:-]{0,199}\.png$/.test(name)
  );
}

/**
 * Validate the complete v4 .klypix ZIP directory before any payload is
 * decompressed. Unsupported versions/layouts, ZIP64, encryption, duplicate or
 * traversal names, overlapping entries, and declared size/ratio bombs fail
 * closed. Binary assets are permitted by the package format but are never
 * returned to the knowledge extractor.
 */
export function inspectKlypixArchive(
  bytes: Uint8Array,
): KlypixArchiveInspection {
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAX_KLYPIX_RAW_BYTES
  ) {
    throw new Error(
      `Klypix package must be 1..${MAX_KLYPIX_RAW_BYTES.toLocaleString()} raw bytes.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  const eocd = bytes.length - minimumEocd;
  if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) {
    throw new Error("Klypix file is not a ZIP package.");
  }

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error("Multi-disk and ZIP64 Klypix packages are not supported.");
  }
  if (
    entryCount <= 0 ||
    entryCount > MAX_ARCHIVE_ENTRIES ||
    commentLength !== 0 ||
    eocd + minimumEocd !== bytes.length ||
    directoryOffset + directorySize !== eocd
  ) {
    throw new Error(
      "Klypix ZIP directory is malformed, commented, trailing, or too large.",
    );
  }

  const entries: KlypixArchiveEntry[] = [];
  const seenNames = new Set<string>();
  let uncompressedBytes = 0;
  let itemFiles = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > eocd ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new Error("Klypix package contains a malformed ZIP entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
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
      entryEnd > eocd ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      entryDisk !== 0 ||
      flags !== 0 ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      (method !== 0 && method !== 8) ||
      nameLength === 0
    ) {
      throw new Error(
        "Klypix package entries must use canonical flags without ZIP64, descriptors, extras, or comments.",
      );
    }

    const name = decodeName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    const normalizedName = name.toLowerCase();
    const directory = name.endsWith("/");
    if (
      !safeEntryName(name) ||
      name !== normalizedName ||
      !expectedEntryName(normalizedName, directory) ||
      seenNames.has(normalizedName)
    ) {
      throw new Error(
        "Klypix package contains an unsafe, duplicate, or unexpected entry.",
      );
    }
    seenNames.add(normalizedName);
    if (normalizedName.startsWith("items/") && !directory) {
      itemFiles += 1;
      if (itemFiles > MAX_KLYPIX_ITEM_FILES) {
        throw new Error(
          `Klypix package exceeds the safe ${MAX_KLYPIX_ITEM_FILES.toLocaleString()}-item limit.`,
        );
      }
    }

    const limit = entryLimit(normalizedName, directory);
    if (
      (directory &&
        (compressedSize !== 0 ||
          uncompressedSize !== 0 ||
          crc32 !== 0)) ||
      uncompressedSize > limit
    ) {
      throw new Error(
        `Klypix entry '${name}' expands beyond its safe limit.`,
      );
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO)
    ) {
      throw new Error(
        `Klypix entry '${name}' has an unsafe compression ratio.`,
      );
    }

    if (
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new Error("Klypix package contains a malformed local ZIP header.");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const dataOffset = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    const localName = decodeName(
      bytes.subarray(localNameStart, localNameStart + localNameLength),
    );
    if (
      dataOffset > directoryOffset ||
      dataEnd > directoryOffset ||
      localFlags !== 0 ||
      localMethod !== method ||
      localCrc32 !== crc32 ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      localExtraLength !== 0 ||
      localName !== name ||
      localNameLength !== nameLength
    ) {
      throw new Error(
        "Klypix local and central ZIP metadata do not match.",
      );
    }

    uncompressedBytes += uncompressedSize;
    if (
      !Number.isSafeInteger(uncompressedBytes) ||
      uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES
    ) {
      throw new Error("Klypix package expands beyond the safe total limit.");
    }
    entries.push({
      name,
      normalizedName,
      method: method as 0 | 8,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset,
      dataEnd,
      directory,
    });
    offset = entryEnd;
  }
  if (offset !== eocd) {
    throw new Error(
      "Klypix ZIP directory length does not match its entries.",
    );
  }

  const ranges = [...entries].sort(
    (left, right) => left.localOffset - right.localOffset,
  );
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.localOffset < ranges[index - 1]!.dataEnd) {
      throw new Error("Klypix package contains overlapping ZIP entries.");
    }
  }
  let expectedOffset = 0;
  for (const entry of ranges) {
    if (entry.localOffset !== expectedOffset) {
      throw new Error(
        "Klypix package contains an unlisted or non-contiguous local record.",
      );
    }
    expectedOffset = entry.dataEnd;
  }
  if (expectedOffset !== directoryOffset) {
    throw new Error(
      "Klypix package local records do not exactly cover the declared payload area.",
    );
  }
  if (
    !seenNames.has("manifest.json") ||
    !seenNames.has("canvas.json")
  ) {
    throw new Error(
      "Klypix v4 package requires manifest.json and canvas.json.",
    );
  }
  return { entries, uncompressedBytes };
}

function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inflate and integrity-check every package entry under the inspected limits.
 * Only manifest/canvas/item JSON is retained; embedded assets are discarded
 * without ever becoming agent evidence.
 */
export function readKlypixJsonEntries(
  bytes: Uint8Array,
  inspection: KlypixArchiveInspection,
): Map<string, Uint8Array> {
  const json = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of inspection.entries) {
    if (entry.directory) continue;
    let inflated: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new Error(
          `Klypix entry '${entry.name}' has inconsistent stored sizes.`,
        );
      }
      inflated = bytes.subarray(entry.dataOffset, entry.dataEnd);
    } else {
      try {
        inflated = inflateRawSync(
          bytes.subarray(entry.dataOffset, entry.dataEnd),
          {
            maxOutputLength: Math.min(
              entryLimit(entry.normalizedName, false),
              entry.uncompressedSize + 1,
            ),
          },
        );
      } catch {
        throw new Error(
          `Klypix entry '${entry.name}' cannot be safely inflated.`,
        );
      }
    }
    if (
      inflated.byteLength !== entry.uncompressedSize ||
      calculateCrc32(inflated) !== entry.crc32
    ) {
      throw new Error(
        `Klypix entry '${entry.name}' failed size or checksum validation.`,
      );
    }
    total += inflated.byteLength;
    if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error("Klypix package expands beyond the safe total limit.");
    }
    if (
      entry.normalizedName === "manifest.json" ||
      entry.normalizedName === "canvas.json" ||
      entry.normalizedName.startsWith("items/")
    ) {
      json.set(entry.name, inflated);
    }
  }
  if (total !== inspection.uncompressedBytes) {
    throw new Error(
      "Klypix package does not match its declared expanded size.",
    );
  }
  return json;
}
