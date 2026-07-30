// Tool-name wire encoding for providers that forbid '.' and ':' in tool names.
//
// Our tools are namespaced two ways: dotted ("twilio.send_whatsapp",
// "gmail.send") and Nango-routed with colons ("nango:outlook:send_mail",
// "nango:microsoft-outlook:list_messages"). The Anthropic Messages API
// restricts a tool `name` to ^[a-zA-Z0-9_-]{1,128}$ and OpenAI restricts a
// function `name` to ^[a-zA-Z0-9_-]{1,64}$ — both EXCLUDE '.' AND ':', so
// sending either char 400s the whole request on tools[0].name before the
// model ever runs.
//
// We escape each disallowed separator to a sentinel and decode it back when
// the model echoes the name in a tool call. The engine's tool registry stays
// keyed on the ORIGINAL name — encode/decode live entirely at the SDK boundary.
//
// The mapping is lossless and unambiguous for our naming convention: segments
// use single underscores, so no real tool name contains "__"; the "__x__"
// sentinels therefore never collide with a real name, and the two sentinels
// don't overlap (different infix), so decode order is irrelevant. (Gemini
// permits these chars in function names, so its adapter skips this codec.)

// [rawSeparator, wireSentinel]. Add a pair here if a new disallowed char shows
// up in a tool namespace.
const ENCODINGS: ReadonlyArray<readonly [string, string]> = [
  [".", "__dot__"],
  [":", "__col__"],
];

/** Tool name → wire-safe name. "nango:outlook:send_mail" → "nango__col__outlook__col__send_mail". */
export function encodeToolName(name: string): string {
  let out = name;
  for (const [raw, enc] of ENCODINGS) out = out.split(raw).join(enc);
  return out;
}

/** Wire-safe name → original tool name. Inverse of encodeToolName. */
export function decodeToolName(name: string): string {
  let out = name;
  for (const [raw, enc] of ENCODINGS) out = out.split(enc).join(raw);
  return out;
}
