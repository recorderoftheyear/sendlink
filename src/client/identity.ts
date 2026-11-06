// How a client describes itself. Everything here is *display* metadata chosen or editable by
// the user — never used to identify or link devices (no fingerprinting, no high-entropy hints).
import type { ClientProfile, ClientType, DeviceInfo } from '../shared/protocol.js';

/** Default physical-device name, from the coarse platform in the UA string. The user can rename it. */
export function defaultDeviceName(kind: 'desktop' | 'mobile'): string {
  const ua = navigator.userAgent;
  if (kind === 'mobile') {
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    return 'My Phone';
  }
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'My Computer';
}

/** Browser label for display ("Linux PC · Firefox"). Order matters: most UAs contain "Chrome"/"Safari". */
export function browserLabel(): string | null {
  const ua = navigator.userAgent;
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/EdgA?\/|EdgiOS\//.test(ua)) return 'Edge';
  if (/OPR\/|OPiOS\//.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

/**
 * True when running as the installed SendLink app (home-screen PWA, incl. Share Target launches).
 * On Android the installed app shares storage with the browser that installed it, so this is the
 * same client/credential as /m tabs in that browser — just marked as the canonical installation.
 */
export function isInstalledApp(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function clientProfile(kind: 'desktop' | 'mobile'): ClientProfile & { clientType: ClientType } {
  return {
    name: defaultDeviceName(kind),
    clientType: kind === 'mobile' && isInstalledApp() ? 'pwa' : 'browser',
    clientLabel: browserLabel() ?? undefined,
  };
}

/**
 * Fields to PATCH so the server-side profile reflects this installation. Only fills gaps
 * (legacy clients without a label) and upgrades browser → pwa; never overwrites user edits.
 */
export function profileUpdate(device: DeviceInfo, kind: 'desktop' | 'mobile'): Partial<ClientProfile> | null {
  const local = clientProfile(kind);
  const patch: Partial<ClientProfile> = {};
  if (device.client.label === null && local.clientLabel) patch.clientLabel = local.clientLabel;
  if (local.clientType === 'pwa' && device.client.type !== 'pwa') patch.clientType = 'pwa';
  return Object.keys(patch).length ? patch : null;
}

/** Asks the browser not to evict our storage (holds the device credential). Granted readily to installed apps. */
export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => undefined);
}
