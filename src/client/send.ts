// Logical send pipeline. The caller builds one OutgoingLink (with its messageId) and calls
// send(); transports are tried in order. Today the relay is the only transport; a LAN
// transport can be added in front of it later without changing callers.
import { ApiRequestError, type ApiClient } from './api.js';
import type { SendResponse } from '../shared/protocol.js';

export interface OutgoingLink {
  /** Generated once per logical send, before any transport is chosen; reused by every retry. */
  messageId: string;
  targetDeviceId: string;
  url: string;
}

export type SendStatus = 'delivered' | 'queued';

export interface SendOutcome {
  transport: string;
  status: SendStatus;
}

export interface Transport {
  readonly name: string;
  send(link: OutgoingLink): Promise<SendOutcome>;
}

export function newMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // available in insecure contexts too
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `msg_${b64}`;
}

/** A failure where the request may or may not have reached the server: safe to retry thanks to messageId. */
function isAmbiguous(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 0 || err.status >= 500);
}

const RETRY_DELAYS_MS = [400, 1200];

/** The Internet relay (POST /api/links). Retries ambiguous failures with the same messageId. */
export function relayTransport(api: ApiClient, delays: number[] = RETRY_DELAYS_MS): Transport {
  return {
    name: 'relay',
    async send(link) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api.request<SendResponse>('POST', '/api/links', {
            messageId: link.messageId,
            targetDeviceId: link.targetDeviceId,
            url: link.url,
          });
          return { transport: 'relay', status: res.delivered ? 'delivered' : 'queued' };
        } catch (err) {
          const delay = delays[attempt];
          if (!isAmbiguous(err) || delay === undefined) throw err;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    },
  };
}

/** Tries each transport in order; the first success wins. Throws the last error if all fail. */
export async function send(link: OutgoingLink, transports: Transport[]): Promise<SendOutcome> {
  let lastError: unknown = new Error('No transport available');
  for (const transport of transports) {
    try {
      return await transport.send(link);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
