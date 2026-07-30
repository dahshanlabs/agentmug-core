/**
 * Local-source safety limits.
 *
 * These deliberately mirror the web artifact parser where the same content
 * types overlap. Directory limits are CLI-specific: a binding that exceeds
 * them fails closed and asks the user to bind a narrower folder.
 */
export const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_KLYPIX_RAW_BYTES = 5 * 1024 * 1024;
export const MAX_SOURCE_TEXT_CHARS_PER_FILE = 90_000;
export const MAX_SOURCE_CHUNK_CHARS = 20_000;
export const MAX_SOURCE_CHUNKS = 40;
export const MAX_SOURCE_PARSE_MS = 15_000;
export const MAX_DIRECTORY_FILES = 100;
export const MAX_DIRECTORY_ENTRIES = 2_000;
export const MAX_DIRECTORY_DEPTH = 20;
export const MAX_DIRECTORY_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_DIRECTORY_PARSE_MS = 30_000;
export const MAX_PRIVATE_RECORD_BYTES = 1024 * 1024;
export const MAX_PRIVATE_RECEIPTS = 1_000;
export const MAX_PRIVATE_RECEIPT_BYTES = 100 * 1024 * 1024;

export const MAX_ARCHIVE_ENTRIES = 2_000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_WORKSHEET_XML_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_COMPRESSION_RATIO = 80;
export const MAX_OFFICE_XML_ELEMENTS = 500_000;
export const MAX_WORKBOOK_SHEETS = 50;
export const MAX_WORKBOOK_ROWS = 100_000;
export const MAX_WORKBOOK_TOTAL_ROWS = 250_000;
export const MAX_WORKBOOK_COLUMNS = 2_000;
export const MAX_WORKBOOK_EMITTED_CELLS = 30_000;
export const MAX_KLYPIX_CARDS = 1_000;
export const MAX_KLYPIX_CONNECTIONS = 5_000;
export const MAX_KLYPIX_CARD_CHARS = 16 * 1024;
export const MAX_KLYPIX_TEXT_CHARS = 500_000;
export const MAX_KLYPIX_ITEM_FILES = 1_000;
export const MAX_KLYPIX_MANIFEST_BYTES = 64 * 1024;
export const MAX_KLYPIX_CANVAS_BYTES = 2 * 1024 * 1024;
export const MAX_KLYPIX_ITEM_BYTES = 64 * 1024;
export const MAX_KLYPIX_ASSET_BYTES = 8 * 1024 * 1024;
