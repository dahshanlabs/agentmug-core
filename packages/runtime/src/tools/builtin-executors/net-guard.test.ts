// Regression tests for the portable SSRF host classifier used by the CLI/
// desktop fetch executors. isPrivateHost is a pure function, so this needs no
// network. Run: `pnpm --filter @agentmug/runtime run test:net-guard`.

import assert from "node:assert/strict";
import { toAsciiSlug } from "../../format/ascii-slug";
import { htmlToText } from "./fetch-url-executor";
import { isPrivateHost } from "./net-guard";

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

const isPrivate = (h: string) => assert.equal(isPrivateHost(h), true, `${h} should be private`);
const isPublic = (h: string) => assert.equal(isPrivateHost(h), false, `${h} should be public`);

test("loopback + private IPv4 blocked", () => {
  isPrivate("127.0.0.1");
  isPrivate("10.0.0.1");
  isPrivate("172.16.5.5");
  isPrivate("192.168.0.1");
});

test("cloud metadata + CGNAT blocked", () => {
  isPrivate("169.254.169.254");
  isPrivate("100.64.0.1");
});

test("internal/loopback/mDNS hostnames blocked", () => {
  isPrivate("localhost");
  isPrivate("db.internal");
  isPrivate("svc.railway.internal");
  isPrivate("printer.local");
});

test("IPv6 loopback / ULA / link-local blocked (bracketed + bare)", () => {
  isPrivate("::1");
  isPrivate("[::1]");
  isPrivate("fd00::1");
  isPrivate("fe80::1");
});

test("IPv4-mapped-IPv6 loopback blocked (dotted + hex)", () => {
  isPrivate("::ffff:127.0.0.1");
  isPrivate("::ffff:7f00:1");
  isPrivate("[::ffff:127.0.0.1]");
});

test("public hosts allowed", () => {
  isPublic("93.184.216.34");
  isPublic("example.com");
  isPublic("api.github.com");
  isPublic("8.8.8.8");
});

test("HTML conversion removes raw-text elements and respects quoted tag attributes", () => {
  assert.equal(
    htmlToText(
      '<p title="1 > 0">Hello&nbsp;<strong>world</strong></p>' +
        '<script>if (a < b) x = "</not-script>";</script >' +
        "<style>hidden</style>" +
        "<noscript>hidden</noscript><!-- hidden -->",
    ),
    "Hello world",
  );
});

test("HTML entities decode once and invalid numeric entities remain inert", () => {
  assert.equal(htmlToText("<p>&amp;lt; &#65; &#55296; &unknown;</p>"), "&lt; A &#55296; &unknown;");
  assert.equal(htmlToText("2 < 3"), "2 < 3");
});

test("ASCII slugging is bounded, separator-safe, and linear on long input", () => {
  assert.equal(toAsciiSlug(" --Alpha---Beta-- ", 48), "alpha-beta");
  assert.equal(toAsciiSlug(`A${"-".repeat(100_000)}B`, 10), "a-b");
  assert.equal(toAsciiSlug("alpha beta", 6), "alpha");
  assert.equal(toAsciiSlug("alpha", Number.NaN), "");
});

// ─── runner ────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
  } catch (err) {
    failures.push(`✗ ${t.name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nnet-guard: ${passed}/${tests.length} passed`);
if (failures.length) {
  console.error(`\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
console.log("All net-guard tests passed ✓\n");
