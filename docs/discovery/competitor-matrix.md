# Matrice concurrentielle

Date : 2026-09-27. Prix et fonctionnalités tels que publiés ou rapportés (voir sources). **[FAIT]** sauf mention contraire.

Directions : **A** Universal Handoff (grand public) · **B** Action Router · **C** Shared Screen · **D** Managed Handoff.

## 1. Envoi entre ses propres appareils (A)

| Produit | Plateformes | Compte requis | Prix | Forces | Faiblesses exploitables par SendLink [HYP] |
|---|---|---|---|---|---|
| Chrome « Send to your devices » | Chrome ↔ Chrome | Compte Google + sync | Gratuit | Intégré, amélioré en sept. 2026 | Un seul navigateur ; même compte ; pas Firefox/Safari ; pas entre comptes perso et pro |
| Microsoft Phone Link | Android/iPhone ↔ Windows | Compte Microsoft | Gratuit | Très complet (SMS, appels, fichiers, presse-papiers) | Windows uniquement ; lourd ; pas Linux/macOS |
| Apple Handoff / AirDrop | Apple ↔ Apple | Apple ID | Gratuit | Fluide | Écosystème fermé |
| KDE Connect / GSConnect | Android ↔ Linux (+ Windows) | Non | Gratuit, open source | Riche, local | LAN seulement ; configuration ; pas via Internet |
| LocalSend | Tous OS | Non | Gratuit, open source (~92 600 étoiles GitHub) | Multi-plateforme, local, populaire | LAN seulement ; transfert de fichiers d'abord ; app à installer partout |
| Quick Share (Google/Samsung) | Android ↔ Windows/Android | Compte ou proximité | Gratuit | Intégré | Fichiers, proximité |
| Pushbullet | Android ↔ navigateurs/PC | Oui | Gratuit ; Pro 4,99 $/mois ou 39,99 $/an | Historique ancien | Vieillissant, compte obligatoire |
| Join (joaoapps) | Android ↔ PC/navigateurs | Compte Google | Achat unique | Tasker, riche | Niche technique |
| Messages à soi-même (WhatsApp, Telegram, e-mail) | Partout | Oui | Gratuit | Universel, déjà installé | Bruit, pas d'ouverture directe sur le PC, recherche pénible |

## 2. Routage / automatisation (B)

| Produit | Rôle | Prix | Recouvrement avec SendLink |
|---|---|---|---|
| HTTP Shortcuts (Android) | Cible de partage → requête HTTP (webhook), Direct Share | Gratuit, open source | **Fort** pour les bricoleurs Android |
| Apple Raccourcis | Automatisations depuis le menu Partager iOS | Gratuit | Fort sur iOS |
| Tasker (+ Join) | Automatisation Android | Achat unique | Fort pour les experts |
| Zapier / Make / n8n / IFTTT | Workflows (≈ 310 M$ ARR estimé pour Zapier en 2024) | Freemium → payant | **Complémentaire** : SendLink peut être leur point de capture mobile |
| Raindrop / Readwise Reader / Instapaper / Matter | Stocker, organiser, lire | ~28 $/an à 12,99 $/mois | Adjacent (à ne pas copier) |

## 3. Écrans partagés (C)

| Produit | Modèle | Prix publié | Sans app pour un invité sur téléphone ? | Hors réseau local ? |
|---|---|---|---|---|
| Barco ClickShare Hub | Matériel + boutons | 2 350 – 4 250 € HT par salle | Non (app, AirPlay/Cast selon config) | Non |
| Airtame | Matériel + abonnement | 299 – 1 299 $ par écran (3 ans), puis 120 – 300 $/écran/an | **Laptop : oui** (« Share from Browser », code) ; **téléphone : app requise** (pas de `getDisplayMedia` sur mobile) | Wi-Fi local requis |
| ScreenBeam | Récepteur matériel | 600 – 1 200 $ | Miracast natif / app | Non |
| Mersive Solstice | Pod + abonnement par salle | Non publié | App / AirPlay / Miracast | Non |
| Vivi (éducation) | Matériel loué + abonnement | Non publié | App | Non |
| Chromecast / AirPlay | Protocoles | 0 – 50 $ | Selon l'OS | **Non : mDNS, cassé entre VLAN** |
| **SendLink (hypothèse C)** | Logiciel, écran = navigateur | [HYP] gratuit 1 écran, puis 5–10 $/écran/mois | **Oui : lien via page web ou Partager** | **Oui : relais Internet, et LAN** |

**[HYP] Trou de marché identifié** : « téléphone invité → écran, **sans app, sans être sur le même réseau** ». Il est **limité au contenu adressable par lien et accessible sans connexion** (voir market-C §3).

## 4. Gestion et sécurité (D)

Ce sont les consoles des acteurs C (Barco XMS, Airtame Cloud, Mersive Kepler) et les outils MDM. **[HYP]** D n'est pas un marché d'entrée pour un fondateur solo, mais l'**extension naturelle** de C (politiques, audit, flotte).

## 5. Lecture stratégique [RECO]

- **A seul est commoditisé** : Google, Microsoft et Apple le donnent gratuitement dans leur écosystème, et LocalSend et KDE Connect le couvrent en open source local. SendLink ne gagne pas sur les fonctionnalités, mais peut gagner sur « **multi-navigateur, sans compte, via Internet et en local** ». C'est une niche, et une bonne porte d'entrée.
- **Ne pas se battre sur les fichiers, le presse-papiers, les SMS ni le miroir** : c'est le terrain de Phone Link, KDE Connect, Join, Pushbullet et AirDroid.
- **B et C** sont les seules directions où SendLink a une **raison d'exister différenciée**. À départager par les entretiens.

## Sources
Voir les sources de [market-B-action-router.md](market-B-action-router.md) et [market-C-shared-screen.md](market-C-shared-screen.md), plus :
[LocalSend](https://github.com/localsend/localsend) · [Quick Share](https://en.wikipedia.org/wiki/Quick_Share) · [Phone Link](https://en.wikipedia.org/wiki/Phone_Link) · [Pushbullet (G2)](https://www.g2.com/products/pushbullet/competitors/alternatives) · [Join](https://joaoapps.com/join/)
