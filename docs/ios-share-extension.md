# iOS — Share Extension (future architecture)

> Status: **not implemented**. This is the plan for bringing `Share → SendLink` to iPhone.

## Why a native app is required on iOS

- iOS Safari does **not** support Web Share Target: an installed web app (Home Screen) never
  appears in the iOS Share Sheet.
- The only way into the iOS Share Sheet is an **App Extension** (`NSExtensionPointIdentifier =
  com.apple.share-services`) shipped inside a native app from the App Store (or TestFlight).
- Home Screen web apps on iOS have storage **isolated from Safari**, so the web client's
  credential can't be reused by native code anyway.

## Target flow

```text
iOS Share Sheet (Safari, YouTube, Reddit, …)
      ↓
SendLink Share Extension          (Swift, runs in its own process, ~120 MB memory limit)
      ↓
credential from shared Keychain   (App Group keychain access group, written by the app)
      ↓
destination picker                (GET /api/me → peers; last destination from App Group defaults)
      ↓
POST /api/links                   (Authorization: Bearer <device token>)
      ↓
desktop                           (SSE / long-poll — unchanged)
```

## Components

| Piece | Where | Notes |
|---|---|---|
| **Container app** (SwiftUI) | native | Onboarding: scan the desktop QR (AVFoundation / `DataScannerViewController`), or enter the code. Calls `POST /api/pairings` with `clientType: "pwa"`-equivalent (see below), stores the token. Rename, disconnect. |
| **Share Extension** (SwiftUI in `SLComposeServiceViewController` or a custom `UIViewController`) | native | Reads the shared item: `NSItemProvider` with `UTType.url` (preferred) or `UTType.plainText` (extract the first http(s) URL, same rules as `src/shared/url.ts`). Shows the destination list, Send, "✓ Sent to …", then `extensionContext.completeRequest`. |
| **Shared credential** | Keychain, App Group access group | Written by the app, read by the extension. Never in `UserDefaults`. |
| **Last destination** | `UserDefaults(suiteName: "group.…")` | Same rule as the web client: last used if it still exists, else first online, else most recent. |
| **Backend** | existing | No change needed (see below). |

## What the current backend already provides

Everything the extension needs exists and is covered by tests:

- `POST /api/pairings` `{ secret | code, deviceName, clientType, clientLabel }` → `{ device, token, peer }`
  - The QR code encodes `https://<host>/m#pair=<secret>`: the app reads the fragment from the scanned URL.
  - With Universal Links on `https://<host>/m`, scanning with the Camera app can open the app directly.
- `GET /api/me` → this device + paired computers with `online` flags (for the picker).
- `POST /api/links` `{ targetDeviceId, url }` → `{ …, delivered }` (`false` = computer offline, stored and delivered later).
- `PATCH /api/me` `{ name }` for rename; `DELETE /api/pairings/:id` to disconnect.
- Bearer authentication, strict URL validation, rate limiting, store-and-forward, revocation.
- Wire types: `src/shared/protocol.ts` (versioned message `v: 1`).

Small backend additions worth making **when** the iOS app is built (not before):

1. `clientType: "app"` (native app) next to `browser` / `pwa`, displayed like `pwa` (no browser suffix).
   It's a one-line enum change in `service.ts` + a migration of the `CHECK` constraint.
2. Optional: APNs push for the *container app* (not needed for sending — iOS is a sender).

## What must be native (Swift)

- QR scanning, Keychain + App Group plumbing, the Share Extension UI and lifecycle.
- URL extraction from `NSItemProvider` (re-implement `extractUrl` / `validateUrl` — ~30 lines; keep
  the server as the authority: it rejects anything that isn't http(s)).
- Networking with `URLSession` (the extension must finish quickly; no background upload needed for
  a ~2 KB request).

## Security notes

- The extension only ever holds the device token (256-bit, revocable), never a pairing secret.
- Certificate validation: default ATS (HTTPS only). No custom trust.
- Revocation: a `401` from the API means the phone was disconnected → the extension shows
  "Open SendLink to reconnect" and the app clears the Keychain item.
