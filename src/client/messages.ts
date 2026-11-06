// User-facing wording. No jargon: no "pairing", "token", "SSE", "client"…
import { ApiRequestError } from './api.js';

export const MSG = {
  unreachable: "Can't reach SendLink. Check your connection and try again.",
  sendFailed: "Couldn't send. Try again.",
  invalidUrl: "That doesn't look like a web link. Check it and try again.",
  offlineDelivery: 'Computer offline — the link will be delivered when it reconnects.',
  revoked: 'This phone was disconnected. Scan the code on your computer to reconnect.',
  destinationGone: 'That computer was removed. Choose another one.',
  rateLimited: 'Too many links at once. Wait a moment and try again.',
  codeExpired: 'This code has expired. Use the new code on your computer.',
  codeInvalid: "This code doesn't work anymore. Use the code shown on your computer.",
  tooManyAttempts: 'Too many attempts. Wait a minute and try again.',
  generic: 'Something went wrong. Try again.',
  notSentOffline: "Not sent — no connection. Your link is still here: try again when you're back online.",
  offlineBanner: "You're offline. SendLink is open, but links can't be sent until you're back online.",
} as const;

export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 0 || err.status >= 502);
}

/** Maps any API error to a sentence a user understands. */
export function friendlyError(err: unknown, context: 'send' | 'connect' | 'other' = 'other'): string {
  if (!(err instanceof ApiRequestError)) return MSG.generic;
  if (isNetworkError(err)) return MSG.unreachable;
  switch (err.code) {
    case 'invalid_url':
      return MSG.invalidUrl;
    case 'not_paired':
      return MSG.destinationGone;
    case 'unauthorized':
      return MSG.revoked;
    case 'rate_limited':
      return context === 'connect' ? MSG.tooManyAttempts : MSG.rateLimited;
    case 'pairing_expired':
      return MSG.codeExpired;
    case 'pairing_invalid':
    case 'pairing_self':
    case 'invalid_request':
      return context === 'connect' ? MSG.codeInvalid : MSG.generic;
  }
  return context === 'send' ? MSG.sendFailed : MSG.generic;
}
