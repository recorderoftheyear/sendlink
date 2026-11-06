// Wire types shared by server and clients. Versioned so native apps / extensions can evolve.

export type DeviceKind = 'desktop' | 'mobile';

/** browser = a browser profile; pwa = the installed SendLink app (canonical on phones). */
export type ClientType = 'browser' | 'pwa';

/**
 * A SendLink *client*: an installation holding its own credential (a browser profile or
 * the installed PWA). It is the unit that is paired, addressed (`targetDeviceId`) and
 * receives events. It runs on a *physical device* — a human-named machine.
 */
export interface DeviceInfo {
  id: string;
  /** Display name: "Linux PC · Chrome" for browsers, "Galaxy S24" for the installed app. */
  name: string;
  kind: DeviceKind;
  physicalDevice: { id: string; name: string };
  client: { type: ClientType; label: string | null };
}

/** Self-description a client sends when registering / pairing / updating itself. */
export interface ClientProfile {
  /** Physical device name ("Linux PC", "Galaxy S24"). */
  name?: string;
  clientType?: ClientType;
  /** Browser/app label ("Chrome", "Firefox"). Display only — never used for identification. */
  clientLabel?: string;
}

export interface PeerInfo extends DeviceInfo {
  pairedAt: string;
  online: boolean;
}

export interface MeResponse {
  device: DeviceInfo;
  peers: PeerInfo[];
}

/** A link delivered to a device. In a future E2E version `url` becomes `ciphertext`. */
export interface LinkMessage {
  v: 1;
  type: 'url';
  id: string;
  /** Sender-generated id of the logical send (null for links sent before it existed). */
  messageId: string | null;
  targetDeviceId: string;
  senderDeviceId: string | null;
  senderName: string;
  url: string;
  timestamp: string;
}

/** Response to POST /api/links. */
export interface SendResponse extends LinkMessage {
  /** false = the destination is offline; the link is stored and delivered when it reconnects. */
  delivered: boolean;
  /** true = this messageId was already accepted: nothing new was stored or published. */
  duplicate: boolean;
}

/** Sender-generated message ids: "msg_" + base64url, 16–64 chars of randomness. */
export const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{16,64}$/;

export interface RegisterResponse {
  device: DeviceInfo;
  token: string;
}

export interface PairingTokenResponse {
  code: string;
  pairUrl: string;
  expiresAt: string;
}

export interface RedeemResponse {
  device: DeviceInfo;
  /** Only present when a new device credential was issued. */
  token?: string;
  peer: DeviceInfo;
}

export type RealtimeEvent =
  | LinkMessage
  | { type: 'paired'; peer: DeviceInfo }
  | { type: 'unpaired'; peerId: string }
  | { type: 'peer_updated'; peer: DeviceInfo }
  /** A paired device gained or lost its healthy realtime connection. */
  | { type: 'presence'; deviceId: string; online: boolean }
  | { type: 'url_deleted'; id: string };

/** Long-polling fallback for networks that buffer SSE streams. */
export interface PollResponse {
  cursor: string;
  /** Connection id: send it back with the next poll so the same presence lease is renewed. */
  conn: string;
  events: RealtimeEvent[];
  /** The cursor was unknown (server restart / too old): refetch state from the REST API. */
  reset?: true;
}

export interface ApiError {
  error: { code: string; message: string };
}
