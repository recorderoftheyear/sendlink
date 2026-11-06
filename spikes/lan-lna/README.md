# LAN spike — Local Network Access from the installed Android PWA

**Disposable.** Not part of SendLink: not built, not linted, not deployed. Delete this folder after the spike.

It answers one question for [ADR local-first](../../docs/adr-local-first-transport.md):
can an **installed HTTPS PWA** on Android Chrome reach a **plain-HTTP agent on the LAN**
(Chrome *Local Network Access*), including from a **Share Target launch** and with **WAN off**?

- `server.mjs`: serves the test PWA "LAN Spike" on `127.0.0.1:8787` (exposed via an HTTPS tunnel), and runs the "agent" on `0.0.0.0:47631` (HTTP, LAN). It logs every preflight and every request received.
- `public/`: the test PWA. Manifest with Share Target, service worker with an offline cache, and a page that records context, permission states before/after, timing and exact errors, in a persistent log.

No crypto, no authentication, no automatic discovery (the IP is entered by hand): that is not what's being tested.

## Desktop result already measured (Chromium 153, real HTTPS tunnel)

| Permission | `fetch("http://192.168.2.18:47631/ping", {targetAddressSpace:"local"})` |
|---|---|
| not granted (headless = no prompt) | ❌ `TypeError: Failed to fetch` in 16 ms, state `prompt` |
| granted | ✅ agent reached in 14 ms, plain HTTP from an HTTPS page |

The CORS preflight **does not** carry `Access-Control-Request-Private-Network`. `local-network-access`, `local-network` and `loopback-network` all respond to the Permissions API. **This is not the Android result.**

## Commands (Linux PC)

Terminal 1, the spike (agent + PWA files):

```bash
cd ~/claude/sendlink/sendlink
node spikes/lan-lna/server.mjs
# note the IP shown under "LAN IPs" (e.g. 192.168.2.18)
```

Firewall, only if ufw is active:

```bash
sudo ufw status
sudo ufw allow 47631/tcp        # remove afterwards: sudo ufw delete allow 47631/tcp
```

Terminal 2, HTTPS tunnel **for the spike only** (a separate URL from SendLink):

```bash
cloudflared tunnel --url http://localhost:8787
# note https://<random>.trycloudflare.com
```

> ⚠️ **Keep this same terminal 2 open from installation until S3.** A quick tunnel URL changes on every restart, and the installed PWA stays tied to its URL. For S4 (WAN off), the tunnel is dead anyway: the page must come from the offline cache.

## Steps on the Galaxy S24

**0. Prerequisites**
- Chrome: open `chrome://version` and note the version (≥ 141 expected for LNA on Android).
- Reachability without LNA: in a Chrome tab, open `http://<PC-IP>:47631/`. It should show *“LAN spike agent … is reachable.”* and terminal 1 should log `GET /`. If not: firewall, isolated guest Wi-Fi, or wrong IP. Fix this before going further.
- Leave the Chrome permission for the spike **untouched** (first visit).

**S1 — Chrome tab, Wi-Fi + Internet** (records the prompt)
1. Open the tunnel URL in Chrome and enter the PC IP.
2. Tap **Send to local agent (A)**.
3. **Note exactly**: does a prompt appear? Its text, and its buttons? Does the request wait for your answer? Then accept.
4. Result `✅` expected, and terminal 1 shows `PREFLIGHT` then `✅ HIT … scenario=S1`.
5. Also tap **B** (no `targetAddressSpace`) and **C** (simple GET): note ✅/❌ for each.

**Install**: Chrome ⋮ → *Add to Home screen* → *Install*. The **LAN Spike** icon appears.

**S2 — installed app, opened from the home screen**
1. Close all LAN Spike tabs, then open the app from its icon (no address bar).
2. Scenario shows **S2**. Look at the `Permission` line **before** sending: `granted` means persisted from S1.
3. **Send (A)**. Note: prompt again? ✅/❌?

**S3 — Share → LAN Spike**
1. YouTube → a video → **Share** → **LAN Spike** (under *More* if needed).
2. The page opens in the app with `Launch share-target`, the link under `Shared`, and scenario **S3**.
3. Note the `Permission` line, then **Send (A)**. ✅/❌, prompt?
4. Terminal 1 must show `launch=share-target shared=https://youtu…`.

**S3-fresh — permission never granted, first request from a Share** (optional, useful for the product)
1. Chrome ⋮ → Settings → Site settings → find *Local network* (or open the site via the lock icon in a tab of the tunnel URL) → **reset** the permission for the tunnel URL.
2. YouTube → Share → LAN Spike → **Send (A)**. Does the prompt show **inside the installed app launched from Share**?

**S4 — WAN OFF + mobile data OFF + Wi-Fi ON** (the critical test)
1. **Before cutting**: open LAN Spike once online and check `Offline ready true` and `SW controls page true`.
2. On the phone: **turn mobile data off**, keep Wi-Fi on.
3. **Cut Internet at the router while keeping Wi-Fi**, with one of:
   - unplug the cable between the ISP modem/ONT and your router (the WAN/Internet port), or
   - in the router admin: disable the WAN / Internet connection, or
   - **alternative without touching the router**: another phone as a **hotspot with its mobile data OFF**. Connect the PC **and** the S24 to it, restart `node spikes/lan-lna/server.mjs` and use the **new IP** it shows.
4. Check: on the S24, opening a website fails. Android shows *“Connected, no internet”*; if it offers to disconnect or switch network, **stay connected**.
5. YouTube (already loaded video, or any app with Share) → **Share → LAN Spike**.
6. The page must open **from the cache**, with `navigator.onLine` and `Connection` noted. Tap **Send (A)**.
7. Expected if the architecture is viable: `✅`, and terminal 1 shows `✅ HIT … scenario=S4`.
8. Repeat from the **home-screen icon**.

**S5 — WAN OFF + mobile data ON** (routing observation)
- Same as S4, but with mobile data on. Note ✅/❌ and the error. Android may route over mobile data, and then the LAN is unreachable.

**Afterwards**: restore Internet, **Copy log** in the app, and send me:
1. the Chrome version;
2. the pasted log;
3. what terminal 1 printed;
4. your notes on the prompts (text, when, inside tab / app / Share).

## Cleanup

```bash
# Ctrl+C in terminal 1 and terminal 2
sudo ufw delete allow 47631/tcp   # if you added it
```

On the phone: uninstall **LAN Spike** (long-press → Uninstall), and clear the site data if you like.
Repo: `rm -rf spikes/lan-lna` once the conclusions are written into the ADR.
