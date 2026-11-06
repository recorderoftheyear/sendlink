# ADR — Transport local-first avec relais Internet en secours

- **Statut** : **révision 2 — après spike sur appareil réel (Galaxy S24 + PC Linux)**. Proposé, en attente de validation. **Aucune implémentation production.** Le spike jetable vit dans `spikes/lan-lna/`, hors de SendLink.
- **Date** : 2026-09-27 (révision 1 : analyse ; révision 2 : résultats S1–S5 et conception détaillée)
- **Lecture** : les §3–§12 sont l'analyse initiale (révision 1). Les §13–§23 la **mettent à jour à partir des mesures réelles**. En cas de conflit, les §13+ prévalent.
- **Contexte produit** : V1 validée sur appareils réels. Android PWA (Web Share Target), destinations = onglets de navigateurs desktop, relais Node (SSE + long-poll), store-and-forward, baux de présence.

## 1. Question

Est-ce que SendLink peut livrer un lien **directement sur le réseau local**, y compris **quand l'accès Internet (WAN) est coupé mais que le Wi-Fi fonctionne**, avec la PWA Android actuelle, sans affaiblir la sécurité, et en gardant le relais comme secours ?

Test fondamental : routeur/Wi-Fi allumé, WAN coupé, téléphone et PC sur le même LAN, `YouTube → Partager → SendLink → PC`. Le lien doit arriver.

## 2. Réponse courte (révision 2)

1. **Prouvé sur appareil réel** : `YouTube → Partager → PWA SendLink installée → fetch() HTTP vers l'agent LAN` fonctionne sur Galaxy S24 / Chrome 153, **y compris WAN coupé et données mobiles coupées** (122 ms). Voir §13.
2. **Prouvé aussi** : avec les données mobiles actives et le Wi-Fi sans Internet (S5), Android route le trafic par le cellulaire et **le LAN devient injoignable depuis la PWA**. Aucune API web ne permet de forcer le Wi-Fi (§14). S5 est une condition légitime « LAN indisponible », **détectable** (`connection.type = cellular`).
3. **Le local-first est donc viable, mais seulement comme optimisation opportuniste.** On sonde en amont, on tente brièvement, on exige un accusé authentifié, sinon relais avec le même identifiant de message (§15–§16).
4. **Toujours requis** : un **agent desktop**. Un onglet ne peut pas écouter, ce que le spike confirme. La cryptographie, la découverte, la déduplication, le repli automatique et l'agent de production restent **à concevoir et prouver** (§17–§20).
5. **Recommandation : GO conditionnel** (§23). Commencer par un incrément qui apporte de la valeur **sans agent** (§22).

## 3. Contraintes navigateur/PWA établies

| Contrainte | Constat | Conséquence |
|---|---|---|
| Contenu mixte | Une page HTTPS ne peut pas faire de requête `http://` ni `ws://` vers une IP privée. Exceptions : `localhost`/`127.0.0.1`, et **la relaxation LNA** ci-dessous. | Sans LNA, pas de HTTP LAN depuis la PWA. |
| Local Network Access (ex-Private Network Access) | Depuis Chrome 142 desktop et **141 Android** (Intent to Ship), les requêtes d'un site public vers une adresse locale/loopback demandent une **permission par origine**. Si elle est accordée, **le blocage de contenu mixte est levé** pour les cibles reconnues locales : IP privée littérale, domaine `.local`, ou `fetch(url, { targetAddressSpace: "local" })`. | ✅ Une PWA HTTPS peut joindre `http://192.168.x.y` après une invite de permission (une fois par origine). |
| Types de requêtes couverts par LNA | `fetch()`, sous-ressources, sous-frames. **WebSocket, WebTransport et WebRTC ne sont pas encore couverts**, c'est prévu plus tard. Les service workers doivent obtenir la permission séparément. | Utiliser `fetch()` depuis la **page**, pas depuis le SW. Ne pas bâtir le transport sur WebSocket ou WebTransport vers le LAN, dont le statut va changer. |
| TLS pour une IP privée | Les CA publiques ne délivrent pas de certificat pour une IP privée ni pour `.local`. Un nom public pointant vers une IP privée (façon plex.direct) exige une **résolution DNS publique, impossible WAN coupé**. Installer une CA sur le téléphone est inacceptable produit. | Le canal LAN sera **HTTP** : la confidentialité et l'authentification viennent d'une **cryptographie applicative** (§7). |
| WebTransport `serverCertificateHashes` | Supporté sur Android. Il permet TLS avec un certificat auto-signé épinglé par hash (ECDSA, validité ≤ 14 jours). Mais il faut un serveur HTTP/3 (écosystème Node immature) et une rotation des hashes tous les ≤ 14 jours. Son avenir est discuté dans le groupe de travail. | Variante possible (§5-B'), pas le choix principal. |
| CORS | Les requêtes de `https://sendlink.example` vers l'agent sont cross-origin, donc préflight. | L'agent répond avec `Access-Control-Allow-Origin: <origine exacte>`. Ce n'est **pas** une mesure de sécurité (un attaquant hors navigateur l'ignore) : la sécurité est cryptographique. |
| Service worker | Aujourd'hui, notre SW ne met rien en cache. WAN coupé, **la navigation Share Target vers `https://sendlink.example/m` échoue** : DNS et serveur injoignables. | **Obligatoire** : SW avec *app shell* hors ligne et gestion de la navigation `/m?…`. |
| Découverte (mDNS) | Aucune API web de navigation mDNS/DNS-SD. Chrome traite `.local` comme local pour LNA, mais la **résolution `.local` sur Chrome Android n'est pas garantie**. | La découverte ne peut pas reposer sur mDNS côté téléphone. On utilise une **adresse annoncée et mise en cache** (§6). |
| WebRTC | Il fonctionne entre navigateurs, choisit un chemin LAN (candidats host/mDNS) quand c'est possible, **mais exige un échange SDP/ICE à chaque session**. Les empreintes DTLS peuvent être persistées, pas les candidats ni les identifiants ICE. | Pas de connexion possible sans canal de signalisation, donc **pas de mode WAN coupé** avec un relais Internet. |
| PWA / WebAPK Android | Le lancement Share Target est une navigation vers le scope de la PWA (même stockage que Chrome). La page vit le temps du partage : **pas de connexion persistante en arrière-plan**. | Pas de pré-connexion longue durée côté téléphone. Tout doit s'établir en < 1 s au moment du partage. |
| Android et « Wi-Fi sans Internet » | Android marque le réseau « pas d'accès Internet » et **peut basculer le trafic par défaut sur les données mobiles** si elles sont actives. Le trafic vers 192.168.x.y risque alors de ne pas passer par le Wi-Fi. | Pour le test fondamental : **données mobiles désactivées**, ou vérifier le routage (spike). Données mobiles actives, le partage passera par le relais (le PC, lui, n'aura pas Internet, donc lien mis en file d'attente). |
| Network Information API | `navigator.connection.type` (`wifi`/`cellular`) est disponible sur Chrome Android. | Heuristique gratuite : en `cellular`, **ne pas tenter le local**. |
| Scan de ports / fingerprinting | Exclus. | Découverte par annonce authentifiée uniquement. |

## 4. Deux problèmes distincts

**(1) Découverte** : savoir qu'une destination est joignable localement, et où.
**(2) Transport sécurisé** : lui parler en prouvant qui on est, et en vérifiant que c'est bien elle.

| Option de découverte | Hors Internet | Changement d'IP (DHCP) | Vie privée | Verdict |
|---|---|---|---|---|
| Adresse LAN annoncée par l'agent **via le relais** (quand Internet est là), mise en cache par le téléphone | ✅ (cache) | ⚠️ tant que l'IP ne change pas pendant la coupure (baux DHCP longs en pratique) | Le relais voit l'IP privée, sauf si l'annonce est chiffrée pour les pairs (recommandé) | **Retenu** |
| Adresse LAN échangée **au pairing** (QR / réponse de pairing) | ✅ | ❌ figée | Bonne | Complément (amorçage) |
| mDNS/`.local` publié par l'agent | ✅ en théorie | ✅ | Diffuse une présence sur un Wi-Fi non fiable (nom aléatoire obligatoire) | **À tester dans le spike** ; bonus, pas une dépendance |
| WebRTC (ICE) | ❌ (signalisation) | ✅ | Bonne | Pas de mode hors ligne |
| Scan de ports | — | — | Inacceptable | Exclu |

## 5. Architectures comparées

### A — WebRTC DataChannel navigateur ↔ navigateur (signalisation par le relais)

- **Fonctionnement** : la PWA et l'onglet desktop échangent SDP et ICE via le relais existant (SSE/long-poll). ICE choisit le chemin LAN direct quand c'est possible, sinon TURN ou relais. Le lien passe par un DataChannel DTLS.
- **Chrome Android/PWA** : ✅ WebRTC est supporté. Pas encore soumis à LNA (le sera).
- **Sans Internet** : ❌ **impossible** : pas de signalisation. Échoue au test fondamental.
- **Découverte** : implicite (ICE).
- **NAT** : sur le même LAN, candidats host/mDNS. Entre réseaux différents, STUN/TURN, donc un TURN à héberger pour les NAT symétriques.
- **Sécurité** : DTLS. Il faut lier l'empreinte DTLS à l'identité issue du pairing, sinon le relais (signaleur) peut s'intercaler.
- **Complexité** : élevée (négociation à chaque partage, états ICE, TURN, tests difficiles).
- **Latence** : + 0,5 à 2 s d'établissement ICE/DTLS à **chaque** partage, puisque la page Share Target est neuve. Pire que le relais actuel (~250 ms mesurés).
- **Dépendances** : TURN (coturn) pour la fiabilité.
- **Impact V1** : faible côté composants (pas d'agent), fort côté client.
- **Limites** : ne résout ni le hors-ligne ni la latence. Seul gain : l'URL ne transite pas par le relais, ce que le **chiffrement E2E sur le relais** offre plus simplement.

### B — Agent local sur le PC + `fetch()` LNA depuis la PWA + relais en secours *(recommandée, sous réserve du spike)*

- **Fonctionnement** :
  1. Un **agent SendLink** tourne sur le PC : service utilisateur (processus Node) qui écoute sur le LAN (`0.0.0.0:47631` par exemple, HTTP).
  2. Il annonce aux pairs, via le relais, son **adresse LAN** et sa **clé publique**. L'annonce est chiffrée pour eux.
  3. Au partage, la PWA (servie par son SW, même hors ligne) envoie un **message chiffré et authentifié** à l'agent par `fetch()`, puis attend un **accusé de réception authentifié**.
  4. L'agent remet le lien aux onglets SendLink du même PC par `http://127.0.0.1`. Loopback : pas de contenu mixte à franchir, permission LNA sur Chrome desktop, et Firefox autorise `localhost` depuis HTTPS.
  5. Si le chemin local n'est pas disponible ou échoue : relais actuel, inchangé.
- **Chrome Android/PWA** : ✅ **d'après la documentation** (LNA + relaxation du contenu mixte depuis Chrome 141). **À prouver sur ton appareil**, en PWA installée et lancée par Share Target.
- **Sans Internet** : ✅ si (a) le SW sert l'app hors ligne, (b) le téléphone a en cache l'adresse et la clé de l'agent, (c) l'IP n'a pas changé, (d) Android route vers le Wi-Fi (données mobiles coupées). **Seule architecture web qui passe le test fondamental.**
- **Découverte** : adresse annoncée et mise en cache, amorcée au pairing. mDNS en option si le spike le valide.
- **NAT** : sans objet (même LAN). Hors LAN : relais.
- **Sécurité** : cryptographie applicative bout-en-bout (§7). Le HTTP en clair ne transporte que du chiffré. Écoute sur un Wi-Fi non fiable : surface d'attaque à durcir.
- **Complexité** : moyenne à élevée. Nouveau composant (agent) à installer et superviser, SW hors ligne, clés, pont loopback, déduplication.
- **Latence** : un aller-retour LAN (< 50 ms) une fois la permission LNA accordée. Secours relais après ≤ 800 ms seulement si le local a été tenté et a échoué.
- **Dépendances** : aucune nouvelle bibliothèque (WebCrypto côté navigateur, `node:crypto` côté agent).
- **Impact V1** : le relais, la présence, le store-and-forward et le pairing restent inchangés. Ajouts : clés publiques, agent, annonces, ID de message client, SW hors ligne. **Les PC sans agent restent en relais seul.**
- **Limites** :
  - Il faut installer un agent sur le PC.
  - Une permission LNA à accorder sur le téléphone (et sur le desktop pour le pont loopback).
  - L'IP peut changer pendant une coupure.
  - Les Wi-Fi avec isolation des clients (hôtel, invité, entreprise) bloquent le local, donc relais.
  - La coopération de LNA avec les PWA installées n'est pas documentée.
  - LNA pourrait évoluer.

#### B′ — Variante : WebTransport + `serverCertificateHashes`

Même architecture, mais TLS/QUIC vers l'agent avec un certificat épinglé par hash (≤ 14 jours).
- ➕ Chiffrement de transport sans CA. Pas soumis à LNA **aujourd'hui**, donc pas d'invite.
- ➖ Serveur HTTP/3 requis : écosystème Node immature, Go/Rust à ajouter. Hashes à renouveler tous les ≤ 14 jours : WAN coupé plus de 14 jours, ça casse. Sera soumis à LNA à terme, et son maintien est débattu au W3C.
- **À garder en plan B** si `fetch()` LNA échoue dans la PWA.

### C — Serveur SendLink auto-hébergé à la maison + DNS split-horizon (+ tunnel pour l'extérieur)

- **Fonctionnement** : le seul serveur SendLink tourne à la maison (PC ou Raspberry Pi) avec un certificat public valide pour `sendlink.example` (DNS-01). Le DNS du routeur (ou un Pi-hole) résout `sendlink.example` vers l'IP LAN. Depuis l'extérieur, le DNS public pointe vers un tunnel (Cloudflare nommé) vers ce même serveur.
- **Chrome Android/PWA** : ✅ **sans aucune API exotique**, c'est l'origine normale en HTTPS valide. **Fonctionne dès aujourd'hui, sans code.**
- **Sans Internet** : ✅ si le téléphone utilise le DNS du routeur (Android *DNS privé* réglé sur « Automatique » ou désactivé) et que le routeur sert l'enregistrement local.
- **Découverte** : aucune, le DNS décide.
- **NAT** : tunnel pour l'extérieur.
- **Sécurité** : identique à la V1 (TLS public, mêmes jetons).
- **Complexité** : nulle côté code, **élevée côté utilisateur** (routeur, DNS, certificat, serveur 24/7).
- **Latence** : LAN.
- **Dépendances** : routeur avec DNS local, serveur allumé.
- **Impact V1** : aucun.
- **Limites** : ne s'applique **pas** à un service hébergé multi-utilisateurs. Réservé aux auto-hébergeurs. « Local-first » ici = « le serveur est chez moi ».

### D — Applications natives (Android Kotlin + agent desktop)

- **Fonctionnement** : découverte NSD/mDNS native, TLS avec clés épinglées, sockets directs. Share Sheet natif.
- **Android** : ✅ sans restriction navigateur (mais permissions réseau local récentes d'Android à gérer).
- **Sans Internet** : ✅ le plus robuste.
- **Complexité** : très élevée. Remplace la PWA, deux apps à publier et maintenir.
- **Impact V1** : rupture. C'est la cible long terme, pas une étape.

### Synthèse

| | A WebRTC | **B Agent + LNA** | C Auto-hébergé | D Natif |
|---|---|---|---|---|
| PWA Android actuelle | ✅ | ✅ (doc, à prouver) | ✅ | ❌ remplacée |
| Test « Wi-Fi ON / WAN OFF » | ❌ | ✅ (conditions §5-B) | ✅ | ✅ |
| Nouveau composant PC | non | **agent** | serveur maison | app |
| Garde les onglets comme destinations | ✅ | ✅ (via pont loopback) | ✅ | ❌ |
| Latence d'un partage | pire (ICE) | meilleure | meilleure | meilleure |
| Service hébergé multi-utilisateurs | ✅ | ✅ | ❌ | ✅ |
| Effort | élevé | moyen à élevé | ~0 code | très élevé |

## 6. Recommandation

**B (agent local + `fetch()` LNA + chiffrement applicatif + relais en secours), après un spike de validation sur ton Android.** Plan B : B′ (WebTransport) si LNA ne marche pas dans la PWA. C reste documentable dès maintenant pour les auto-hébergeurs.

Pourquoi :
- C'est la seule option compatible avec **notre PWA et un service hébergé** qui peut passer le test WAN coupé.
- Le relais, la présence, le store-and-forward et le pairing ne changent pas. Le local est une **optimisation opportuniste** qui ne peut pas rendre SendLink moins fiable : en cas de doute, on passe par le relais.
- Les clés introduites servent aussi au futur **chiffrement E2E du relais** : même investissement.
- A n'apporte ni le hors-ligne ni la latence. D est la cible long terme mais casse la V1.

**Ce que B ne peut pas offrir** : un PC **sans agent** (simple onglet) ne peut pas recevoir en local. C'est une limite des navigateurs, pas un choix.

## 7. Sécurité (B)

**Principe : « même LAN » ≠ « de confiance ».** Le LAN ne transporte que des messages chiffrés et authentifiés.

- **Identité cryptographique dérivée du pairing**
  - Chaque client génère une paire de clés **ECDH P-256** avec WebCrypto, **non extractible**, stockée en IndexedDB. L'agent a sa propre paire.
  - Les clés publiques sont échangées **pendant le pairing**, authentifiées par le secret de pairing à usage unique existant. Le schéma a déjà `devices.public_key`.
  - Contre un relais malveillant, le QR peut porter l'empreinte de la clé de l'agent (dans le fragment `#`, jamais envoyé au serveur).
- **Message local**
  - Contenu : `{v, msgId (128 bits aléatoires), sender, target, ts}` en clair authentifié (AAD) + URL chiffrée en **AES-GCM**.
  - Clé : HKDF(ECDH(sender, agent)).
  - Seul le détenteur de l'une des deux clés privées peut produire ou lire le message. Cela authentifie l'**émetteur** pour l'agent.
- **Accusé de réception** : l'agent renvoie un MAC sur `msgId`. Le téléphone **authentifie la destination** : une autre machine qui aurait récupéré l'IP (réattribution DHCP, hôtel) ne peut pas produire d'ACK valide, donc passage au relais, et rien n'a fuité (chiffré).
- **Anti-rejeu** : fenêtre temporelle ±5 min + cache persistant des `msgId` vus, borné.
- **Validation** : l'agent revalide http/https, comme le serveur. Aucune ouverture automatique.
- **Révocation**
  - Un « Remove » fait sur le PC s'applique immédiatement à l'agent.
  - Une révocation faite ailleurs (depuis le téléphone ou le relais) est synchronisée par l'agent dès qu'il a Internet.
  - **Risque résiduel** : pendant une coupure WAN, un appareil révoqué *depuis un autre appareil* reste accepté localement jusqu'à la resynchronisation.
- **Isolation entre clients** : chaque destination (onglet) a sa propre boîte dans l'agent. Le pont loopback exige le credential de l'onglet et vérifie `Origin`.
- **Exposition sur Wi-Fi non fiable**
  - L'agent ne répond rien d'utile sans message valide : pas de nom, pas de liste, pas d'annonce mDNS nominative.
  - Rate limiting, taille de corps bornée, surface de parsing minimale.
- **Pas de secret dans une URL** : tout passe dans le corps chiffré.
- **Logs** : `msgId`, transport (`local`/`relay`/`queued`), durée. **Jamais l'URL.**

## 8. Vie privée : « le lien ne quitte pas le LAN »

- **Garantissable** si l'envoi est **séquentiel** (local d'abord, relais seulement après échec) et **jamais en course parallèle**. Une course enverrait une copie au relais à chaque partage.
- **Cas limite** : message local livré mais ACK perdu, puis délai dépassé et secours relais. Le relais reçoit alors une copie, avec le **même `msgId`**, donc dédupliquée et affichée une seule fois. Deux choix possibles :
  - **Fiabilité (par défaut proposé)** : on accepte ce cas rare et on le documente.
  - **Confidentialité stricte (option)** : si la requête locale a pu être envoyée, on ne se replie pas. Le téléphone affiche « Not confirmed » et demande de réessayer.
- **Ce qui contacte encore Internet** quand la livraison locale réussit, si Internet est disponible :
  - le chargement ou la mise à jour de la PWA (SW) ;
  - `GET /api/me` et le flux de présence pendant que l'écran est ouvert ;
  - l'annonce d'adresse de l'agent (chiffrée pour les pairs) ;
  - la synchro de révocation.

  Rien de tout cela ne contient l'URL, et le relais **n'apprend pas** qu'un envoi local a eu lieu. Il n'existe aucune télémétrie.

## 9. Secours, déduplication, UX

- **Cache de joignabilité** par destination : dernier succès local, adresse, et « échec récent » (ne pas retenter pendant 60 s).
- **Stratégie d'envoi**
  1. Si `connection.type === "cellular"`, ou pas d'agent connu, ou échec récent : **relais direct**, sans délai ajouté.
  2. Sinon, tentative locale avec **délai court** : 800 ms (le LAN répond en < 50 ms).
  3. Si ACK authentifié : **fin, aucune copie relais**, et l'écran affiche « ✓ Sent locally ».
  4. Sinon : relais (`delivered` ou mis en file), avec le **même `msgId`**.
  5. Relais injoignable (WAN coupé) et local en échec : « Couldn't send. Try again. »
- **Idempotence** : `msgId` généré par le client, `UNIQUE` côté serveur (`POST /api/links` devient idempotent) et côté agent. Le pont loopback et le relais passent par la même clé de déduplication chez l'onglet. **Une URL = une seule entrée d'historique.**
- **Observabilité (développement uniquement)** : `data-transport` = `local` | `relay` | `queued` sur la réponse, et en attribut DOM derrière un drapeau de dev. Rien dans l'UI utilisateur, hormis « Sent locally ».

## 10. Plan de validation : spike AVANT toute implémentation *(réalisé — résultats au §13)*

Page et script **jetables**, hors du code produit. Environ une heure sur tes appareils.

1. **Vérifs préalables** :
   - `chrome://version` sur le téléphone : ≥ 141 ;
   - PWA SendLink installée ;
   - IP LAN du PC connue ;
   - pare-feu ouvert sur le port de test (`sudo ufw allow 47631/tcp`).
2. **Mini-agent** sur le PC : répond `POST /ping` avec CORS pour l'origine de la PWA et renvoie un horodatage.
3. **Page de spike** servie depuis **l'origine publique de la PWA** (ton tunnel ou domaine), dans le scope de la PWA :
   - bouton « fetch local » (`fetch("http://192.168.x.y:47631/ping", { method: "POST", targetAddressSpace: "local" })`) ;
   - affichage de l'erreur exacte.
4. **Scénarios** (noter : invite de permission affichée ? succès ? message d'erreur ?) :

| # | Contexte | Attendu si B est viable |
|---|---|---|
| S1 | Onglet Chrome, Wi-Fi + Internet | Invite LNA, puis succès |
| S2 | **PWA installée**, ouverte depuis l'écran d'accueil | Succès (permission déjà accordée pour l'origine) |
| S3 | **PWA lancée par Partager** (Share Target) | Succès |
| S4 | **WAN coupé** (câble WAN débranché ou WAN désactivé dans le routeur), **données mobiles OFF**, page servie par le SW | Succès |
| S5 | S4 avec données mobiles **ON** | Observer le routage (probablement échec, donc relais attendu) |
| S6 | (bonus) `http://<nom-aleatoire>.local:47631` publié en mDNS par le PC | Résolution `.local` sur Chrome Android ? |
| S7 | (plan B) WebTransport + `serverCertificateHashes` vers l'IP | Succès sans invite ? |

**Critère d'arrêt** : si S2, S3 et S4 échouent aussi en B′ (S7), le mode LAN n'est **pas réalisable** avec la PWA. Il ne reste alors que C (auto-hébergé) ou D (natif).

## 11. Modifications de protocole (si B est validé)

Toutes **additives**, le relais restant utilisable seul :

1. **Pairing**
   - Le client envoie sa `publicKey` (JWK P-256) ; la réponse contient celle du pair.
   - Stockage dans `devices.public_key` (colonne existante).
   - Empreinte de l'agent optionnelle dans le fragment du QR.
2. **Nouveau type de client `agent`**, rattaché au `physical_device` : le premier usage réel de ce niveau du modèle. Enregistrement authentifié : l'agent est appairé au PC comme n'importe quel client, via un QR/code affiché dans un onglet du PC.
3. **Rattachement onglet ↔ agent** par le pont loopback. Explicite et prouvé par la localité (127.0.0.1) : pas de fingerprinting.
4. **Annonce d'adresse** : `PUT /api/agent/endpoint` (IP(s) LAN, port, horodatage), **chiffrée pour chaque pair**. Relayée par un événement temps réel `endpoint`. Mise en cache par le téléphone (IndexedDB).
5. **`msgId` client** : `POST /api/links {id, targetDeviceId, url}` idempotent (`UNIQUE(id)`), rétrocompatible si `id` est absent.
6. **Protocole local** : `POST http://<ip>:<port>/v1/links` avec message chiffré → `{ack: MAC(msgId)}`. `GET /v1/…` ne révèle rien.
7. **Pont loopback** : `http://127.0.0.1:<port>/v1/inbox` (authentifié par le credential de l'onglet, `Origin` vérifié). Les onglets le consultent en plus du flux relais.
8. **Synchro de révocation** : l'agent récupère la liste de ses pairs à chaque connexion au relais.
9. **Service worker** : cache versionné de l'app shell (`/m`, JS, CSS, icônes, manifest), réponse hors ligne à la navigation Share Target. **Jamais** de cache des réponses `/api`.
10. **Cache client** : destinations, clés publiques des pairs et adresses LAN en IndexedDB, pour afficher les destinations sans Internet.

## 12. Plan de test sur ton Android + PC Linux (après implémentation)

Préalable : PWA réinstallée (nouveau SW), agent lancé sur le PC, permission LNA accordée une fois.

| Test | Montage | Attendu |
|---|---|---|
| 1 | Même Wi-Fi, Internet OK | « ✓ Sent locally » ; transport `local` ; **aucune requête `POST /api/links` dans les logs du relais** |
| 2 | **Même Wi-Fi, WAN coupé, données mobiles OFF** ; YouTube → Partager → SendLink → PC | La PWA s'ouvre (SW), la destination est listée (cache), « ✓ Sent locally », le lien apparaît sur le PC |
| 3 | Téléphone en 5G (Wi-Fi OFF), PC à la maison | Transport `relay` ; livré si le PC est en ligne, sinon mis en file (comportement V1) |
| 4 | Même Wi-Fi, agent arrêté (ou pare-feu fermé) | Secours relais en ≤ 1 s, transport `relay` ; le partage suivant saute le local (cache d'échec) |
| 5 | Forcer la perte d'ACK (outil de dev de l'agent : ACK retardé de 2 s) | Local livré + relais : **une seule entrée d'historique** (même `msgId`) |
| 6 | Un autre appareil du Wi-Fi (ton laptop, `curl`) envoie vers l'agent, avec rejeu d'un message capturé | Rejeté (401/ignoré), rien n'apparaît ; le rejeu est rejeté |
| 7 | « Remove » du téléphone sur le PC, puis partage (Internet OK, puis WAN coupé) | Transport local refusé, le téléphone affiche l'écran « Connect to your computer » |
| + | Wi-Fi invité/isolé | Local impossible, secours relais transparent |

Les tests automatisés (Playwright + agent en processus de test, proxy qui coupe le relais) couvriront 1, 4, 5, 6 et 7. Les tests 2 et 3 restent **manuels** : la coupure WAN réelle et le routage Android ne sont pas simulables fidèlement.

## 13. Résultats du spike sur appareil réel — Galaxy S24 / Linux

**Environnement**
- **Téléphone** : Samsung Galaxy S24, Chrome 153, spike « LAN Spike » installé en PWA (WebAPK), Web Share Target fonctionnel.
- **PC** : Linux, IP LAN `192.168.2.18`, agent jetable en HTTP sur `:47631`.
- **Origine de la PWA** : HTTPS publique (Cloudflare Quick Tunnel). Les requêtes LAN visaient directement `http://192.168.2.18:47631` (IP privée littérale, `targetAddressSpace: "local"`, variante A).

| # | Conditions | Contexte observé | Permission LNA | Résultat |
|---|---|---|---|---|
| S1 | Onglet Chrome, Wi-Fi + Internet | `browser-tab` | `prompt`, **invite affichée à la première requête**, puis `granted` | ✅ HTTP 200, **4623 ms** (inclut le temps de réponse humain à l'invite) |
| S2 | PWA installée, lancée depuis l'écran d'accueil | `home-screen`, SW ✅, offline-ready ✅, `wifi` | **déjà `granted`** (héritée de S1), pas de nouvelle invite | ✅ HTTP 200, **108 ms** |
| S3 | YouTube → Partager → PWA | `share-target`, standalone, SW ✅, `wifi`, URL partagée présente | `granted` | ✅ HTTP 200, **211 ms** |
| S4 | **WAN coupé + données mobiles OFF + Wi-Fi ON**, Partager → PWA | `share-target`, SW ✅, offline-ready ✅, `wifi`, **`navigator.onLine = true`** | `granted` | ✅ HTTP 200, **122 ms** |
| S5 | WAN coupé + **données mobiles ON** + Wi-Fi toujours associé | **`connection = cellular`** | `granted` | ❌ la requête reste bloquée → `AbortError` à **60 s** (délai de diagnostic du spike). **Reproduit.** |

**Incident S4 écarté** : un premier essai S4 a échoué parce que **le PC s'est déconnecté du Wi-Fi** au moment de la coupure WAN. `192.168.2.18` était réellement injoignable. Après reconnexion du PC (WAN toujours coupé, données mobiles toujours OFF), le même essai a réussi en 122 ms. C'est un événement de l'environnement de test, pas un échec de l'architecture. **Leçon produit** : la reconnexion Wi-Fi du PC après une transition réseau fait partie des cas réels. Il faudra une sonde et un repli, et ne jamais supposer que l'agent est joignable.

### Ce qui est PROUVÉ expérimentalement (sur cet appareil)
- Page HTTPS dans Chrome → agent **HTTP** sur IP privée, via LNA (après accord de la permission).
- **L'invite LNA apparaît à la première requête locale** (dans un onglet). **La permission accordée persiste dans la PWA installée**, lancée depuis l'icône ou par Partager : pas de nouvelle invite.
- PWA installée → agent LAN (108 ms).
- Web Share Target → PWA installée → agent LAN (211 ms).
- La PWA mise en cache par le service worker s'ouvre et fonctionne **WAN coupé**.
- **WAN coupé + données mobiles OFF + Wi-Fi ON → livraison locale réussie (122 ms).**
- **S5** : WAN coupé + données mobiles ON → Android choisit le cellulaire, la requête vers l'IP privée **ne passe pas**. `connection.type` vaut alors `cellular`.
- `navigator.onLine` reste `true` WAN coupé. **Il ne doit jamais servir de signal de routage ni de preuve d'Internet.**

### Ce qui reste ARCHITECTURAL / THÉORIQUE (non prouvé)
Authentification et chiffrement de production ; découverte ; rotation des adresses ; déduplication des messages ; repli automatique local → relais ; agent desktop de production ; intégration multi-navigateurs (Chrome/Firefox ↔ agent) ; packaging desktop multi-plateforme ; comportement iOS ; comportement d'autres navigateurs Android (Samsung Internet…) et d'autres constructeurs ; invite LNA lors d'une **première** requête faite directement depuis un lancement Share Target (S3-fresh non testé) ; résolution `.local` (S6 non testé) ; variante WebTransport (S7 non testée, devenue inutile tant que LNA fonctionne).

## 14. Analyse de S5 (routage Android Wi-Fi sans Internet + cellulaire)

- **Mécanisme** : chaque application Android a un *réseau par défaut* choisi par le système, et ses requêtes l'utilisent. Un Wi-Fi sans Internet perd la capacité `NET_CAPABILITY_VALIDATED`, et le système préfère alors le cellulaire validé. Le Wi-Fi reste associé en arrière-plan, mais les sockets non liées n'y passent pas. Utiliser un réseau non par défaut exige des **API natives** : `ConnectivityManager.requestNetwork(TRANSPORT_WIFI)`, puis `Network.bindSocket()` / `Network.openConnection()` / `bindProcessToNetwork()`.
- **Côté web** : **aucune API standard** ne permet à une page ou une PWA de choisir l'interface réseau. La Network Information API est en **lecture seule** (`type`, `effectiveType`). LNA règle la *permission* d'accéder au réseau local, pas le *routage*. Une TWA/WebAPK reste le moteur réseau de Chrome : même comportement.
- **Donc, pour l'architecture PWA** : S5 est une condition **« LAN indisponible » légitime et durable**. **LNA accordé n'implique pas LAN joignable**, et être associé au même Wi-Fi ne garantit pas que la requête passera par ce Wi-Fi.
- **Signal exploitable** : sur Chrome Android, `navigator.connection.type === "cellular"` a correctement caractérisé S5, et `wifi` S4. **Heuristique** (non normative, absente sur iOS/desktop) : en `cellular`, ne pas tenter le local et passer directement par le relais, sans délai.
- **Option native future (documentée, non retenue pour la PWA)** : une app Android native pourrait demander le réseau Wi-Fi et lier ses sockets à ce réseau, donc livrer en local même en S5. C'est un argument supplémentaire pour l'option D à long terme, pas un hack à faire aujourd'hui.
- **Comportement produit attendu en S5** : le local est sauté (ou échoue vite), le relais est joint par le cellulaire. Si le PC est derrière ce même Wi-Fi sans WAN, son bail de présence expire, donc `delivered:false` et le lien est **mis en file (store-and-forward existant)**, livré quand le WAN du PC revient. Le téléphone affiche « ✓ Sent. Computer offline — the link will be delivered when it reconnects. » **Aucune modification du relais n'est nécessaire.**

## 15. Architecture B réévaluée

| Hypothèse de la révision 1 | Constat du spike | Décision |
|---|---|---|
| LNA permet HTTPS → HTTP privé depuis la PWA | ✅ prouvé (S1–S4) | HTTP + LNA confirmé comme transport LAN. WebTransport (B′) abandonné pour l'instant |
| La permission suit la PWA et Share Target | ✅ prouvé (S2–S4) | Une seule invite, à déclencher **au bon moment** (§20) |
| SW hors ligne suffit pour ouvrir le partage WAN coupé | ✅ prouvé (S4) | App shell hors ligne requis en production |
| Le LAN est joignable quand on est sur le même Wi-Fi | ❌ **faux en S5** | Local = **opportuniste**, jamais présumé. Sonde et repli obligatoires |
| `navigator.onLine` utile | ❌ reste `true` WAN coupé | Interdit comme signal |
| Délai de repli ≈ 800 ms | Latences réelles 108–211 ms, mais S5 = trou noir (pas d'erreur rapide) | **Sonde à l'ouverture** + budget sur le chemin critique ≤ 300 ms (§16) |

Architecture B **maintenue**, avec trois ajustements : la **sonde à l'ouverture de l'écran de partage**, le **saut du local en `cellular`**, et l'**identifiant de message dès l'origine**.

## 16. Algorithme de sélection du transport (production, proposé)

**Idée clé** : sortir la découverte de joignabilité du chemin critique. L'utilisateur met en général plus de 500 ms entre l'ouverture de l'écran de partage et le tap sur *Send* (il lit la destination). On **sonde l'agent pendant ce temps**, avec un message authentifié **sans URL**, donc sans effet sur la vie privée.

```text
À l'ouverture de l'écran (Share Target ou direct) :
  pour la destination sélectionnée (et au changement de sélection) :
    si pas d'agent connu pour elle                → local = "absent"
    sinon si navigator.connection?.type == "cellular" → local = "skip"      (S5)
    sinon si échec local récent (< 60 s, même état réseau) → local = "skip"
    sinon sonde authentifiée HELLO (timeout 1500 ms, hors chemin critique) → "reachable" | "unreachable"
  à chaque événement navigator.connection "change" : invalider le cache et relancer la sonde

À Send :
  msg = { message_id (128 bits aléatoires), url, target, created_at }   ← créé AVANT tout choix de transport
  selon local :
    "reachable"          → envoi local, timeout 1000 ms
    "probing"            → attendre la sonde au plus 300 ms, puis décider comme ci-dessus
    "absent"/"skip"/"unreachable" → pas de tentative locale
  si ACK local authentifié  → succès "local". STOP : aucune copie au relais.
  sinon                     → relais POST /api/links {messageId, …}
                               delivered → "relay" ; sinon → "queued"
  si le relais est injoignable aussi → « Couldn't send. Try again. » (outbox + retry = futur)
```

**Justification des valeurs** (à affiner avec des mesures de développement, pas figées) :
- Succès réels : **108–211 ms** (préflight CORS + POST, donc 2 allers-retours). Passer en requête CORS « simple » (`Content-Type: text/plain`, corps chiffré) supprime le préflight, soit ≈ 1 aller-retour. À vérifier.
- Économie d'énergie Wi-Fi du téléphone ou du PC (réveil radio) : + 100 à 300 ms possibles sur le premier paquet après une période d'inactivité. La **sonde absorbe ce réveil** hors chemin critique.
- **Échecs lents** : en S5, ou avec un PC endormi, une IP absente (résolution ARP, 1–3 s) ou un Wi-Fi en transition, il n'y a **pas d'erreur rapide**, seulement un trou noir. Seul un délai le borne. D'où **≤ 300 ms d'attente sur le chemin critique** quand la sonde n'a pas fini : ça couvre la médiane observée, et le pire cas perçu est « relais + 0,3 s ».
- **Timeout d'envoi 1000 ms quand la sonde a réussi** : la joignabilité vient d'être prouvée, un échec est rare (changement de réseau entre sonde et envoi). Un délai plus court créerait des faux négatifs, donc des copies relais inutiles, donc une perte de confidentialité.
- **Coût d'un faux négatif** : le lien passe par le relais. Il est toujours livré, seule la propriété « reste sur le LAN » est perdue. **Coût d'un faux positif** : attente. On privilégie donc des budgets courts **sur le chemin critique** et une sonde généreuse **hors** chemin critique.
- **Pas de course parallèle** local/relais : elle enverrait une copie au relais à chaque partage, contraire à l'objectif de confidentialité.

**Observabilité (dev uniquement)** : la réponse du client porte `transport: "local" | "relay" | "queued"`. Un attribut DOM est visible derrière un drapeau de développement. Journaux : `message_id`, transport, durées, résultat de sonde. **Jamais l'URL.**

## 17. Identité de message et idempotence (proposé)

- **`message_id`** : 128 bits aléatoires (`crypto.getRandomValues`, base64url, préfixe `msg_`), généré **par l'émetteur avant la sélection du transport**. Le même ID sert en LAN, en relais, en retry et en store-and-forward.
- **Relais (migration v3, additive)** :
  - `ALTER TABLE links ADD COLUMN message_id TEXT;`
  - `CREATE UNIQUE INDEX links_by_message ON links(sender_id, message_id) WHERE message_id IS NOT NULL;`
  - Portée **par émetteur** : un émetteur ne peut pas préempter l'ID d'un autre. Les lignes existantes gardent `NULL`, sans effet sur l'historique actuel.
  - `POST /api/links {messageId?, targetDeviceId, url}` : en cas de conflit, renvoyer **l'enregistrement existant** (200 au lieu de 201, `duplicate: true`) **sans republier** l'événement. Sans `messageId`, le comportement actuel est inchangé (rétrocompatible).
  - Les événements `url` portent `messageId`.
- **Agent** : il stocke les `message_id` reçus (index unique). Une retransmission est **ré-accusée** mais **pas re-livrée**.
- **Historique côté destination** : les liens livrés en LAN restent **sur le PC** (agent), pour préserver la confidentialité. L'onglet affiche la **fusion** de l'historique relais et de la boîte locale de l'agent, **dédupliquée par `message_id`** : une seule entrée par envoi logique. La suppression s'applique aux deux sources.
- **Cas « ACK perdu »** : l'agent a reçu le message, l'ACK s'est perdu, le délai expire et le téléphone passe par le relais avec le **même** ID. Résultat : deux copies, **une seule entrée affichée**. **Conséquence** : dans ce cas rare, l'URL a transité par le relais. Deux politiques possibles :
  - **par défaut, fiabilité** : on accepte et on documente ;
  - **option confidentialité stricte** : si la requête locale a pu partir (ce n'est pas un refus de connexion immédiat), pas de repli, et l'écran affiche « Not confirmed — Try again ».

  Le navigateur ne permet pas de savoir de façon fiable si les octets sont arrivés : c'est un **choix produit**, pas une garantie technique.

## 18. Protocole LAN sécurisé (haut niveau, proposé, non implémenté)

**Hypothèse** : le LAN est hostile (hôtel, café, entreprise, appareil malveillant sur le sous-réseau).

- **Identités cryptographiques**
  - Chaque client (PWA téléphone, onglets desktop, agent) possède une paire de clés longue durée **P-256** : ECDH pour l'accord de clé, ECDSA si des signatures sont nécessaires.
  - Côté navigateur : WebCrypto, **non extractible**, stockée en IndexedDB (la PWA partage le stockage de son navigateur, cf. ADR identité). Côté agent : fichier protégé en `0600`.
  - P-256 plutôt que X25519, pour la compatibilité WebCrypto la plus large.
- **Amorçage par le pairing existant**
  - Le téléphone envoie sa clé publique dans `POST /api/pairings`. La réponse contient la clé publique de la destination et, si elle existe, celle de son agent. Stockage dans `devices.public_key`, colonne existante.
  - **Contre un relais malveillant** : le QR (fragment `#`, jamais envoyé au serveur) inclut l'**empreinte** de la clé de l'agent. Le téléphone vérifie que la clé reçue du relais correspond. La confiance est ancrée dans le scan physique.
  - Un appareil déjà appairé avant l'agent reçoit la clé de l'agent via le relais, **attestée** : signée par la clé du client desktop qu'il connaît déjà.
- **Enveloppe de message** (style HPKE *mode_auth*, RFC 9180, avec DHKEM(P-256), HKDF-SHA256, AES-128-GCM, implémentable avec WebCrypto)
  - Une clé éphémère par message plus la clé statique de l'émetteur. On obtient l'**authentification de l'émetteur**, la **confidentialité** et une **confidentialité persistante côté émetteur**.
  - En-tête authentifié (AAD) : `{v, message_id, from_client, to_client, created_at}`. Corps chiffré : `{url}`.
  - Envoyé en `text/plain` : requête CORS simple, pas de préflight.
- **ACK authentifié** : l'agent renvoie un MAC dérivé du secret de la session, portant sur `message_id` et un statut (`stored`). Un hôte qui aurait récupéré l'IP (DHCP, hôtel) ne peut pas le produire. Le téléphone passe alors au relais, et rien n'a fuité puisque tout est chiffré.
- **Sonde HELLO** : même enveloppe, sans URL, et ACK authentifié. Elle prouve à la fois la joignabilité et l'identité de l'agent.
- **Anti-rejeu** : fenêtre `created_at` ±10 min, plus un cache persistant des `message_id` vus (LRU, rétention supérieure à la fenêtre). Un rejeu est ré-accusé mais pas re-livré.
- **Intégrité** : AEAD. **Validation** : l'agent et l'onglet revalident http/https. Aucune ouverture automatique.
- **Révocation**
  - L'agent tient la liste des clés autorisées, synchronisée depuis le relais à chaque connexion. Un « Remove » local s'applique immédiatement.
  - **Risque résiduel documenté** : une révocation faite ailleurs pendant une coupure WAN ne s'applique qu'à la resynchronisation.
  - Une révocation déclenche une rotation de clé chez l'agent.
- **Exposition minimale**
  - Port **aléatoire par installation**, annoncé uniquement aux pairs.
  - Toute requête non authentifiée reçoit une réponse vide uniforme (pas de nom, pas de version, pas de liste). Rien n'est publié en mDNS nominatif.
  - Limitation de débit par IP source et par pair. Corps borné (≤ 8 Ko).
  - CORS : `Access-Control-Allow-Origin` = origine SendLink exacte. C'est une défense en profondeur, pas une barrière.
- **Métadonnées visibles sur le LAN** : IP, port, horaires, tailles. Rembourrage optionnel.

## 19. Découverte et mise à jour automatiques de l'adresse (proposé)

- **Annonce** : l'agent publie via le relais, quand Internet est disponible, un **descripteur d'adresse** : `{addrs: [IPv4 privées actuelles], port, agent_key_fp, issued_at}`.
  - Il est **signé** par l'agent et **chiffré pour chaque pair** : le relais n'apprend pas la topologie privée.
  - Il est poussé en temps réel (événement `endpoint`) et mis en cache par le téléphone (IndexedDB) avec l'**historique des 3 dernières adresses**.
- **Détection des changements** : l'agent surveille ses interfaces (quelques secondes). À chaque changement d'IP ou de port, il ré-annonce immédiatement si le WAN est disponible.
- **Pas de scan** : le téléphone ne sonde **que** des adresses annoncées par cet agent, authentifiées par sa clé.
- **Cas difficiles**

| Cas | Comportement |
|---|---|
| IP du PC changée par DHCP **pendant** une coupure WAN | Le téléphone ne peut pas l'apprendre : pas de relais, pas d'API de découverte web. Il essaie les 3 dernières adresses connues (souvent la bonne : les baux DHCP sont généralement stables). Sinon, LAN indisponible et « Couldn't send ». **Mitigation documentée** : réservation DHCP. **Candidat secondaire** : un nom `sl-<aléatoire>.local` publié par l'agent, *si* Chrome Android résout `.local` (S6, non testé), jamais obligatoire |
| Changement de Wi-Fi (autre réseau) | L'adresse en cache peut désigner un autre hôte : la sonde échoue à l'authentification, donc relais. Aucune fuite (tout est chiffré), aucun faux positif |
| Plusieurs PC SendLink sur le même LAN | Chaque agent a sa clé, son port et son descripteur. Le téléphone ne sonde que l'agent de la destination choisie. Deux destinations navigateur d'un même PC partagent l'agent : le message porte `to_client` |
| Wi-Fi à isolation client (hôtel, invité) | Sonde en échec, donc relais, de façon transparente |

## 20. Agent desktop ↔ destinations Chrome/Firefox (proposé)

```text
Appareil physique : Linux PC
  ├── Agent SendLink      (client_type "agent" ; écoute LAN ; boîte locale par destination)
  ├── Client Chrome   ─┐   destinations sélectionnables sur le téléphone,
  └── Client Firefox  ─┘   reliées à l'agent par la boucle locale (127.0.0.1)
```

- **Rattachement explicite, sans fingerprinting** : depuis l'onglet, *« Receive links even without Internet »* → l'agent (installé) est joint sur `127.0.0.1:<port de l'agent>`. Le port est communiqué par un lien ouvert par l'agent (« Connect this browser ») : pas de scan, même localement. L'échange est authentifié par les clés des deux côtés. **La localité (loopback) prouve la même machine.** C'est le mécanisme d'*adoption* explicite annoncé dans l'ADR identité.
- **Effet sur le modèle** : un client rattaché **rejoint le `physical_device` de l'agent**. Les physical devices des onglets fusionnent : c'est enfin l'usage réel de ce niveau. Renommer la machine renomme « Linux PC » partout. Les destinations restent par navigateur (`Linux PC · Chrome`, `Linux PC · Firefox`).
- **Livraison** : message LAN → agent → **boîte locale de la destination ciblée**. L'onglet la consulte via le loopback (SSE/long-poll vers 127.0.0.1), en plus du relais, avec déduplication par `message_id`. Onglet fermé : l'agent **conserve** le message (store-and-forward local) et peut afficher une notification native. **ACK = « persisté par l'agent »**, sémantique identique à « queued » côté relais.
- **Permissions** : Chrome desktop demande LNA pour le loopback (une invite par origine). Firefox autorise `http://127.0.0.1` depuis HTTPS.
- **Migration et UX** (à valider, non implémenté) :
  - un PC sans agent reste exactement comme aujourd'hui (relais seul) ;
  - la fusion de physical devices est une nouvelle migration de données (réaffecter `physical_device_id`), réversible via « Détacher » ;
  - le téléphone pourrait grouper par machine (« Linux PC › Chrome / Firefox ») ;
  - le badge discret « ✓ Sent locally » n'apparaît qu'en cas de succès LAN.
- **Packaging** : Node (réutilise le code actuel) ou binaire unique. Service utilisateur (systemd `--user`, LaunchAgent, tâche Windows). Mise à jour et signature des binaires : **non traité, hors de ce spike**.

## 21. Mise à jour de l'évaluation vie privée

Inchangé sur le fond (§8), précisé par le spike :
- Si l'ACK LAN authentifié est reçu, **l'URL ne quitte pas le LAN**. Seule exception : l'ACK perdu (§17), selon la politique retenue.
- La **sonde** ne transporte aucune URL.
- Ce qui peut encore contacter Internet quand il est disponible :
  - la mise à jour de la PWA ;
  - `/api/me` et le flux de présence de l'écran ouvert ;
  - les annonces d'adresse chiffrées de l'agent ;
  - la synchro des révocations.

  Aucun de ces échanges ne contient l'URL ni ne révèle qu'un envoi local a eu lieu.

## 22. Plus petit incrément de production suivant

**Critère** : utile **même si le mode LAN ne se fait jamais**, sans agent, sans crypto, sans risque pour la V1.

**Incrément 1 — « Send pipeline ready for multiple transports »** — ✅ *implémenté (migration v3, `src/client/send.ts`, SW app shell, cache minimal des destinations ; voir README)*
1. **`message_id` émetteur + `POST /api/links` idempotent** (migration v3 additive, §17). Gain immédiat : un double tap ou un retry réseau ne crée plus de doublon.
2. **Outbox côté téléphone** : l'envoi passe par une abstraction `send(message) → transport[]` avec un seul transport (relais). Observabilité dev `relay` / `queued`.
3. **App shell hors ligne pour `/m`** (SW versionné, jamais de cache `/api`) et **cache des destinations** en IndexedDB. Sans Internet, l'écran de partage s'ouvre, montre les destinations et affiche clairement « Couldn't send — no connection » au lieu d'une page d'erreur Chrome. Prouvé faisable par S4.
4. Tests : idempotence (même ID deux fois → une ligne, un événement), ouverture hors ligne (Playwright `offline`), non-régression complète.

**Ensuite, dans l'ordre, chaque étape validée avant la suivante :**
- **2** : clés d'identité au pairing, empreinte dans le QR, **E2E sur le relais**. Utile seul : le relais ne voit plus l'URL.
- **3** : agent MVP (Linux) + rattachement loopback d'un onglet + boîte locale.
- **4** : transport LAN (sonde, envoi, ACK, repli), avec les tests 1–7 du §12 sur S24.
- **5** : annonces d'adresse, rotation, fusion des physical devices et UX groupée.

## 23. Recommandation GO / NO-GO

**GO conditionnel pour un SendLink local-first**, en tant qu'**optimisation opportuniste** au-dessus du relais, qui reste la source de fiabilité.

- **GO**, parce que le spike a prouvé sur appareil réel le chemin exact du produit (Share Target → PWA installée → LAN), y compris WAN coupé, avec une latence de l'ordre de 100–200 ms. La permission LNA est une invite unique qui persiste.
- **Conditions** :
  1. accepter qu'un **agent desktop** à installer soit nécessaire pour le mode LAN, ce qui est une décision produit ;
  2. ne **jamais** présumer le LAN (S5 : la sonde et le repli sont obligatoires) ;
  3. livrer d'abord l'**incrément 1**, puis l'incrément 2 (E2E), qui ont de la valeur indépendamment du LAN ;
  4. re-tester sur un second appareil Android (autre constructeur ou navigateur) avant de promettre la fonctionnalité.
- **NO-GO** : faire du LAN un chemin principal ou présumé ; WebRTC pour cet objectif ; tout contournement Android non documenté pour S5 (réservé à une future app native).

## Sources
- [Reading network state (default network, validated networks) — Android Developers](https://developer.android.com/develop/connectivity/network-ops/reading-network-state)
- [ConnectivityManager (requestNetwork, bindProcessToNetwork) — Android Developers](https://developer.android.com/reference/android/net/ConnectivityManager)
- [Network Information API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API)
- [RFC 9180 — Hybrid Public Key Encryption (HPKE)](https://www.rfc-editor.org/rfc/rfc9180)

- [New permission prompt for Local Network Access — Chrome for Developers](https://developer.chrome.com/blog/local-network-access)
- [Intent to Ship: Local network access restrictions — blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/cwu_RUmBpzY)
- [Local Network Access explainer — WICG](https://github.com/WICG/local-network-access/blob/main/explainer.md)
- [Private Network Access permission to relax mixed content — Chrome Platform Status](https://chromestatus.com/feature/5954091755241472)
- [WebTransport serverCertificateHashes option — Chrome Platform Status](https://chromestatus.com/feature/5690646332440576)
- [Consider removing serverCertificateHashes — w3c/webtransport#623](https://github.com/w3c/webtransport/issues/623)
- [WebTransport() constructor — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport)
