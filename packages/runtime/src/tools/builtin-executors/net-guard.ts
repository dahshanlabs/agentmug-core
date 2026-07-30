// Shared network-safety helpers for the portable HTTP executors.
//
// These run on the USER'S OWN machine (CLI / desktop), not multi-tenant cloud,
// so the threat model is lighter than the cloud's DNS-resolving SSRF guard
// (which needs node:dns and isn't browser-portable). We keep a hostname-pattern
// block for private / loopback / link-local / *.internal targets, cover the
// IPv4-mapped-IPv6 form, AND follow redirects MANUALLY (re-validating each hop)
// so a public URL can't 30x-bounce a local agent into the user's LAN or a
// cloud-metadata endpoint. The cloud keeps its stronger DNS-resolving safeFetch.

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^127\./,
  /^0\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local + cloud metadata (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^::1$/,
  /^::$/,
  /^fe80::/i, // link-local
  /^fc/i, // ULA
  /^fd/i, // ULA
];

// Extract the embedded IPv4 from an IPv4-mapped IPv6 literal, dotted
// (::ffff:127.0.0.1) or hex (::ffff:7f00:1), so it gets classified as v4.
function mappedIpv4(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
  }
  return null;
}

export function isPrivateHost(hostname: string): boolean {
  // new URL() wraps IPv6 literals in [...]; strip them and lowercase.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  const candidate = mappedIpv4(host) ?? host;
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(candidate));
}

function assertFetchableUrl(rawUrl: string, allowHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowHttp)) {
    throw new Error(
      `Only ${allowHttp ? "http(s)" : "https"} URLs are allowed, got '${u.protocol}'.`,
    );
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(
      `Refusing to fetch private/loopback host '${u.hostname}'.`,
    );
  }
  return u;
}

// Drop credential-bearing headers when a redirect crosses to a different
// origin — mirrors the WHATWG fetch spec (which strips Authorization on a
// cross-origin redirect) and the cloud safeFetch, so a 30x can't exfiltrate a
// bearer token / API key an agent set for the ORIGINAL host to an attacker host.
function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "authorization" ||
    n === "cookie" ||
    n === "proxy-authorization" ||
    n === "x-api-key" ||
    /^x-.*-(key|token|secret)$/.test(n) ||
    n.endsWith("-api-key")
  );
}

function stripSensitiveHeaders(headers: RequestInit["headers"]): RequestInit["headers"] {
  if (!headers) return headers;
  const h = new Headers(headers);
  for (const key of [...h.keys()]) {
    if (isSensitiveHeader(key)) h.delete(key);
  }
  return h;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export interface SafeFetchLocalInit extends RequestInit {
  /** Allow plain http:// (default false → https only). */
  allowHttp?: boolean;
}

/**
 * fetch() for a user/agent-supplied URL on the LOCAL runtime. Validates the
 * scheme + host, then follows redirects MANUALLY, re-validating each hop — so a
 * public URL that 30x-redirects to a private/loopback/*.internal target is
 * refused instead of silently followed. Portable: uses only global fetch + URL
 * (no node:dns), unlike the cloud's DNS-resolving safeFetch.
 */
export async function safeFetchLocal(
  rawUrl: string,
  init: SafeFetchLocalInit = {},
  maxRedirects = 3,
): Promise<Response> {
  const { allowHttp = false, ...rest } = init;
  let url = rawUrl;
  let headers = rest.headers;
  let origin = originOf(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = assertFetchableUrl(url, allowHttp);
    const res = await fetch(u.toString(), { ...rest, headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, u);
      // Cross-origin hop → drop credential headers before following, so a
      // redirect can't leak the caller's/agent's token to another host.
      if (next.origin !== origin) {
        headers = stripSensitiveHeaders(headers);
        origin = next.origin;
      }
      url = next.toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

/** Read an env var without assuming `process` exists (browser/Tauri safe). */
export function readEnv(name: string): string | undefined {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}
