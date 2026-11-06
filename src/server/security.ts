import { createHash, randomBytes } from 'node:crypto';

/** 256-bit, URL-safe, unpredictable secret. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Secrets are only ever stored as SHA-256 hashes (they are high-entropy, so no KDF needed). */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

// Crockford base32: no I, L, O, U -> easy to read and type.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

/** 8 chars x 5 bits = 40 bits. Short-lived, single-use and rate-limited. */
export function randomCode(length = PAIRING_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeName(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const clean = input.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return clean || fallback;
}
