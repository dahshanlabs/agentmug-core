/**
 * Keep untrusted portable metadata from emitting terminal control sequences or
 * spoofing multi-line diagnostics. JSON output remains lossless; this is only
 * for human-facing terminal text.
 */
export function terminalSafeOneLine(
  value: unknown,
  maximum = 2_000,
): string {
  return String(value ?? "")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      " ",
    )
    .slice(0, maximum);
}
