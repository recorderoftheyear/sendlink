// URL validation shared by server (authoritative) and clients (fast feedback / safe rendering).

export const MAX_URL_LENGTH = 2048;

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000- \u007f]/;

/**
 * Strict validation: only absolute http(s) URLs, no whitespace/control chars,
 * no embedded credentials. Returns the normalized href.
 */
export function validateUrl(input: unknown): UrlCheck {
  if (typeof input !== 'string') return { ok: false, error: 'URL must be a string' };
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'URL is required' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'URL is too long' };
  if (FORBIDDEN_CHARS.test(raw)) return { ok: false, error: 'URL contains invalid characters' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'Not a valid URL' };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: 'Only http and https links are allowed' };
  }
  if (!parsed.hostname) return { ok: false, error: 'URL has no host' };
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Links with embedded credentials are not allowed' };
  }
  if (parsed.href.length > MAX_URL_LENGTH) return { ok: false, error: 'URL is too long' };
  return { ok: true, url: parsed.href };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;
const BARE_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * Lenient client-side coercion: pulls the first http(s) URL out of shared text
 * ("Look at this https://…") and upgrades bare domains ("youtube.com/…") to https.
 * The result still has to pass validateUrl.
 */
export function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = URL_IN_TEXT.exec(trimmed);
  if (match) return match[0].replace(/[),.;!?]+$/, '');
  if (BARE_DOMAIN.test(trimmed)) return `https://${trimmed}`;
  return null;
}

/** Short human display form: "youtube.com/watch?v=…" */
export function displayUrl(href: string, max = 80): string {
  const short = href.replace(/^https?:\/\/(www\.)?/, '');
  return short.length > max ? `${short.slice(0, max - 1)}…` : short;
}
