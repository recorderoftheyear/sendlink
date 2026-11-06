# Design — Chiffrement de bout en bout (E2EE) des messages SendLink

- **Statut** : conception, soumise à revue. **Aucune implémentation, aucune modification du code ni du schéma.**
- **Date** : 2026-09-27
- **Portée** : l'incrément 2 de l'[ADR local-first](adr-local-first-transport.md) (§22). La même enveloppe servira plus tard au transport LAN.
- **Vocabulaire**
  - **client** : une ligne `devices`, c'est-à-dire un navigateur ou la PWA qui détient un credential. **Relais** : le serveur SendLink et sa base.
  - **P** : le téléphone (émetteur). **D** : une destination desktop (récepteur). **R** : le relais.

---

## 0. Résumé

| | |
|---|---|
| **Construction recommandée** | **HPKE (RFC 9180), mode Auth**, suite **DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM** (`0x0010 / 0x0001 / 0x0001`), via **`@hpke/core`** (hpke-js, MIT, v1.9.0, adossé à WebCrypto, aucune primitive réimplémentée par nous) |
| **Authentification des clés** | Le QR code (canal visuel, jamais vu par le relais) transporte l'**empreinte de la clé de D** et un **secret de confirmation `k`** généré par D. P prouve sa clé avec `HMAC(k, …)` |
| **Clés privées** | P-256 ECDH **non extractibles**, générées par WebCrypto, stockées en IndexedDB (structured clone) |
| **Ce que le relais voit** | Routage, identifiants, horaires, tailles (rembourrées), clés publiques, noms d'appareils. **Pas l'URL** |
| **Limite majeure** | **Une application web E2EE ne protège pas contre un serveur qui sert du code malveillant.** Il faut séparer l'origine du code de celle du relais (§12.1). Sans cela, « E2EE » est trompeur |
| **Revue externe** | **Indispensable** avant de parler d'E2EE en production (§20) |

---

## 1. Modèle de menace et objectifs

### 1.1 Adversaires

| Adversaire | Capacités | Dans le périmètre ? |
|---|---|---|
| **Relais/base compromis ou malveillant** | Lit et modifie la base, les journaux et le trafic API. Rejoue, supprime, retarde, réordonne, **substitue des clés publiques**, injecte des messages, ment sur l'état des appareils | ✅ **Oui, c'est l'adversaire principal** |
| Attaquant réseau passif ou actif entre client et relais | TLS le couvre ; E2EE en défense en profondeur | ✅ |
| Personne qui voit ou photographie le QR | Pairing à usage unique, 2 min, confirmation visible « Phone connected : X » | ⚠️ Risque existant, inchangé |
| Code malveillant **servi par la même origine** que l'app (serveur compromis) | Exécute du JS dans l'app : lit l'URL **avant** chiffrement, utilise les clés non extractibles | ⚠️ **Hors de portée de toute crypto côté navigateur.** Traité par l'architecture (§12.1) |
| XSS dans l'app | Même effet pendant l'exécution de la page | Atténué (CSP stricte, pas d'`innerHTML`), non éliminé |
| Malware, root ou accès disque au téléphone ou au PC | Lit le stockage du navigateur | ❌ Hors périmètre (sécurité de l'appareil) |
| Adversaire quantique futur (« stocker maintenant, déchiffrer plus tard ») | Casse ECDH P-256 | ❌ Hors périmètre v1. Migration possible vers ML-KEM / X-Wing (disponibles dans hpke-js) |

### 1.2 Objectifs de sécurité distincts

- **A. Confidentialité vis-à-vis du relais** : R ne peut pas lire l'URL, ni dans les messages en transit, ni dans ceux stockés en attente, ni dans l'historique.
- **B. Authentification de bout en bout des pairs**
  - **B1, côté émetteur** : P a la garantie qu'un chiffré ne pourra être déchiffré **que** par la destination D avec laquelle il a été appairé, même si R est malveillant et tente de substituer la clé de D.
  - **B2, côté récepteur** : D a la garantie qu'un message déchiffré a été produit par le téléphone P appairé. Sinon R, qui connaît la clé publique de D, pourrait chiffrer lui-même des URL arbitraires pour D.
- **C. Intégrité et contexte** : le message ne peut être ni modifié, ni redirigé vers un autre destinataire, ni attribué à un autre émetteur, sans être rejeté.
- **D. Anti-rejeu** : un message rejoué n'est affiché qu'une fois, et un vieux message n'est pas ré-injecté des semaines plus tard.

**A seul est facile** : chiffrer vers une clé publique fournie par R. Mais sans **B1**, R peut fournir **sa propre** clé et tout lire (MITM). **Toute la difficulté est B, et elle se règle au pairing (§6).**

---

## 2. Constructions comparées

### 2.1 HPKE, RFC 9180 (recommandée)

- **Quoi** : un standard IETF de chiffrement à clé publique hybride. KEM + KDF + AEAD, avec quatre modes : Base, PSK, **Auth**, AuthPSK. Utilisé par TLS ECH, MLS et Oblivious HTTP.
- **Mode Auth** : l'émetteur utilise sa clé statique en plus d'une clé éphémère. Le récepteur, en ouvrant le message avec la clé publique de l'émetteur, **authentifie l'émetteur** (B2). La confidentialité vers la clé du destinataire donne A et B1, si cette clé est authentique.
- **Suite** :
  - `DHKEM(P-256, HKDF-SHA256)` (0x0010) : P-256 ECDH est supporté en **non extractible** par WebCrypto dans tous les moteurs depuis des années. X25519 existe désormais dans WebCrypto, mais P-256 n'apporte aucun risque de compatibilité ;
  - `HKDF-SHA256` (0x0001) ;
  - `AES-128-GCM` (0x0001), natif WebCrypto. ChaCha20-Poly1305 ne l'est pas.
- **Implémentation** : **`@hpke/core`** (projet hpke-js, `github.com/dajiaji/hpke-js`)
  - licence MIT, v1.9.0, modifiée en mars 2026 ;
  - une seule dépendance (`@hpke/common`), construite **uniquement sur WebCrypto** pour P-256, HKDF et AES-GCM ;
  - passe les vecteurs de test RFC 9180 et Wycheproof ;
  - fonctionne dans les navigateurs et Node (même code côté tests) ;
  - **non auditée formellement** : c'est l'un des motifs de la revue du §20.
- **Propriétés** (RFC 9180 §9.1)
  - ✅ confidentialité et authentification de l'émetteur (Auth), en supposant que les clés privées ne sont pas compromises ;
  - ❌ **pas de confidentialité persistante vis-à-vis de la compromission du destinataire** : qui obtient la clé privée de D lit tous les chiffrés passés qu'il a captés ;
  - ✅ confidentialité persistante vis-à-vis de la compromission de l'émetteur ;
  - ⚠️ **KCI** : qui obtient la clé privée de D peut forger des messages « de P » pour D. C'est acceptable ici : un attaquant qui détient la clé de D contrôle déjà D ;
  - l'interface **Export** fournit un secret partagé par message, qui sert à l'ACK authentifié (§9).
- **À vérifier dans un mini-spike avant implémentation (non supposé)** :
  1. `@hpke/core` accepte des `CryptoKeyPair` **non extractibles** générées par `crypto.subtle.generateKey`, en émetteur Auth comme en destinataire. Le destinataire doit fournir la paire complète : une clé privée seule obligerait à dériver la publique, donc à exporter ;
  2. l'interopérabilité navigateur (Chrome Android, Chrome/Firefox desktop) ↔ Node (tests) sur les vecteurs RFC 9180 de notre suite.

### 2.2 ECDH + HKDF + AEAD « à la main » avec WebCrypto

- Candidats reconnus :
  - **ECIES** (SEC 1 / ISO 18033-2) ;
  - **Web Push Message Encryption** (RFC 8291 + RFC 8188, ECDH P-256 + HKDF + AES-128-GCM, avec un « auth secret » partagé hors bande, proche de notre `k`).
- ➕ Aucune dépendance.
- ➖ **Il faudrait assembler nous-mêmes** la dérivation, les nonces, l'encodage et le contexte. C'est exactement le type de code où naissent les failles subtiles.
- ➖ RFC 8291 n'**authentifie pas l'émetteur** : quiconque connaît la clé publique et l'auth secret peut chiffrer, et R connaîtrait les deux s'il les distribuait. Il faudrait ajouter une signature ECDSA, c'est-à-dire une composition maison (ordre signature/chiffrement, liaison du contexte).
- ➖ Pas de bibliothèque navigateur maintenue pour RFC 8291 côté *récepteur*. Le navigateur l'implémente pour Web Push, mais ne l'expose pas en JS.
- **Verdict** : rejeté. HPKE est précisément la version standardisée, analysée et vectorisée de ce schéma.

### 2.3 Protocole de messagerie établi (Signal, Matrix Olm/Megolm, MLS)

- **Signal** (X3DH/PQXDH + Double Ratchet, `libsignal`) : confidentialité persistante et **post-compromise security**. Mais bibliothèque Rust avec bindings Node natifs, **pas de build navigateur maintenu**. Il faut un serveur de *prekeys* et un état de session par paire, fragile face au multi-onglet, au store-and-forward, à l'effacement du stockage et au multi-navigateur.
- **Matrix** (vodozemac, en WASM) : faisable, mais c'est un écosystème entier pour un besoin d'un message de ~2 Ko dans un seul sens.
- **MLS** (RFC 9420) : conçu pour des groupes. Implémentations TypeScript jeunes. Très supérieur au besoin.
- **Verdict** : **excessif aujourd'hui.** SendLink envoie des messages courts, unidirectionnels, sans conversation. Le gain de ces protocoles (FS/PCS face à la compromission d'un **appareil**) ne compense pas l'état de session et la complexité dans un navigateur. On compense partiellement par la **rotation des clés et la suppression des chiffrés** (§10). **À réévaluer** si le produit devient conversationnel ou si la FS contre la compromission du récepteur devient une exigence.

### 2.4 Variante écartée : HPKE Base + signature ECDSA

- Elle éviterait la KCI, mais demande une seconde paire de clés et une composition signature/chiffrement non standardisée.
- La KCI n'a pas d'impact réel dans notre modèle : la clé du récepteur compromise, c'est déjà le récepteur compromis. **Le mode Auth est préféré.**

---

## 3. Clés d'identité longue durée

- **Une paire de clés par client** (ligne `devices`) : P-256 **ECDH**, usages `["deriveBits"]`, `extractable: false` pour la clé privée. La clé publique est toujours exportable.
  - Même clé pour recevoir (destinataire HPKE) et pour s'authentifier comme émetteur (HPKE Auth). En DHKEM, c'est la même opération DH.
  - Pas de clé de signature séparée : l'authentification passe par HPKE Auth et par l'Export (§9).
- **Identifiant de clé** : `kid = base64url(SHA-256("sendlink/v1/key" ‖ SPKI(pk)))[0..16]`.
- **Empreinte** (QR et comparaison manuelle) : `fp = base64url(SHA-256("sendlink/v1/fp" ‖ SPKI(pk)))`, 256 bits.
- **Portée** : un client = une clé.
  - Chrome et Firefox sur le même PC ont des clés **différentes**, ce sont des destinations distinctes (modèle d'identité inchangé).
  - Les onglets d'un même navigateur partagent la clé (même origine, même IndexedDB).
  - La PWA Android partage la clé des onglets `/m` du navigateur qui l'a installée.
- **Génération**
  - Desktop : à l'enregistrement du client (`POST /api/devices`).
  - Téléphone : au premier pairing.
  - Clients existants : à la migration (§17).
- **Pas de synchronisation entre appareils.** Pas de sauvegarde : une clé perdue est une identité perdue (§11).

---

## 4. Stockage des clés dans le navigateur : ce qui est réellement garanti

**Mécanisme** : un `CryptoKey` est *structured-cloneable*. On l'enregistre tel quel dans IndexedDB : la base `sendlink-keys`, magasin `identity`, avec les clés courante et précédentes. Le navigateur **ne rend jamais les octets** d'une clé non extractible ; on relit un `CryptoKey` utilisable après redémarrage. Un ancien bug Firefox (DataCloneError sur les clés EC non extractibles, bug 1434898) est résolu dans les versions actuelles. **À revalider dans nos tests** sur Chrome, Firefox et Chrome Android.

| Garantie | Réalité |
|---|---|
| Survit au redémarrage du navigateur, de la PWA, du téléphone | ✅ oui (stockage persistant de l'origine) |
| Le JS ne peut pas exfiltrer la clé privée | ✅ oui (non extractible), **mais** du JS malveillant exécuté dans l'origine peut **l'utiliser** (oracle de déchiffrement) tant qu'il tourne |
| Protection matérielle (Android Keystore / TPM / Secure Enclave) | ❌ **non**. Les clés WebCrypto sont logicielles, stockées dans le profil du navigateur, protégées par le compte OS, sans preuve de non-exportabilité matérielle |
| Survit à « Effacer les données du site » / « cookies et données de sites » | ❌ **non**, clé perdue (avec le credential : même effacement) |
| Survit à la pression de stockage | ⚠️ seulement si `navigator.storage.persist()` est accordé (déjà demandé par SendLink ; Chrome l'accorde volontiers aux PWA installées). Sinon, l'origine peut être évincée **entière** (clé + credential ensemble) |
| Survit à un changement d'origine (nouveau domaine, nouveau quick tunnel) | ❌ **non**. La clé est liée à l'origine. **Il faut figer l'origine de l'app avant de lancer l'E2EE** (§12.1) |
| Navigation privée | ❌ éphémère : clé perdue à la fermeture |
| Safari (macOS) non installé | ⚠️ ITP peut effacer le stockage d'un site non visité depuis 7 jours. Destination Safari à documenter comme fragile |
| Désinstallation de la PWA Android | ⚠️ à vérifier. En général les données restent dans Chrome, mais ce n'est pas garanti |
| Sauvegarde / transfert vers un nouveau téléphone | ❌ non (voulu) |

**Conséquence de conception** : la clé privée et le credential vivent et meurent **ensemble** (même origine, même effacement). Une perte de clé est donc presque toujours une perte d'identité : l'appareil redevient inconnu et doit se ré-appairer (§11). Le cas « credential présent mais clé absente » (effacement partiel, bug) est détecté explicitement.

---

## 5. Enveloppe de message

### 5.1 Format

```text
Envelope (JSON, envoyé au relais) {
  "v": 1,
  "suite": "hpke-auth/p256-sha256-aes128gcm",
  "header": {                         ← en clair, lu par le relais pour le routage, AUTHENTIFIÉ (AAD)
    "messageId": "msg_…",             (même ID que l'incrément 1)
    "from": "<client id de P>",
    "to":   "<client id de D>",
    "kidS": "<kid de la clé de P>",
    "kidR": "<kid de la clé de D visée>",
    "createdAt": "2026-…Z",
    "kind": "link"                    ("link" | "key-update" ; §10)
  },
  "enc": "<base64url, 65 octets : clé publique éphémère P-256>",
  "ct":  "<base64url : AES-128-GCM(plaintext) avec tag>"
}
Plaintext (chiffré) = JSON { "url": "https://…" } + rembourrage (§5.3)
```

### 5.2 Opérations (API `@hpke/core`, noms à confirmer au spike)

- **Contexte commun**
  - `suite = new CipherSuite({ kem: DhkemP256HkdfSha256, kdf: HkdfSha256, aead: Aes128Gcm })` ;
  - `info = "sendlink/v1/message"` (contexte de protocole, fixe) ;
  - `aad = UTF8(JCS(header))`, avec **JCS = JSON Canonicalization Scheme (RFC 8785)** pour que les deux côtés sérialisent l'en-tête à l'identique.
- **Émission (P)**
  1. `ctx = createSenderContext({ recipientPublicKey: pkD (clé de confiance locale, §6), senderKey: IK_P (CryptoKeyPair), info })` ;
  2. `ct = ctx.seal(pad(plaintext), aad)`, puis `enc = ctx.enc` ;
  3. `ackKey = ctx.export("sendlink/v1/ack", 32)`, conservée localement avec le message en attente (§9).
- **Réception (D)**
  1. `ctx = createRecipientContext({ recipientKey: IK_D[kidR] (CryptoKeyPair), enc, senderPublicKey: pkP (clé de confiance locale, trouvée par header.from + kidS), info })` ;
  2. `plaintext = ctx.open(ct, aad)`. **Tout échec entraîne le rejet silencieux et un journal local**, jamais d'affichage ;
  3. ensuite : vérifications de l'en-tête (§8), puis validation http/https de l'URL (déjà existante), puis affichage.
- **Pourquoi l'en-tête en AAD** : le relais doit lire `to` pour router, mais toute modification de `messageId`, `from`, `to`, `kid*`, `createdAt` ou `kind` invalide le tag AEAD. Une redirection vers un autre destinataire échoue de toute façon : le chiffré n'est ouvrable qu'avec la clé privée visée.
- **Un seul `seal` par contexte** : un message = un contexte = une clé éphémère. Pas de réutilisation de nonce possible.

### 5.3 Rembourrage

Le texte clair est rembourré jusqu'au palier supérieur de **256 octets** (256, 512, …, jusqu'à 2 304 pour une URL de 2 048 caractères). Le relais voit une classe de taille, pas la longueur exacte de l'URL.

---

## 6. Pairing : comment on établit l'objectif B

### 6.1 Principe

- Le **QR code** est un canal **authentique et confidentiel vis-à-vis du relais** : il va de l'écran de D à la caméra de P, et son fragment `#…` n'est jamais envoyé à un serveur (comportement déjà en place).
- On y ajoute deux éléments générés **par le navigateur de D**, jamais transmis au relais :
  - **`fp_D`**, l'empreinte de la clé de D. Elle authentifie **D auprès de P** (B1) : P refusera toute clé de D fournie par le relais qui ne correspond pas ;
  - **`k`**, un secret aléatoire de 256 bits. Il authentifie **P auprès de D** (B2) : P prouve qu'il a bien lu ce QR en calculant un HMAC de sa clé avec `k`. Le relais, qui n'a jamais vu `k`, ne peut pas substituer la clé de P.

**Changement important** : aujourd'hui, le secret de pairing `s` est **généré par le serveur**. Un serveur malveillant le connaît. Il reste utile pour le routage et l'usage unique, mais **ne peut pas authentifier les clés**. D'où `k`, strictement côté client.

### 6.2 Transcript

```text
[D] génère IK_D (non extractible) ─ POST /api/devices {…, publicKey: SPKI(pkD)}
        R voit : pkD, kidD, nom, label navigateur.

[D] POST /api/pairing-tokens  →  R renvoie {secret s (serveur), code}
[D] génère k ← 32 octets aléatoires (crypto.getRandomValues), garde k en mémoire/sessionStorage le temps du token
[D] affiche QR = https://app/m#pair=s&k=k&fp=fp_D
        R voit : s (il l'a créé). R ne voit NI k NI le QR.

[P] scanne. Génère/charge IK_P. Calcule
      proof = HMAC-SHA256(k, "sendlink/v1/pair-proof" ‖ lp(s) ‖ SPKI(pkP) ‖ SPKI(pkD_attendu?)*)
    POST /api/pairings {secret: s, publicKey: SPKI(pkP), keyProof: proof, deviceName…}
        R voit : s, pkP, proof (inutilisable sans k).
    R répond {peer: D, publicKey: pkD'}
[P] vérifie fp(pkD') == fp_D (du QR). Sinon → ABANDON « Security check failed » (substitution par R).
[P] enregistre dans SON magasin de confiance local : D → (pkD, kidD, verified: "qr")
      * proof couvre pkD' reçu (après la vérif fp) afin de lier les deux clés.

R → [D] événement "paired" {peer: P, publicKey: pkP, keyProof}
[D] recalcule HMAC(k, …, SPKI(pkP), SPKI(pkD)) avec SON pkD. Comparaison en temps constant.
    Si différent → D refuse (« Security check failed »), supprime le pairing (DELETE) et n'enregistre rien.
    Sinon → magasin local de D : P → (pkP, kidP, verified: "qr"). k est effacé.
```

**Pourquoi c'est sûr** (à confirmer par la revue) :
- R ne peut pas remplacer pkD : P compare avec `fp_D` venu du canal visuel.
- R ne peut pas remplacer pkP : il lui faudrait `HMAC(k, …pkP'…)` sans connaître `k`.
- `proof` lie `s` (ce pairing), pkP et pkD : pas de réutilisation d'une preuve d'un autre pairing.
- Le HMAC est l'usage standard d'une MAC à clé secrète de haute entropie (RFC 2104). Ce n'est pas une primitive maison, mais **c'est une composition protocolaire à faire relire** (§20).

### 6.3 Pairing par code court (sans caméra)

- Le code de 8 caractères est **connu du serveur** et trop court pour porter `k` et `fp` (40 bits, attaquable hors ligne par un serveur qui voit le HMAC). **Il ne peut donc pas authentifier les clés.**
- Le pairing par code donne une paire **E2EE « non vérifiée »** (TOFU) : il protège contre une base volée ou un relais *devenu* malveillant **après** l'échange, pas contre un relais malveillant **pendant** l'échange.
- **Mise à niveau** : un **numéro de sécurité** est affiché sur les deux appareils, les 60 premiers bits de `SHA-256("sendlink/v1/safety" ‖ tri(SPKI(pkP), SPKI(pkD)))` sous forme de 12 chiffres. L'utilisateur les compare et confirme, et la paire passe à `verified: "safety-number"`. On peut aussi re-scanner un QR de vérification, qui utilise le même mécanisme `k`/`fp` sans créer de pairing.

### 6.4 Magasin de confiance local

Chaque client conserve en IndexedDB, **indépendamment de ce que dit le serveur** :

```text
peers[clientId] = { pk, kid, verified: "qr" | "safety-number" | "tofu", mode: "e2ee", since, previousKeys[] }
```

- **Seul ce magasin fait autorité** pour chiffrer (P) et pour authentifier l'émetteur (D).
- Les clés que le relais renvoie ne servent qu'à **détecter** un changement, jamais à l'accepter silencieusement.

---

## 7. Envoi, stockage, réception, ACK : transcript complet et ce que voit le relais

| Étape | Action | Ce que le relais voit |
|---|---|---|
| 1. Composer | P crée `messageId` (incrément 1), `header`, puis `seal` → enveloppe. `ackKey` gardée en mémoire avec le message en attente | rien |
| 2. Envoyer | `POST /api/links {messageId, targetDeviceId: D, envelope}`. Le serveur vérifie `header.from == client authentifié`, `header.to == targetDeviceId`, le pairing existant, la taille ≤ 4 Ko, le format | ids P/D, `messageId`, kids, `createdAt`, `kind`, classe de taille, horaire, IP, **pas l'URL** |
| 3. Stocker | Ligne `links` avec `envelope` (opaque) et `envelope_hash`, `url = NULL` | la même chose, au repos |
| 4. Livrer | SSE/long-poll `{type:"url", id, messageId, envelope}` à D, ou file d'attente si D est hors ligne (inchangé) | qui reçoit, quand |
| 5. Déchiffrer | D : `open` (§5.2), vérifications (§8), URL validée, affichage, notification, **historique local chiffré au repos par le navigateur** (IndexedDB) | rien |
| 6. ACK | D : `tag = HMAC(ackKey_R, "ack" ‖ messageId)` avec `ackKey_R = ctx.export("sendlink/v1/ack", 32)`, puis `POST /api/links/:id/ack {tag}` | qu'un ACK existe, et quand |
| 7. Retour | R relaie `{type:"ack", messageId, tag}` à P (flux ouvert ou prochain `/api/me`). P vérifie le tag avec son `ackKey`, puis passe de « ✓ Sent » à « ✓ Delivered » | rien de plus |

**Propriété de l'ACK** : seul le détenteur de la clé privée de D obtient le même secret Export. **R ne peut pas forger un « delivered ».** R peut seulement retenir ou retarder l'ACK (déni de service visible).

---

## 8. Vérifications à la réception, rejeu, `message_id` et idempotence

**À la réception, dans l'ordre (échec = rejet, rien n'est affiché) :**
1. `header.to` = moi ; `kidR` ∈ mes clés (courante ou en période de grâce).
2. `header.from` et `kidS` ∈ mon magasin de confiance, en mode `e2ee`. Émetteur inconnu ou révoqué : rejet.
3. `open` HPKE réussit (authentifie l'émetteur, l'en-tête et le contenu).
4. **Anti-rejeu** :
   - `(from, messageId)` ∉ ensemble des messages vus (IndexedDB, conservé 60 jours) ;
   - `createdAt` ∈ [maintenant − 60 j, maintenant + 10 min]. La fenêtre est large pour tolérer les horloges de téléphone et le store-and-forward, et elle est **plus longue que la rétention du relais** (§12.3) : un chiffré assez vieux pour sortir de l'ensemble « vu » ne peut plus être présenté.
5. URL http/https valide (revalidation existante), sinon rejet.

**`message_id` et chiffrement :**
- Le `messageId` est créé **avant** le chiffrement et scellé dans l'AAD : le relais ne peut pas le changer.
- **Idempotence** : un retry (échec ambigu, double tap, futur transport LAN) **renvoie exactement la même enveloppe**, mêmes octets. On ne re-chiffre jamais, car un nouvel `enc` donnerait un chiffré différent pour le même message.
  - Le client conserve l'enveloppe scellée avec le message en attente (déjà en mémoire depuis l'incrément 1).
- **Côté relais**, puisqu'il ne peut plus comparer les URL :
  - `(sender, messageId)` + même `envelope_hash` → `200 duplicate` (inchangé) ;
  - hash différent → `409`.
- **Côté destination** : déduplication finale par `(from, messageId)`, identique pour relais et LAN. Les doublons du relais (rejeu malveillant ou retries) donnent **une seule entrée**.
- **Rejeu malveillant d'un vieux chiffré** : rejeté par la fenêtre `createdAt` et l'ensemble des messages vus.
- **Messages supprimés, retardés ou réordonnés** : R peut toujours le faire. C'est un déni de service, que l'**absence d'ACK** rend visible à l'émetteur.

---

## 9. ACK authentifié : cas limites

- **ACK perdu** : P reste sur « ✓ Sent », sans faux « Delivered ». Pas de re-envoi automatique d'un message déjà accepté par le relais : le store-and-forward garantit la livraison. L'ACK n'est qu'une information.
- **ACK dupliqué** : idempotent.
- **Plusieurs onglets de D** : chacun peut déchiffrer (même clé, même ensemble « vu »). L'ACK est émis une fois, les doublons sont sans effet.
- `ackKey` côté P est gardée en mémoire tant que l'écran vit, et plus tard dans l'outbox. Après un redémarrage de P, un ACK tardif ne peut plus être vérifié : on affiche « Sent », pas « Delivered ». C'est acceptable.

---

## 10. Rotation des clés

- **Quand** : périodique (proposé tous les 90 jours) et à la demande (« réinitialiser les clés de cet appareil »).
- **Comment**
  1. Le client génère `IK'`.
  2. Il envoie à **chaque pair** un message `kind: "key-update"`, **scellé en HPKE Auth avec l'ANCIENNE clé** (émetteur `IK`) et contenant `{newPublicKey, newKid, validFrom}`.
  3. Le pair ouvre le message avec la clé qu'il fait déjà confiance, donc **la continuité est authentifiée et R ne peut pas insérer sa propre clé**.
  4. Le pair met à jour son magasin (`previousKeys[]` conservées pour vérification). Le relais reçoit aussi `newPublicKey`, à titre indicatif.
- **Période de grâce** : l'ancienne clé privée est conservée **≥ la rétention maximale des files du relais (30 jours)**, pour déchiffrer les messages en attente chiffrés vers `kidR` ancien. Ensuite elle est **supprimée** d'IndexedDB.
- **Effet sur la confidentialité persistante** : une fois l'ancienne clé supprimée **et** les chiffrés purgés du relais (§12.3), une compromission ultérieure de l'appareil ne révèle plus ces anciens messages. C'est une **FS grossière à l'échelle de la période de rotation**, pas une FS par message comme le Double Ratchet (§2.3).
- **Pair hors ligne pendant la rotation** : le `key-update` attend dans sa file comme un message ordinaire. En attendant, il chiffre encore vers l'ancienne clé, qui reste déchiffrable pendant la grâce.

---

## 11. Pannes et récupération

| Cas | Détection | Comportement |
|---|---|---|
| **Données du site effacées** sur P ou D (clé et credential perdus) | Plus de credential | L'appareil est **nouveau** : il doit être ré-appairé (QR). Côté pair, l'ancien client est « Remove » ou nettoyé. Les messages en file vers l'ancienne clé de D sont **indéchiffrables** : ils sont affichés comme « 1 lien illisible (clé réinitialisée) — demandez un renvoi », jamais comme une erreur muette |
| **Credential présent, clé absente** (effacement partiel, bug) | Clé introuvable au démarrage | Pas de génération silencieuse d'une clé « officielle ». Écran « Security keys missing — reconnect this device » et nouveau pairing QR (la nouvelle clé est authentifiée par le QR) |
| **Le relais annonce une nouvelle clé pour un pair** sans `key-update` authentifié | Clé ≠ magasin local | **Refus d'envoyer** vers la nouvelle clé. Message « The security key of Linux PC · Chrome changed — scan its code again to confirm ». **Jamais de repli en clair** |
| **Clé de destinataire périmée** (P chiffre vers `kidR` ancien) | D connaît encore `kidR` en grâce | Déchiffré normalement. Après la grâce : message illisible + demande de renvoi (la rotation normale l'évite) |
| **Appareil retiré** (« Remove ») | Pairing supprimé chez R **et** pair supprimé du magasin local | Les messages futurs de cet émetteur sont rejetés par D (émetteur inconnu), même si R les route. Clé du pair effacée localement |
| **Appareil compromis ou perdu** | Action de l'utilisateur | « Remove » sur chaque pair. Les autres appareils peuvent aussi faire tourner leurs clés. Les messages passés **déjà lus** par l'appareil compromis ne peuvent pas être protégés rétroactivement |
| **Chiffrés dupliqués** (retry, rejeu) | `(from, messageId)` | Une seule entrée (§8) |
| **Destinataire hors ligne** | Bail de présence (existant) | Chiffré en file (store-and-forward inchangé), déchiffré au retour. Le téléphone affiche « queued » comme aujourd'hui |
| **Échec de déchiffrement / en-tête incohérent** | `open` échoue ou vérification §8 | Rejet, journal local, compteur visible en mode développeur. Jamais d'affichage partiel |
| **Serveur renvoyant du clair à un pair E2EE** (tentative de rétrogradation) | Mode `e2ee` dans le magasin local | Refus d'afficher un lien en clair d'un pair E2EE. Refus d'envoyer en clair à un pair E2EE, **même si le serveur prétend qu'il est « legacy »** |

---

## 12. Architecture, stockage et métadonnées

### 12.1 La limite fondamentale : qui sert le code ?

- Aujourd'hui, **le même serveur** sert la PWA (HTML, JS, service worker) **et** l'API. Un relais compromis peut donc servir un `mobile.js` modifié qui lit l'URL avant chiffrement, ou utilise la clé non extractible. **Aucune cryptographie côté navigateur ne l'empêche.**
- **Exigence pour prétendre à l'E2EE face à un relais compromis** :
  1. **Séparer les origines**
     - **app** : `https://app.sendlink.example`, fichiers statiques immuables, versionnés, construits de façon reproductible, hébergés **indépendamment du relais** (hébergeur statique distinct, accès de déploiement séparé) ;
     - **relais** : `https://relay.sendlink.example`, API seule, appelée en CORS, `connect-src` restreint à cette origine.
  2. **Vérifiabilité** : hash des bundles publiés avec les versions du code source. SRI pour tout script. Le service worker pré-cache une version précise, et une mise à jour est un nouveau build publié. La **transparence du code web** (WEBCAT, extensions de vérification) est une piste future, non supposée disponible.
  3. **Figer l'origine de l'app avant l'E2EE** : les clés sont liées à l'origine (§4). Un changement d'origine détruit toutes les clés et oblige tout le monde à se ré-appairer. Les quick tunnels (URL changeante) sont **incompatibles** avec une E2EE durable.
- **Avec une seule origine** (déploiement actuel ou auto-hébergé), l'E2EE protège encore contre une **base volée**, des **journaux** et un **relais compromis *sans* modification du code servi**, mais pas contre un opérateur actif. Il faut le dire ainsi dans le produit.

### 12.2 Métadonnées qui restent visibles au relais (inévitable ou hors portée)

- **Graphe social** : quel téléphone est associé à quelles destinations, et quand.
- Identifiants de clients, `messageId`, kids, **clés publiques**, `createdAt`, `kind` (lien ou rotation).
- **Horaires** d'envoi, de livraison et d'ACK. Fréquence d'usage. **Présence** (baux).
- **Classe de taille** du lien (rembourrage par paliers de 256 octets).
- **Noms d'appareils** (« Galaxy S24 », « Linux PC · Chrome ») et `sender_name` : aujourd'hui en clair. Les chiffrer entre pairs est possible plus tard (hors portée v1).
- Adresses IP, user-agents (en-têtes HTTP), fuseau implicite.
- **Plus tard, pour le LAN** : adresses LAN chiffrées pour les pairs (ADR §19), mais les horaires d'annonce restent visibles.

### 12.3 Rétention et historique

- **Aujourd'hui** : l'historique (200 liens par destination) est lu depuis le serveur.
- **Avec l'E2EE**
  - L'**historique de référence devient local à la destination** : texte clair dans IndexedDB, protégé par le profil du navigateur.
  - Le relais conserve un chiffré **jusqu'à l'ACK, plus 7 jours** (rechargement, multi-onglet, un autre onglet du même navigateur), et **au plus 30 jours** sans ACK, avant purge.
  - Ça limite ce qu'une compromission tardive de la clé de D permettrait de déchiffrer depuis la base. C'est cohérent avec la rotation (§10).
- **Changement produit** : effacer les données du site sur le PC efface l'historique. De toute façon, il deviendrait illisible sans la clé.

---

## 13. Multiples destinations

- Une enveloppe par destination : **clé différente**, `to` et `kidR` différents. Chrome et Firefox du même PC sont deux destinataires cryptographiques distincts.
- Un envoi vers plusieurs destinations (non proposé dans l'UI actuelle) = plusieurs messages, chacun avec son `messageId`.
- Plus tard, l'agent LAN de l'ADR aura sa propre clé. Les messages resteront **chiffrés vers le client navigateur ciblé**, l'agent ne faisant que les stocker et les relayer localement. Son compromis n'expose donc pas les URL, sauf si l'on décide qu'il affiche des notifications en clair (choix à faire le moment venu).

---

## 14. Hors ligne et store-and-forward

- Inchangé dans son principe : le relais stocke **un chiffré** au lieu d'une URL. `delivered` et les baux de présence ne changent pas.
- Le téléphone hors ligne (incrément 1) peut sceller l'enveloppe **localement** : la clé de D est dans le magasin local. Plus tard, une outbox persistante pourra la renvoyer. Rien ne change dans le message « Not sent » actuel.
- La période de grâce des clés (§10) couvre la durée maximale de file.

---

## 15. Hypothèses de sécurité

1. P-256 ECDH, HKDF-SHA256 et AES-128-GCM sont sûrs. L'implémentation WebCrypto du navigateur est correcte.
2. `@hpke/core` implémente correctement RFC 9180. C'est corroboré par les vecteurs de test, **non audité**.
3. Le **code de l'app est intègre** : origine séparée et non compromise (§12.1).
4. Le canal QR (écran → caméra) est authentique : pas de QR remplacé physiquement devant l'utilisateur au moment du scan.
5. `crypto.getRandomValues` est un bon générateur aléatoire.
6. Les appareils eux-mêmes (OS, navigateur, profil) ne sont pas compromis.
7. L'utilisateur lit les avertissements « Security check failed » / « key changed » et ne les contourne pas. Il n'existe **aucun bouton pour les contourner**.

## 16. Limites connues

- **Pas de FS vis-à-vis de la compromission du destinataire** (propriété de HPKE), seulement une FS grossière via rotation et purge. **Pas de post-compromise security.**
- **KCI** en mode Auth (voir §2.1), jugée sans impact supplémentaire ici.
- **Code servi par le web** : l'E2EE ne vaut que si l'origine du code est digne de confiance (§12.1).
- Clés **logicielles**, non protégées matériellement ; XSS = oracle pendant l'exécution.
- Pairing par code : TOFU tant que le numéro de sécurité n'a pas été comparé.
- Métadonnées (§12.2). Déni de service par le relais (suppression, retard) toujours possible, seulement détectable par l'absence d'ACK.
- Pas de sauvegarde de clés : effacer les données du site = ré-appairer.
- Validation serveur des URL impossible sur un chiffré : **seule la validation côté destination protège** (déjà en place). Le serveur garde les limites de taille et de débit.

---

## 17. Migration des appareils déjà appairés

1. **Phase 0, compatible** : les clients déployés génèrent leur clé et publient `publicKey`. Aucun changement de comportement : les messages restent en clair.
2. **Phase 1, E2EE opportuniste « non vérifiée »**
   - Pour chaque paire existante où les deux côtés ont une clé, échange de clés **via le relais** : paire `verified: "tofu"`.
   - Dès lors, **les deux clients refusent le clair entre eux** (§11), selon **leur magasin local** et non l'avis du serveur.
   - Protège contre une base volée, les journaux et un relais qui deviendrait malveillant ensuite. **Ne protège pas** contre un relais malveillant *au moment* de cet échange.
3. **Phase 2, vérification** : une invite discrète « Verify this connection », via un QR de vérification sur le PC ou la comparaison du numéro de sécurité, fait passer la paire en `verified: "qr"`. Les nouveaux pairings sont directement `qr`.
4. **Historique en clair existant**
   - Il a **déjà été exposé** au serveur, et la migration ne peut pas l'effacer rétroactivement de ses sauvegardes.
   - Proposition : le desktop importe son historique en clair dans son stockage local, puis **le serveur supprime les URL en clair** (`url = NULL`, en gardant les métadonnées de ligne).
5. **Fin du clair** : une version ultérieure du relais refuse `url` en clair pour toute paire dont les deux clients ont annoncé E2EE. C'est de la défense en profondeur, la vraie garantie restant côté client.
6. **Pas de rétrogradation automatique** : une paire E2EE ne redevient jamais « legacy », sauf ré-appairage explicite.

---

## 18. Changements de schéma et d'API requis (à implémenter plus tard)

**Migrations** (additives, puis une reconstruction de table) :
- **v4** :
  - `device_keys(device_id, kid PRIMARY KEY, public_key TEXT, created_at, retired_at NULL)` : historique des clés publiques, à titre indicatif et non autoritaire ;
  - `devices.public_key` (colonne existante) reçoit la clé courante, `devices.key_id` est ajouté ;
  - `links.envelope TEXT NULL`, `links.envelope_hash TEXT NULL`, `links.acked_at INTEGER NULL`, `links.ack_tag TEXT NULL`, `links.kind TEXT NOT NULL DEFAULT 'link'`.
- **v5, reconstruction de `links`** : SQLite ne sait pas relâcher `NOT NULL`, il faut `CREATE` / copie / `DROP` / `RENAME` dans une transaction pour rendre `url` **nullable**. Contrainte ajoutée : `CHECK ((url IS NULL) <> (envelope IS NULL))`, soit exactement une forme. Tests de migration sur des bases v1 à v3 réelles, comme aujourd'hui.

**API** :
- `POST /api/devices`, `PATCH /api/me` : `publicKey` (SPKI base64url) ; `keyUpdate`.
- `POST /api/pairings` : `publicKey`, `keyProof`. Réponse : `publicKey` du pair. L'événement `paired` porte `publicKey` + `keyProof`.
- `GET /api/me` : `publicKey`/`kid` des pairs (indicatifs).
- `POST /api/links` : `{messageId, targetDeviceId, envelope}`.
  - Le serveur vérifie `header.from/to` = expéditeur authentifié / cible, la taille (≤ 4 Ko) et le format.
  - Idempotence via `envelope_hash`.
  - `url` en clair accepté seulement pour les paires legacy (phase de migration).
- `POST /api/links/:id/ack {tag}` ; événement temps réel `ack`.
- Événements `url` : `envelope` au lieu de `url` pour les paires E2EE.
- Purge planifiée des chiffrés (§12.3).
- Nouveau **déploiement** : origine app ≠ origine relais (§12.1). CORS limité à l'origine app.

**Côté client** : magasin de clés et de confiance IndexedDB, écrans « Security check failed », « key changed », « Verify », numéro de sécurité, historique local.

---

## 19. Stratégie de test

**Correction cryptographique**
- Vecteurs **RFC 9180** pour notre suite exacte (mode Auth, `0x0010/0x0001/0x0001`) exécutés en CI contre la version **épinglée** de `@hpke/core`.
- Aller-retour sceller/ouvrir en Node et **dans Chromium, Firefox et Chrome Android** (Playwright + test manuel), avec des **clés non extractibles**.
- Interopérabilité : un message scellé dans un navigateur s'ouvre dans l'autre.

**Persistance des clés**
- `launchPersistentContext` Playwright : génération, fermeture du navigateur, réouverture, déchiffrement OK (Chromium, Firefox).
- Manuel sur S24 : PWA tuée, téléphone redémarré, Chrome mis à jour, puis la clé est toujours utilisable.
- Effacement des données du site : le parcours de ré-appairage est proposé, aucune erreur muette.

**Relais malveillant** (un « relais adversaire » de test qui enveloppe l'app réelle)
- Substitution de `pkD` à la réponse de pairing → P abandonne (« Security check failed »).
- Substitution de `pkP` dans `paired` → D rejette (HMAC `k` invalide) et supprime le pairing.
- Relais qui chiffre lui-même une URL vers `pkD` avec sa propre clé émettrice → rejet (émetteur inconnu).
- Relais qui envoie une URL **en clair** « de P » à D (paire E2EE) → rejet.
- Relais qui prétend qu'une paire est « legacy » → P refuse d'envoyer en clair.
- Nouvelle clé annoncée sans `key-update` authentifié → P refuse d'envoyer et affiche « key changed ».

**Altération** : bit inversé dans `ct`, dans `enc`, ou dans chaque champ de l'en-tête (`messageId`, `from`, `to`, `kidS`, `kidR`, `createdAt`, `kind`), troncature, suite inconnue → rejet, rien d'affiché.

**Redirection** : une enveloppe P→D livrée à D2 (autre client, même PC) → échec. Enveloppe P→D présentée « de P2 » → échec.

**Rejeu et doublons**
- La même enveloppe livrée deux fois → une seule entrée.
- Une vieille enveloppe (`createdAt` hors fenêtre) → rejet.
- Même `messageId`, enveloppe différente → `409` au relais et rejet côté D si elle arrive quand même.

**ACK** : tag forgé par le relais → P ne montre pas « Delivered ». ACK perdu → « Sent » reste affiché, sans renvoi.

**Rotation** : messages en file vers l'ancienne clé déchiffrés pendant la grâce, illisibles et signalés après. `key-update` forgé → ignoré.

**Non-fuite** : test d'intégration qui envoie des URL marqueurs puis **parcourt la base SQLite, les journaux serveur et les réponses API** : la chaîne n'apparaît jamais.

**Régression** : toute la suite actuelle (109 tests unitaires/intégration et 14 E2E) reste verte, et les paires legacy fonctionnent pendant la migration.

---

## 20. Revue de sécurité externe

**Oui, fortement recommandée avant d'appeler cette fonctionnalité « end-to-end encrypted » en production.**

Raisons :
1. la **composition de pairing** (`fp` + `HMAC(k)` + usage unique `s`) et le **protocole de rotation** sont propres à SendLink, même s'ils sont construits sur des standards ;
2. `@hpke/core` **n'a pas été audité formellement** ;
3. les subtilités propres au web (origine du code, service worker, XSS, stockage des clés) décident de la sécurité réelle bien plus que la crypto ;
4. un défaut d'E2EE est rarement visible par les tests fonctionnels.

**Périmètre proposé** : ce document et le protocole de pairing (idéalement avec une modélisation formelle légère, ProVerif/Tamarin, du pairing et de l'envoi), l'implémentation client (usage d'hpke-js, magasin de confiance, vérifications), la séparation des origines et le processus de build/déploiement.

**Formulation produit d'ici là** : « Links are encrypted so the SendLink server can't read them (beta) ». Pas « end-to-end encrypted ».

---

## 21. Recommandation (synthèse)

1. **Construction** : HPKE RFC 9180, **mode Auth**, DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, via **`@hpke/core`** épinglé (v1.9.x), clés P-256 non extractibles en IndexedDB. Authentification des clés par **QR (empreinte + secret `k` jamais vu par le serveur)**, numéro de sécurité pour le pairing par code. En-tête lié par AAD (JCS), ACK via l'interface Export, rotation authentifiée par l'ancienne clé.
2. **Hypothèses** : §15. **Limites** : §16.
3. **Schéma/API** : §18. **Migration** : §17 (clé → TOFU → vérification, sans jamais revenir au clair).
4. **Tests** : §19. **Revue externe** : §20.
5. **Avant tout code** :
   - (a) mini-spike de compatibilité `@hpke/core` + clés non extractibles sur S24, Chrome et Firefox ;
   - (b) décision sur la **séparation des origines** (app vs relais) et un domaine stable, sans laquelle l'objectif « relais compromis » n'est pas atteignable.

## Sources

- [RFC 9180 — Hybrid Public Key Encryption](https://datatracker.ietf.org/doc/html/rfc9180) (§5.1.3 mode Auth, §5.3 Export, §9.1 propriétés, KCI, FS)
- [hpke-js (`@hpke/core`) — README](https://github.com/dajiaji/hpke-js/blob/main/README.md) · [npm @hpke/core](https://www.npmjs.com/package/@hpke/core) · [JSR @hpke/core](https://jsr.io/@hpke/core)
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) · [RFC 2104 — HMAC](https://www.rfc-editor.org/rfc/rfc2104)
- [RFC 8291 — Message Encryption for Web Push](https://www.rfc-editor.org/rfc/rfc8291) · [RFC 9420 — MLS](https://www.rfc-editor.org/rfc/rfc9420)
- [Mozilla bug 1434898 — DataCloneError storing unextractable EC keys in IndexedDB](https://bugzilla.mozilla.org/show_bug.cgi?id=1434898)
- [Saving Web Crypto keys using IndexedDB (exemple)](https://gist.github.com/saulshanabrook/b74984677bccd08b028b30d9968623f5) · [Storing Cryptographic Keys in Persistent Browser Storage (Corella)](https://icmconference.org/wp-content/uploads/A33a-Corella.pdf)
