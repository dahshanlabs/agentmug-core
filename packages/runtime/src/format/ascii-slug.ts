/**
 * Convert untrusted text to a bounded lowercase ASCII slug in one pass.
 * Separators are emitted only between alphanumeric runs, so truncation never
 * leaves a trailing dash.
 */
export function toAsciiSlug(value: string, maxLength: number): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  if (limit === 0) return "";

  let slug = "";
  let pendingSeparator = false;
  for (const character of value.toLowerCase()) {
    const code = character.charCodeAt(0);
    const isAsciiLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;

    if (isAsciiLetter || isDigit) {
      if (pendingSeparator && slug.length > 0) {
        if (slug.length + 2 > limit) break;
        slug += "-";
      }
      if (slug.length >= limit) break;
      slug += character;
      pendingSeparator = false;
    } else if (slug.length > 0) {
      pendingSeparator = true;
    }
  }

  return slug;
}
