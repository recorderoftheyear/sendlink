# SendLink

> Share a link to any computer in seconds.

SendLink envoie une URL du téléphone vers l'ordinateur, instantanément.

**Parcours principal (Android)** : `YouTube / Chrome / Reddit… → Partager → SendLink → choisir l'ordinateur → Send → l'ordinateur reçoit`.

**Parcours utilisateur (V1)**

| Écran | Comportement |
|---|---|
| Ordinateur, 1ʳᵉ visite | « Send links from your phone to this computer. » + QR + code de secours. Après le scan : « ✓ Phone connected — You're ready. Share any link → SendLink ». |
| Téléphone, lancé depuis **Partager** | URL pré-remplie (aperçu discret, modifiable), liste des ordinateurs (Online/Offline), **dernière destination utilisée présélectionnée**, bouton Send dominant → « ✓ Sent to … » puis la fenêtre se ferme (`window.close()`, standard) pour revenir à l'app d'origine. Si le navigateur refuse, l'écran propose *Done* / *Send another link*. |
| Téléphone, ouvert directement | Destination (menu natif s'il y en a plusieurs), champ « Paste a link… », Send, puis « This phone » + Rename. |
| Téléphone connecté mais app non installée (Android) | Carte « Add SendLink to your phone » (`beforeinstallprompt`, ou instructions manuelles), masquée 14 jours après « Not now ». Après installation : « ✓ SendLink installed — Share → SendLink ». |
| Ordinateur connecté | Liens reçus d'abord (Open, Copy, source · date, ×), section *Devices* secondaire, notifications optionnelles. |
| Ordinateur hors ligne | L'envoi fonctionne quand même : « Computer offline — the link will be delivered when it reconnects. » |
| **Téléphone sans réseau** | L'app s'ouvre quand même (depuis Partager ou l'icône) grâce au service worker, avec les dernières destinations connues et le bandeau « You're offline… links can't be sent until you're back online ». Un essai d'envoi affiche « Not sent — no connection » et garde le lien. **Rien n'est livré hors ligne tant que le transport LAN n'existe pas.** |

Messages d'erreur sans jargon : serveur injoignable (écran dédié + nouvelle tentative), téléphone déconnecté, code expiré, lien invalide, trop d'envois… (`src/client/messages.ts`).

**Notifications desktop** : si la permission est accordée et que l'onglet SendLink n'est pas au premier plan, notification « SendLink — *<téléphone>* sent you a link » avec l'URL et une action **Open**. Un clic ouvre le lien : c'est le seul cas d'ouverture, sur action explicite. Rien n'est jamais ouvert automatiquement.

```
PHONE                          SERVER                          COMPUTER
                                                               POST /api/devices   (credential)
                                                               POST /api/pairing-tokens
                                                               QR = https://host/m#pair=<secret>
scan QR ──► POST /api/pairings ──► token consumed (1×, 2 min)
            ◄── device credential   pairing stored ── SSE "paired" ──► switches to inbox
paste URL ─► POST /api/links ────► validate + authorize
                                    store in inbox ── SSE "url" ─────► shows link [Open] [Copy]
```

---

## 1. Architecture

### Choix de stack — et pourquoi

| Besoin | Choix | Pourquoi ce choix *pour ce produit* |
|---|---|---|
| Serveur | **Node 20+ / TypeScript, `node:http` sans framework** | ~10 endpoints + un flux push. Un framework coûterait plus (surface, dépendances) qu'il n'apporte. |
| Temps réel | **Server-Sent Events** + repli **long-polling** | Le flux est **unidirectionnel** (serveur → ordinateur) ; le téléphone fait un simple `POST`. SSE = HTTP standard, reconnexion native, zéro dépendance. Repli automatique en long-polling derrière les proxies qui bufferisent (voir §Temps réel). |
| Stockage | **SQLite (`better-sqlite3`)** | Un fichier, zéro service à opérer, zéro coût. Les transactions garantissent l'usage unique des tokens. Schéma portable vers Postgres. |
| Front | **TypeScript vanilla + esbuild** | Deux écrans, ~5 états. Pas de React/Next : pages de 5–33 kB (le QR encoder est l'essentiel), build en 10 ms. |
| Mobile | **PWA + Web Share Target** | Permet `Share → SendLink` sur Android sans app native. |

**Dépendances runtime : 1** (`better-sqlite3`). `qrcode` est bundlé côté client au build.
**Infra : 1 process + 1 fichier.** Un VPS à 4 €/mois ou un Raspberry Pi suffit.

### Structure du repo

```
src/
  shared/        protocol.ts (types du protocole, versionnés)  url.ts (validation d'URL partagée)
  server/        index.ts (entrée)  app.ts (HTTP, auth, headers, statique)
                 service.ts (règles métier)  db.ts (schéma SQLite)  hub.ts (SSE)
                 tickets.ts (tickets SSE)  rateLimit.ts  security.ts  config.ts
  client/        desktop.ts  mobile.ts  api.ts (fetch + SSE)  dom.ts
public/          desktop.html  mobile.html  styles.css  manifest.webmanifest  sw.js  icônes
test/            service.test.ts  url.test.ts  http.test.ts   (vitest)
e2e/             send-link.spec.ts                            (Playwright)
scripts/build.mjs
```

`service.ts` ne connaît ni HTTP ni SSE : il publie via une interface `Publisher`. Les tests unitaires l'utilisent avec un publisher factice ; demain un Redis pub/sub peut remplacer `SseHub` sans toucher au métier.

### Modèle de données et identité

Deux notions distinctes :

- **physical_device** : la machine, avec un nom humain modifiable (« Linux PC », « Galaxy S24 »).
- **client** : une installation qui détient un credential, c'est-à-dire un profil de navigateur ou la PWA installée. C'est l'unité **appairée, adressée (`targetDeviceId`) et destinataire des événements**. Pour ne pas casser le protocole ni l'API, elle reste stockée dans la table `devices`.

```
physical_devices id, name, kind, created_at
devices (=clients) id, kind, token_hash, physical_device_id → physical_devices, client_type (browser|pwa),
                 client_label ("Chrome", "Firefox"…), public_key*, created_at, last_seen_at
pairing_tokens   id, device_id → devices, secret_hash, code_hash, expires_at, used_at
pairings         id, device_a, device_b  (a < b, UNIQUE)  — relation symétrique N↔N entre clients
links            id, target_id → devices, sender_id → devices (SET NULL), sender_name, url, created_at
```
\* réservé au chiffrement E2E.

**Nom affiché** : `physical · label` pour un navigateur (`Linux PC · Chrome`, `Linux PC · Firefox`). Seulement `physical` pour l'app installée (`Galaxy S24`).

- **Desktop** : chaque navigateur ou profil est une destination distincte, avec sa propre identité, appairée séparément.
- **Mobile** : la PWA installée est l'identité canonique du téléphone. Chrome, Samsung Internet, YouTube ou Reddit ne sont que des *sources* d'URL partagées via le menu Partager.
- **Pas de fingerprinting.**
  - Le label de navigateur vient du user-agent. Il sert **uniquement à l'affichage** et n'est jamais utilisé pour identifier ou relier des clients.
  - Les Client Hints haute entropie (modèle du téléphone) ne sont pas utilisés : l'utilisateur nomme son téléphone avec **Rename**.
- **Aucun regroupement déduit.** Le serveur ne peut pas savoir que Chrome et Firefox tournent sur le même PC : chaque nouveau client reçoit son propre `physical_device`. Le schéma permet de rattacher plusieurs clients à une même machine via un futur mécanisme **explicite et authentifié** d'adoption (même principe qu'un token de pairing), non implémenté.
- **Rename** : `PATCH /api/me {name}` renomme la machine (tous ses clients). `{clientLabel}` décrit l'installation. Les pairs sont notifiés en direct (`peer_updated`).

#### Persistance de l'identité Android (PWA)

- **L'identité, c'est le credential dans le stockage de l'origine** (`localStorage`, clé `sendlink.mobile`).
- **Une PWA installée (WebAPK) partage le stockage du navigateur qui l'a installée**, pour la même origine. La PWA, les lancements via **Web Share Target** et les onglets `/m` de *ce* navigateur utilisent donc le même credential, et donc le même client.
- **Premier lancement en `display-mode: standalone`** : le client passe en `pwa` (même id, même token) et devient l'identité canonique, affichée sans suffixe.
- **Autre navigateur** : `/m` ouvert dans Samsung Internet alors que la PWA vient de Chrome a un stockage isolé. Il n'est **pas authentifié**, affiche l'écran de pairing, et s'il est appairé, apparaît visiblement à part (`Android phone · Samsung Internet`). Aucune fusion silencieuse.
- **Contre l'éviction** : `navigator.storage.persist()` est demandé. Chrome l'accorde facilement aux apps installées.
- **Perte du credential** (données du site effacées) : il faut ré-appairer. L'ancienne entrée peut être retirée depuis le desktop (*Unpair*).
- **iOS** : une app sur l'écran d'accueil a un stockage séparé de Safari. Mêmes règles.

#### Migrations

- Le schéma est versionné par `PRAGMA user_version` (voir `src/server/db.ts`).
- **v2** crée un `physical_device` par client existant, qui reprend son ancien nom. Tokens, ids, pairings et historique sont conservés : aucun ré-appairage.
- **v3** ajoute `links.message_id` (nullable) et un index unique partiel `(sender_id, message_id)`. Les liens existants gardent `NULL` et sont inchangés.

#### Service worker (app hors ligne)

- `public/sw.js` **pré-cache** l'app shell du téléphone (`/m`, `mobile.js`, `styles.css`, manifest, icônes) dans un cache versionné `sendlink-shell-<hash>`. Le hash est calculé au build (`scripts/build.mjs`) : chaque changement de ces fichiers produit un nouveau `sw.js`, qui installe un nouveau cache et supprime l'ancien.
- Les navigations vers `/m`, y compris `/m?text=…` venant de Partager, sont servies **depuis le cache, sans attendre le réseau**. Avec un Wi-Fi sans Internet, une requête réseau peut rester bloquée sur le DNS.
- **Jamais** de cache ni d'interception pour `/api/*` ; les pages desktop passent par le réseau normalement.
- Le téléphone garde en `localStorage` (`sendlink.mobile.cache`) **seulement** les noms et ids des destinations et le nom de l'appareil, pour afficher un écran utile hors ligne. Pas d'état de présence, pas d'historique.

#### Envoi idempotent (`message_id`)

- **Côté téléphone** : chaque envoi logique reçoit un `messageId` (`msg_` + 128 bits aléatoires) **avant** le choix du transport (`src/client/send.ts`). Un échec ambigu (réseau, 5xx) est retenté automatiquement avec le même ID (400 ms, puis 1,2 s), et un nouveau tap sur *Send* pour le même lien et la même destination le réutilise aussi.
- **Côté serveur** : `POST /api/links {messageId, …}` est idempotent par émetteur. Première fois : `201`, `duplicate:false`. Répétition : `200`, `duplicate:true`, même lien, **rien de stocké ni de republié**. Même ID pour un autre lien ou une autre destination : `409`. Sans `messageId` : comportement historique.
- **Transports** : `send(link, transports)` essaie les transports dans l'ordre. Aujourd'hui, seul le **relais** existe. En développement, `<html data-last-send="relay:delivered|relay:queued">` indique le résultat du dernier envoi.
- **Limites connues** : une répétition après que le lien a été supprimé de l'historique, ou éjecté par la limite de 200, le recrée. Les retries arrivent en quelques secondes, donc ce cas est théorique.
- Au lancement suivant, chaque page complète son label de navigateur, **seulement s'il est vide**, pour ne jamais écraser un renommage.

### API

| Méthode | Route | Auth | Rôle |
|---|---|---|---|
| POST | `/api/devices` | — | Enregistre un client desktop `{kind, name, clientLabel}` → `{device, token}` |
| GET/PATCH/DELETE | `/api/me` | Bearer | Infos + pairs / `{name?, clientLabel?, clientType?}` / supprimer le client |
| POST | `/api/pairing-tokens` | Bearer | Nouveau QR (`pairUrl`) + code court |
| POST | `/api/pairings` | optionnelle | Consomme `{secret}` ou `{code}` (+ `deviceName, clientType, clientLabel`) ; crée le client mobile si besoin, sinon réutilise l'identité existante |
| DELETE | `/api/pairings/:peerId` | Bearer | Révocation (des deux côtés) |
| POST | `/api/links` | Bearer | `{messageId?, targetDeviceId, url}` → `201` nouveau / `200` doublon (`duplicate:true`) / `409` ID réutilisé autrement ; réponse avec `delivered` |
| GET | `/api/links` | Bearer | Historique reçu |
| DELETE | `/api/links/:id` | Bearer | Supprime un lien de son historique |
| POST | `/api/presence` | Bearer | `{conn}` acquitte un `ping` SSE (renouvelle le bail) · `{conn, state:"leave"}` = départ |
| POST | `/api/stream-tickets` | Bearer | Ticket SSE à usage unique (30 s) |
| GET | `/api/events` | ticket ou Bearer | Flux SSE : `ready {conn}`, `ping`, puis `url`, `paired`, `unpaired`, `url_deleted`, `peer_updated`, `presence` |
| GET | `/api/events/poll?cursor=&conn=` | Bearer | Long-polling (repli) : `{cursor, conn, events, reset?}`, attente max 20 s |

Message temps réel :
```json
{ "v": 1, "type": "url", "id": "lnk_…", "targetDeviceId": "dev_…", "senderDeviceId": "dev_…",
  "senderName": "Pixel", "url": "https://example.com/", "timestamp": "2026-09-27T18:52:16.431Z" }
```

### Temps réel : SSE + repli long-polling

- À l'ouverture du flux, le serveur envoie `event: ready`. Le client ne se considère connecté **qu'à la réception de cet événement**. `onopen` ne suffit pas : il se déclenche dès que les en-têtes arrivent, même si le corps est retenu.
- Frames : `id: <boot>:<seq>` / `event: <type>` / `data: <json>` puis ligne vide. Heartbeat `: heartbeat` toutes les 20 s. En-têtes `Cache-Control: no-cache, no-transform` et `X-Accel-Buffering: no`, avec `flushHeaders()` et `setNoDelay`.
- Si `ready` n'arrive pas en 4 s, un proxy bufferise le flux : le client bascule en **long-polling** (`/api/events/poll`). Chaque réponse se termine, donc elle traverse n'importe quel proxy. La livraison reste quasi instantanée : une requête en attente est libérée dès qu'un événement est publié.
- Le hub garde un **backlog court par device** (50 événements / 5 min) avec des curseurs `<bootId>:<seq>`. Aucun événement n'est perdu entre deux polls. Un curseur inconnu (redémarrage du serveur) renvoie `reset: true`, et le client recharge son état via l'API REST.

#### Présence (Online / Offline)

**Online** signifie que la destination a *maintenant* un récepteur temps réel en bonne santé, capable de recevoir un lien immédiatement. Être associé ne suffit pas. C'est un **bail (lease) par connexion**, renouvelé uniquement par une preuve venant du client :

| Transport | Preuve | Expiration |
|---|---|---|
| SSE | le client acquitte `ready` puis chaque `ping` (toutes les 10 s) via `POST /api/presence {conn}` | 25 s sans acquittement. Un flux jamais acquitté (bufferisé par un proxy) ne compte jamais |
| Long-poll | **arrivée** d'une requête (`?conn=`). Une requête qui se termine par timeout ne renouvelle rien | 30 s (le temps d'attente d'un poll est de 20 s) |

- **Départ propre** : sur `pagehide`, le client envoie `POST /api/presence {conn, state:"leave"}` (`fetch keepalive`) et passe Offline immédiatement. Une connexion fermée côté serveur, ou un poll abandonné avant la réponse, a le même effet.
- **Navigateur tué ou connexion à moitié ouverte** : le bail expire, donc Offline en ≤ 30 s. Un balayage toutes les 2 s ferme les flux SSE périmés.
- Chaque transition online↔offline publie `{type:"presence", deviceId, online}` aux appareils associés. Le téléphone garde un flux ouvert tant que l'écran est visible et met à jour Online/Offline en direct.
- `POST /api/links` → `delivered` suit la même définition. `false` signifie qu'aucun récepteur sain n'existait : le lien reste en historique (store-and-forward inchangé) et le téléphone affiche « delivered when it reconnects ».
- Pourquoi : une écriture serveur (SSE ou heartbeat) ne prouve rien, car un proxy ou une connexion TCP à moitié ouverte l'accepte même quand le navigateur n'existe plus. Avant ce changement, un poll terminé par timeout ré-horodatait la présence, et un flux SSE ouvert valait Online indéfiniment.

**Cause mesurée pour Cloudflare Quick Tunnel** (`*.trycloudflare.com`, cloudflared 2026.9.3, QUIC comme HTTP/2) : les en-têtes arrivent en ~300 ms, mais le corps est retenu **jusqu'à la fin de la réponse**, quels que soient le `Content-Type`, la taille (même 70 Ko) ou la compression. Un flux SSE n'y délivre donc jamais rien. `scripts/proxy.ts` reproduit ce comportement (`buffer`) pour les tests. Les tunnels nommés, Caddy et nginx (avec `X-Accel-Buffering: no`) laissent passer SSE.

---

## 2. Installation & lancement

Prérequis : Node ≥ 20.

```bash
npm install
npx playwright install chromium   # seulement pour les tests E2E

npm run dev      # dev : rebuild client à chaud + serveur tsx watch → http://localhost:3000
# ou
npm run build && npm start        # production
```

Ouvrez `http://localhost:3000` sur l'ordinateur. La page téléphone est `/m`.

### Variables d'environnement (`.env.example`)

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `0.0.0.0` | Interface (0.0.0.0 = joignable depuis le LAN) |
| `PUBLIC_URL` | *(vide)* | Origine encodée dans le QR. Vide ⇒ déduite de la requête, `localhost` étant remplacé par l'IP LAN de la machine. **Obligatoire en production.** |
| `DB_PATH` | `./data/sendlink.db` | Fichier SQLite (`:memory:` possible) |
| `TRUST_PROXY` | `0` | `1` derrière Caddy/Nginx (lit `X-Forwarded-For` / `-Proto`) |
| `PAIRING_TTL_SECONDS` | `120` | Durée de vie d'un QR/code |
| `NODE_ENV` | — | `production` active HSTS |

(Les variables sont lues depuis l'environnement ; utilisez `node --env-file=.env dist/server.js` pour charger un fichier `.env`.)

---

## 3. Tester avec un vrai téléphone (réseau local)

1. Ordinateur et téléphone sur le **même Wi-Fi**.
2. `npm run build && npm start` — le serveur affiche `Phones on your network will reach it at http://192.168.x.y:3000`.
3. Sur l'ordinateur, ouvrez **`http://localhost:3000`**. Le QR code pointe automatiquement vers `http://192.168.x.y:3000/m#pair=…`.
4. Scannez avec l'appareil photo du téléphone → la page s'ouvre, l'association est faite.
5. Collez une URL → **Send** → elle apparaît sur l'ordinateur.

Si le téléphone n'arrive pas à joindre le serveur : pare-feu (`sudo ufw allow 3000/tcp`), ou Wi-Fi « invité » isolant les clients.

**Pour tester l'installation PWA et le menu Share (Android)**, il faut HTTPS. Le plus simple (le temps réel y passe en long-polling automatiquement, ~250 ms de latence mesurée) :
```bash
npx cloudflared tunnel --url http://localhost:3000     # donne une URL https://….trycloudflare.com
PUBLIC_URL=https://….trycloudflare.com TRUST_PROXY=1 npm start
```
Puis sur Android/Chrome : ouvrir le lien du QR → menu ⋮ → *Installer l'application*. SendLink apparaît alors dans le menu **Partager** de toutes les apps.

---

## 4. Production

L'application ne dépend d'aucun hébergeur ni tunnel : seule `PUBLIC_URL` définit l'origine encodée dans les QR codes.

**Checklist** pour `https://sendlink.example` :

1. **Build & variables**
   ```bash
   npm ci && npm run build
   NODE_ENV=production PORT=3000 HOST=127.0.0.1 \
   PUBLIC_URL=https://sendlink.example TRUST_PROXY=1 DB_PATH=/var/lib/sendlink/sendlink.db \
   node dist/server.js
   ```
   `HOST=127.0.0.1` : seul le reverse proxy est exposé.
2. **Reverse proxy + HTTPS** (Caddy obtient et renouvelle le certificat automatiquement) :
   ```caddy
   sendlink.example {
     encode zstd gzip
     reverse_proxy 127.0.0.1:3000 {
       flush_interval -1          # SSE : ne pas bufferiser
     }
   }
   ```
   Nginx : `proxy_buffering off;` sur `/api/events` (le serveur envoie déjà `X-Accel-Buffering: no`), `proxy_read_timeout 120s;`, `proxy_http_version 1.1;`. Si un proxy bufferise malgré tout, le client bascule seul en long-polling.
3. **`TRUST_PROXY=1`** : uniquement derrière un proxy qui écrase `X-Forwarded-For`. Sinon les limites de débit s'appliquent à l'IP du proxy (tous les clients partagés), ou pire, un client pourrait falsifier son IP.
4. **Rate limiting** (en mémoire, par process) : envoi 30/min/appareil, connexion 20/min/IP, création d'ordinateur 20/h/IP, requêtes authentifiées 300/min **par appareil**, et un garde-fou anti-flood de 1200/min/IP. Le trafic authentifié est limité par appareil et non par IP : plusieurs appareils partagent souvent une IP (NAT domestique ou de bureau), et chaque onglet ouvert acquitte un ping de présence toutes les 10 s. Suffisant pour un seul process. Pour plusieurs instances, les déplacer dans Redis, ou limiter aussi au niveau du proxy.
5. **Stockage persistant** : `DB_PATH` sur un disque persistant (volume Docker, `/var/lib/sendlink`). SQLite en mode WAL : garder `sendlink.db`, `-wal` et `-shm` sur le même disque. Les migrations s'exécutent au démarrage.
6. **Sauvegardes** : `DB_PATH=/var/lib/sendlink/sendlink.db npm run backup -- /backups/sendlink-$(date +%F).db`. L'API de backup SQLite est sûre pendant que le serveur tourne. Une copie brute du fichier `.db` ne l'est pas. Planifier (cron/systemd timer) et tester une restauration : arrêter le service, remplacer le fichier, redémarrer.
7. **Supervision du process** (systemd) :
   ```ini
   [Service]
   WorkingDirectory=/opt/sendlink
   ExecStart=/usr/bin/node dist/server.js
   EnvironmentFile=/etc/sendlink.env
   Restart=always
   User=sendlink
   ```
   Arrêt propre sur `SIGTERM` (connexions SSE fermées, DB fermée).
8. **Logs** : stdout/stderr (démarrage, erreurs 500 avec pile), à consulter via `journalctl -u sendlink`. Aucun token, secret de pairing ni URL envoyée n'est journalisé par l'application. Le secret du QR est dans le fragment `#`, donc jamais présent dans les logs d'accès du proxy.
9. **Healthcheck** : `GET /healthz` → `200 {"ok":true}` si le process répond **et** si la base SQLite est lisible, `500` sinon. À brancher sur le monitoring ou le `HEALTHCHECK` Docker.
10. **Un seul process** : le hub temps réel est en mémoire. Ne pas lancer plusieurs instances derrière un load balancer sans pub/sub partagé (voir §1, Temps réel).

Ne rien déployer sans avoir fait tourner `npm run validate`.

## 5. Pairing

1. L'ordinateur s'enregistre (`POST /api/devices`) et reçoit **un credential propre au device** (`sld_` + 256 bits aléatoires), stocké en `localStorage`. Le serveur ne garde que son **SHA-256**.
2. Il demande un pairing token : un **secret de 256 bits** (pour le QR) et un **code de 8 caractères** Crockford base32 (40 bits, pour la saisie manuelle).
   - expiration **2 min**, **usage unique** (consommé dans une transaction SQLite), un seul token actif par device (en générer un nouveau invalide l'ancien), stockés **hachés**.
   - l'écran le fait tourner automatiquement à expiration.
3. Le QR contient `https://host/m#pair=<secret>`. Le secret est dans le **fragment (`#`)** : il n'est jamais envoyé dans une URL au serveur, ni loggé par un proxy, ni transmis en `Referer`. La page mobile l'efface de la barre d'adresse immédiatement.
4. Le téléphone le poste à `/api/pairings`. Le serveur vérifie, marque le token utilisé, **crée le device mobile avec son propre credential**, enregistre la relation, et notifie l'ordinateur par SSE.
5. Un téléphone déjà enregistré qui scanne un autre ordinateur réutilise son credential (multi-ordinateurs).
6. **Révocation** : « Unpair » (sur l'un ou l'autre device) supprime la relation ; tout envoi ultérieur est refusé (403) et les deux côtés sont notifiés. `DELETE /api/me` supprime le device et son credential.

---

## 6. Sécurité

| Sujet | Mesure |
|---|---|
| Tokens | `crypto.randomBytes` (256 bits), stockés hachés SHA-256, jamais dans une URL persistante |
| SSE | `EventSource` ne peut pas envoyer de header → **ticket à usage unique, 30 s**, échangé contre le Bearer. Les clients natifs peuvent utiliser directement `Authorization`. |
| Autorisation | Envoi autorisé **uniquement** si une relation de pairing existe ; un device inconnu et un device non associé donnent la même erreur 403 (pas d'énumération) |
| Routage | Le hub SSE écrit seulement sur les connexions du device cible ; l'historique est filtré par `target_id` |
| URLs | Validation stricte serveur : `http:`/`https:` uniquement, ≤ 2048 caractères, pas d'espaces/caractères de contrôle, pas d'identifiants `user:pass@`. Revalidée côté client avant de créer un `href`. |
| XSS | Aucun `innerHTML` (règle ESLint qui l'interdit dans le client), rendu en `textContent` ; CSP stricte `script-src 'self'` sans inline |
| Ouverture | **Jamais d'ouverture automatique.** « Open » = clic explicite, `noopener,noreferrer` ; la notification ne fait que focaliser la fenêtre |
| Rate limiting | pairing 20/min/IP (protège le code court : 2⁴⁰ possibilités, 2 min, 20 essais), envoi 30/min/device, enregistrement 20/h/IP, 300/min par appareil authentifié, anti-flood 1200/min/IP |
| Entrées | JSON uniquement (415 sinon), corps ≤ 8 Ko, noms nettoyés et tronqués |
| Headers | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP, HSTS en production |
| Transport | **HTTPS/WSS obligatoire en production** : mettre le serveur derrière Caddy (`reverse_proxy localhost:3000`, TLS automatique), `TRUST_PROXY=1`, `PUBLIC_URL=https://…`. Désactiver le buffering pour `/api/events` si Nginx (déjà signalé par `X-Accel-Buffering: no`). |

**Préparation au chiffrement E2E** : le message est versionné (`v: 1`) et opaque pour le routage (le serveur n'utilise que `targetDeviceId`) ; `devices.public_key` est réservé. Une v2 : chaque device génère une paire X25519, la clé publique est échangée pendant le pairing (le QR peut en porter l'empreinte pour empêcher un MITM serveur), le téléphone chiffre l'URL et le serveur stocke un `ciphertext` à la place de `url`. La validation d'URL passe alors côté client récepteur.

---

## 7. Tests & validation

```bash
npm run lint        # ESLint (typescript-eslint)
npm run typecheck   # tsc --noEmit, mode strict
npm test            # vitest : 109 tests unitaires + intégration HTTP/SSE + reverse proxies
npm run build
npm run e2e         # Playwright : 14 scénarios (dont /m hors ligne et retry idempotent) desktop + mobile (Pixel 7 émulé), dont Share, multi-destinations, hors ligne, notification, et un derrière un proxy bufferisant
npm run validate    # tout ce qui précède
```

Couvert : création de device, génération/expiration/usage unique des pairing tokens, pairing QR et code court, envoi, réception **uniquement** par le bon device (en SSE réel), rejet d'URL invalides (`javascript:`, `data:`, `file:`, credentials…), envoi interdit vers un device non associé, révocation, tickets SSE à usage unique, rate limiting, headers, path traversal.
E2E : *desktop affiche le QR → le téléphone scanne → envoie une URL → le desktop la reçoit en temps réel → elle persiste dans l'historique après rechargement → suppression* ; plus : code manuel + pré-remplissage via Share Target + unpair, et réutilisation d'un QR refusée.

---

## 8. Limitations actuelles

- **Web Share Target** : Android (Chrome/Edge/Samsung Internet) uniquement, **après installation de la PWA, en HTTPS**. **iOS ne supporte pas Web Share Target** : sur iPhone, on copie le lien puis on ouvre SendLink (bouton *Paste*), ou on crée un Raccourci iOS (« Obtenir URL → Ouvrir `https://host/m?url=…` »). La vraie solution iOS est une Share Extension native (voir [`docs/ios-share-extension.md`](docs/ios-share-extension.md)).
- Le bouton *Paste* n'apparaît qu'en contexte sécurisé (HTTPS) ; en HTTP sur le LAN, on colle manuellement.
- Pas d'e-mail/compte : l'identité est le device. Effacer les données du navigateur = re-pairing.
- Derrière un Quick Tunnel, le premier passage en long-polling prend ~4 s après l'ouverture de la page (détection).
- Derrière un proxy, pensez à `TRUST_PROXY=1` : sans lui, tous les clients partagent l'IP du proxy pour le rate limiting.
- Serveur **mono-process** (hub SSE et rate limiting en mémoire). Suffisant pour des milliers d'utilisateurs ; au-delà, Redis pub/sub.
- Le serveur voit les URLs en clair (pas encore d'E2E).
- Notifications desktop : l'onglet SendLink doit rester ouvert (il peut être en arrière-plan). L'action **Open** passe par le service worker, donc HTTPS ou `localhost`. En HTTP via une IP LAN, on a une notification simple, cliquable.
- Fermeture après envoi depuis Partager : `window.close()` standard. Si Android/le navigateur ne l'autorise pas, l'écran de confirmation reste (bouton retour ou *Done*).

## 9. Du POC aux apps natives

L'API est déjà pensée pour des clients natifs (Bearer header, SSE sans ticket, types versionnés dans `src/shared/protocol.ts`).

1. **Déployer** le serveur en HTTPS avec un domaine stable (`PUBLIC_URL`). Utiliser des *App Links* / *Universal Links* sur `https://host/m` pour que le scan du QR ouvre l'app si elle est installée.
2. **Android** : app Kotlin avec une activité `ACTION_SEND` (`text/plain`) → sélecteur de device → `POST /api/links`. Credential dans EncryptedSharedPreferences / Keystore. Le scan du QR réutilise `/api/pairings`. Direct Share targets pour « YouTube → Share → *My PC* » en un tap.
3. **iOS** : app SwiftUI + **Share Extension**, credential partagé via un App Group Keychain. Même API. Détails : [`docs/ios-share-extension.md`](docs/ios-share-extension.md).
4. **Réception native sur ordinateur** : app menubar/tray (Tauri ou Electron léger) ou extension Chrome/Edge consommant `/api/events` avec le header Bearer → notifications système natives, même onglet fermé. Push quand l'app est fermée : Web Push / APNs / FCM déclenchés dans `SseHub.publish` si le device est hors ligne.
5. **E2E** (voir §5), puis multi-comptes/sync si nécessaire (ajouter une table `accounts` au-dessus de `devices`, sans changer le protocole de pairing).
