# Stratégie product-led (Loop 1)

> Free utility → Pro individuel → Teams/Business → entreprise.
> **Cette trajectoire est une hypothèse.** Ce document décrit comment la tester sans détruire le produit ni surconstruire.

Légende : **[FAIT]** · **[SIGNAL]** · **[HYP]** · **[RECO]**.

---

## 1. Position de départ (honnête)

- **[FAIT]** Le cœur fonctionne sur appareils réels : pairing QR, Partager, présence, store-and-forward, hors-ligne affiché honnêtement, idempotence, tests.
- **[FAIT]** Le marché « envoyer un lien à son PC » est **gratuit chez Google, Microsoft et Apple**, et couvert en open source local (LocalSend, KDE Connect).
- **[HYP]** SendLink Free peut quand même attirer une **niche réelle** :
  - multi-navigateur (Firefox, Chrome, Edge…) ;
  - **sans compte** ;
  - Android ↔ Linux ou Windows ;
  - comptes perso et pro séparés ;
  - fonctionne via Internet **et** (plus tard) en local.
- **[RECO]** Le but du lancement n'est **pas** de maximiser les téléchargements. C'est de **trouver les 5 % d'utilisateurs qui s'en servent tous les jours et comprendre pourquoi**.

## 2. Du prototype à une version publiable (à faire, pas implémenté)

Classé en **bloquants** (sans eux, pas de lancement) et **souhaitables**.

### 2.1 Bloquants

| # | Élément | Pourquoi |
|---|---|---|
| L1 | **Domaine stable + hébergement HTTPS permanent** (pas de quick tunnel) | Les installations PWA et, plus tard, les clés E2EE sont **liées à l'origine**. Changer d'URL après le lancement casse tous les appareils. Décider aussi maintenant de la **future séparation app / relais** (voir `e2ee-design.md` §12.1), pour ne pas devoir migrer les utilisateurs plus tard |
| L2 | **Landing page** : promesse, démo vidéo de 20 s (YouTube → Partager → PC), bouton « Ouvrir sur mon PC », FAQ | Première impression, SEO, lien à partager |
| L3 | **Politique de confidentialité + conditions d'utilisation** | Obligatoire (Play Store, RGPD). Dire exactement ce que voit le serveur (URL en clair tant que l'E2EE n'est pas là) |
| L4 | **Parcours « première minute » testé sur 5 personnes non techniques** (ordinateur → QR → téléphone → install → Partager) | L'installation PWA est la friction n°1 |
| L5 | **Exploitation** : supervision (healthcheck), sauvegardes automatiques (`npm run backup`), redémarrage auto, alerte en cas de panne | Un utilitaire « instantané » qui tombe perd la confiance |
| L6 | **Anti-abus** : limites déjà en place ; ajouter un moyen de signaler un abus ; plafonds globaux | Un relais ouvert attire les abus |
| L7 | **Retour utilisateur intégré** (voir §5) | Sinon on lance à l'aveugle |
| L8 | **Métriques respectueuses de la vie privée** (voir §4) | Idem |

### 2.2 Souhaitables (après les bloquants)

| Élément | Commentaire |
|---|---|
| **Présence sur le Play Store via TWA** (Trusted Web Activity, Bubblewrap), même code PWA | **[HYP]** Canal de découverte majeur (« send link to pc »), installation familière, cible Partager native. À vérifier : support du share target en TWA |
| **Extension Chrome/Firefox** « envoyer la page vers mon téléphone » (sens PC → téléphone) | **[HYP]** Attendu par une partie des utilisateurs, mais le téléphone doit recevoir, donc **Web Push**. À ne faire que si demandé (§7) |
| **Page `/m` sans installation** mise en avant pour iOS | iOS n'a pas de Share Target PWA : coller un lien reste possible |
| **Option auto-hébergée documentée** (Docker) | Canal de distribution fort (r/selfhosted) et confiance, **si** décision open source (§6) |

## 3. Canaux pour les 100, puis 1 000 premiers utilisateurs [HYP]

| Étape | Canaux | Pourquoi ça pourrait marcher |
|---|---|---|
| **0 → 100** | Ton réseau ; communautés Linux (r/linux, r/gnome, forums Fedora/Ubuntu) ; r/Android ; r/firefox (« Send to device » cross-browser) ; Discord de devs | Utilisateurs **mal servis** par Chrome, Phone Link et Handoff : Linux, Firefox, multi-navigateur |
| **100 → 1 000** | **Show HN** (quand la landing et le parcours sont solides) ; Product Hunt ; **AlternativeTo** (fiches « alternative à Pushbullet / Join / KDE Connect ») ; articles « Pocket/Pushbullet alternatives » ; Play Store (TWA) ; r/selfhosted si open source | Canaux où l'on **cherche** déjà ce type d'outil |
| **Continu** | SEO sur les requêtes « send link from phone to pc », « share to firefox on pc », « open link on laptop from android » ; tutoriels vidéo courts | Intention de recherche explicite |

**[RECO]** Ne pas lancer sur Show HN ou Product Hunt avant L1–L8 : **un seul tir**.

## 4. Métriques (sans spyware)

**Principes** :
- **aucun outil tiers d'analytics** ;
- **aucune URL** ni contenu enregistré dans les métriques ;
- **compteurs agrégés côté serveur, par jour** ;
- identifiants d'appareil **hachés et tronqués** pour les cohortes, jamais d'IP ;
- tout ceci **écrit dans la politique de confidentialité**.

| Métrique | Question à laquelle elle répond |
|---|---|
| **Activation** : ordinateur créé → appareil appairé → **1er envoi dans les 24 h** | L'onboarding fonctionne-t-il ? |
| **Rétention hebdo des émetteurs** (S1, S4, S8) | Est-ce une habitude ou une curiosité ? **Métrique n°1** |
| **Envois par émetteur actif / semaine** (distribution, pas moyenne) | Qui sont les utilisateurs intensifs ? |
| **Part des envois via Partager vs coller** | Le geste natif est-il adopté ? |
| **Part des téléphones en PWA installée** | Friction d'installation |
| **Nombre de destinations par téléphone** (1, 2, 3+) | Signal Pro / multi-appareils (voir free-vs-pro H-P1) |
| **Part d'envois « queued »** (destination hors ligne) | Valeur du store-and-forward |
| **Appareils non-Chrome / Linux / Firefox** | Confirme ou infirme la niche « mal servie » |

## 5. Retour utilisateur (sans harceler)

- **Une seule question, une fois**, après le **5ᵉ envoi réussi** : « À quoi vous sert SendLink ? » (champ libre, facultatif, jamais redemandé). C'est **la source principale de découverte de nouveaux cas d'usage** (B, C, ou autre).
- Lien permanent « Feedback » (e-mail ou formulaire), et **proposer un appel de 15 min** aux utilisateurs intensifs (identifiés par un opt-in explicite, pas par tracking).
- **Fake doors mesurés** (voir free-vs-pro) : un bouton « Destinations programmables (bêta) » qui **explique honnêtement** que c'est en préparation et propose de rejoindre la liste.

## 6. Décision à prendre avant le lancement : open source ?

| Option | Pour | Contre |
|---|---|---|
| **Open core** (client + relais open source, service hébergé + Pro/Teams payants) | Confiance (vie privée, future E2EE vérifiable), distribution self-hosted, crédibilité sécurité (ton profil) | Clones possibles ; il faut que la valeur payante soit dans l'hébergé, les équipes et les politiques |
| **Fermé** | Protège le code | Moins de confiance pour un outil qui voit des URL ; distribution plus difficile |

**[RECO]** Open core, **si** l'on accepte que Pro/Teams se vendent sur le **service** (hébergement, équipes, écrans gérés, support) plutôt que sur le code. À trancher avec toi.

## 7. Ce qu'il ne faut PAS construire avant des signaux

| Tentation | Pourquoi pas maintenant | Signal qui la débloquerait |
|---|---|---|
| Transfert de fichiers, photos | Terrain de LocalSend, Quick Share, Phone Link, AirDroid (commoditisé) | Demande répétée **et** lien avec B ou C |
| Presse-papiers universel, SMS, notifications miroir, bureau à distance | **Clone d'AirDroid / KDE Connect / Join** | Aucun prévu |
| Gestionnaire de favoris / lire plus tard, IA de résumé | Marché saturé après Pocket (Raindrop, Readwise, Matter…) | Seulement si B converge vers « connaissance d'équipe » |
| App iOS native | Coût élevé (Swift, App Store) avant validation | 50+ demandes iOS explicites ou direction B/C validée |
| Console B2B, SSO, audit | Aucun client | Pilote C ou D signé |
| E2EE (HPKE), transport LAN, agent desktop | En pause (voir ADR / e2ee-design) | Direction choisie, domaine stable, besoin exprimé |
| Comptes utilisateurs | Contraire au positionnement « sans compte » | Uniquement pour Teams |
