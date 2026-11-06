# Marché C — Shared Screen

> « Je scanne le QR affiché sur l'écran → j'obtiens un droit temporaire → Partager → ce contenu s'ouvre sur cet écran. »

Légende : **[FAIT]** observé et sourcé · **[SIGNAL]** indice venant d'utilisateurs ou du marché · **[HYP]** hypothèse à tester · **[RECO]** recommandation.
Date de la recherche : 2026-09-27. Recherche documentaire uniquement, **aucun entretien réalisé à ce stade**.

---

## 1. Le problème supposé

**[HYP]** Afficher un contenu sur un écran partagé (salle de réunion, classe, coworking, stand, accueil) coûte du temps et de la friction :
- se connecter à un compte sur le PC de la salle ;
- câbles et adaptateurs ;
- le dongle ou l'app propriétaire à installer ;
- le Chromecast ou AirPlay qui « ne trouve pas l'écran » ;
- l'invité qui ne peut pas rejoindre le réseau interne.

## 2. Ce qui existe (faits)

| Solution | Modèle | Prix observé | Particularités |
|---|---|---|---|
| **Barco ClickShare Hub** (Core / Pro) | Matériel + boutons USB | **2 350 € à 4 250 € HT par salle** selon le pack (disponible depuis janvier 2026) [FAIT] | Leader du marché. Bouton USB pour le PC. Intégration Teams Rooms |
| **ScreenBeam** (1100 Plus / FLEX) | Récepteur matériel | **600 à 1 200 $** [FAIT] | « Sans app ni dongle » pour les laptops. Cible éducation et PME |
| **Airtame** | Matériel + abonnement cloud | Packs 3 ans de **299 à 1 299 $ par écran**, puis **120 à 300 $ par écran et par an** ; sans renouvellement, seul le partage d'écran reste [FAIT] | **« Share from Browser »** : partage sans installation, via un **code d'appairage** affiché à l'écran, depuis Chrome/Edge/Firefox/Safari. **Nécessite d'être sur le Wi-Fi local** [FAIT] |
| **Mersive Solstice** | Pod matériel + abonnement par salle | Non publié (« par salle, annuel/pluriannuel ») [FAIT] | Positionné conférence + partage |
| **Vivi** (éducation) | Matériel **loué** + abonnement | Non publié. En cas de non-renouvellement, le matériel doit être rendu [FAIT] | Spécialiste des classes |
| **Chromecast / Google Cast, AirPlay, Miracast** | Protocoles grand public | 0 à 50 $ par écran | **Découverte mDNS limitée à un segment réseau** : échoue entre VLAN et réseaux invités sans relais mDNS configuré par l'IT [FAIT] |
| **Teams Rooms / Zoom Rooms** | Salles visio | Licence par salle | Partage via la réunion, pas pour un invité non connecté |

**Deux faits techniques décisifs pour SendLink :**
1. **[FAIT]** Sur mobile, **Chrome Android et Safari iOS n'implémentent pas `getDisplayMedia`**. Un partage d'écran *depuis le navigateur d'un téléphone* est impossible : il faut **installer l'app** du fabricant, comme l'app mobile Airtame.
2. **[FAIT]** Cast et AirPlay dépendent de la **découverte locale (mDNS)**, cassée par la segmentation réseau d'entreprise, d'école ou d'hôtel. SendLink passe par un relais Internet, et par le LAN quand c'est possible (prouvé dans le spike).

## 3. L'angle SendLink

**[HYP]** SendLink n'est pas un système de *mirroring*, c'est un **envoi de contenu adressable** (un lien) vers un écran précis. Conséquences :

| Avantage supposé | Pourquoi |
|---|---|
| **Aucune app pour l'invité avec un téléphone** | Scan du QR → page web (`/m`) → coller ou partager le lien. Le menu Partager est un bonus pour les habitués |
| **Indépendant du réseau local** | Relais Internet : l'invité en 4G ou sur le Wi-Fi invité peut envoyer. Pas de mDNS |
| **Meilleure qualité** | La vidéo ou la page s'ouvre **nativement sur l'écran**, au lieu d'un flux compressé depuis le téléphone ; le téléphone reste libre |
| **Zéro matériel** | L'« écran » est un navigateur en mode kiosque (mini-PC, Chromebox, Raspberry Pi, TV à navigateur) |
| **Permission temporaire et révocable** | Primitive déjà construite : QR à usage unique, expiration, présence, révocation |

**[HYP] Limite potentiellement rédhibitoire, à tester en priorité :**
- **Un lien ne s'ouvre sur l'écran que si son contenu est accessible *sans se connecter* sur cet écran** : YouTube public, pages web, Google Slides « tous les détenteurs du lien », Figma partagé, PDF public.
- Un **document privé** (Google Docs restreint, SharePoint d'entreprise, Notion privé) s'ouvrira sur une **page de connexion**.
- **Conséquence probable** : bon ajustement pour **l'éducation** (vidéos, sites, ressources publiques), les **stands et démos**, les **coworkings** ; ajustement faible pour **la réunion d'entreprise type** (documents internes privés), où le mirroring reste nécessaire.

## 4. Segments candidats

| Segment | Douleur supposée | Contenu typique | Acheteur | Ajustement « lien » |
|---|---|---|---|---|
| **Enseignants / écoles** | Projeter vite une vidéo ou une page, faire participer les élèves depuis leurs appareils | YouTube, sites, Canva/Slides partagés | Enseignant (usage) ; école ou district (achat) | **[HYP] fort** |
| **Coworkings / tiers-lieux** | Invités non gérés, réseau invité, pas d'IT sur place | Slides partagés, vidéos, sites | Gérant | **[HYP] moyen à fort** |
| **Salons, stands, showrooms** | Montrer une page ou une démo sur grand écran depuis le téléphone du commercial | Site produit, vidéo | Marketing / événementiel | **[HYP] moyen** |
| **PME, salles de réunion** | Invités externes, pas de ClickShare | Mix public et **privé** | Office manager / IT | **[HYP] incertain** (documents privés) |
| **Accueils, restaurants, affichage** | Changer le contenu d'un écran sans PC | Pages, menus, vidéos | Gérant | **[HYP] c'est un autre marché : l'affichage dynamique** |

## 5. Analyse stratégique

| Critère | Analyse | Statut |
|---|---|---|
| **Wedge** | Un enseignant ou gérant affiche le QR sur un écran existant (gratuit pour 1 écran) ; un invité l'utilise en 10 secondes sans installer d'app. Démo « magique » face aux alternatives | [HYP] |
| **Monétisation** | Abonnement **par écran** au-delà du gratuit. Point de comparaison : Airtame 120–300 $/écran/an **plus du matériel**. Hypothèse de prix : **5–10 $/écran/mois**, ou forfait établissement | [HYP] |
| **Expansion** | 1 écran → toutes les salles → console d'admin (flotte, politiques, audit, domaines autorisés) → **D (managed handoff)**. Intégrations : réservation de salles, SSO | [HYP] |
| **Rétention** | L'écran équipé reste installé (coût de changement faible au début, fort une fois déployé sur un parc). Usage récurrent par cours ou réunion | [HYP] |
| **Distribution** | Ascendante : enseignants, communautés edtech, gérants de coworking, SEO « afficher sur la TV sans app ». Descendante : revendeurs AV, marketplaces éducation. Achat école : **cycles lents, budgets annuels** | [HYP] ; [FAIT] les solutions établies vendent via intégrateurs AV |
| **Moat** | **Faible au départ** : Airtame a déjà la primitive « code + navigateur ». Il se construit avec la base installée, la gestion de flotte, les politiques de sécurité, et une approche **sans matériel et sans app** que les acteurs matériels ont intérêt à ne pas cannibaliser | [HYP] |
| **Taille de marché** | Estimations publiées **très incohérentes** entre cabinets (de 0,55 Md$ pour l'Amérique du Nord à 2–15 Md$ au niveau mondial selon la définition) → confiance faible. Ordre de grandeur *bottom-up* : Frost & Sullivan estimait **~32 millions de « huddle rooms »** dans le monde (estimation ancienne), sans compter les classes. Même 0,1 % à 60 $/an ≈ 2 M$ ARR. **Plafond théorique élevé ; part atteignable inconnue** | [FAIT] sur les chiffres publiés ; [HYP] sur le calcul |
| **Vers une vraie entreprise ?** | Oui **si** l'éducation ou les coworkings confirment la douleur **et** que le coût d'acquisition ascendant fonctionne. C'est la direction avec l'**acheteur le plus identifiable** et les **prix de référence les plus élevés** | [HYP] |

## 6. Risques majeurs

1. **Documents privés** : le lien ne suffit pas (§3). Si les entretiens montrent que 70 % du contenu projeté est privé, l'angle « lien » est trop étroit, **sauf** pour l'éducation.
2. **Sécurité et abus** : ouvrir automatiquement une URL sur un écran vu de tous (contenu inapproprié, phishing affiché en salle). Il faut une validation par l'animateur, des listes de domaines, une expiration et des journaux. C'est aussi la **valeur payante** potentielle.
3. **L'écran doit rester ouvert** (navigateur en kiosque) : maintenance, veille, mises à jour. Le « zéro matériel » suppose qu'un appareil existe déjà.
4. **Concurrence qui copie** : Airtame et d'autres peuvent ajouter « envoyer un lien » en quelques semaines.
5. **Cycle d'achat éducation** : lent. Le bouche-à-oreille entre enseignants est un canal, pas une garantie.

## 7. Questions que les entretiens doivent trancher

- Quelle part du contenu affiché est **publique ou partagée par lien**, et quelle part est privée ?
- Combien de fois par semaine y a-t-il une friction, et combien de temps dure-t-elle ?
- Qui a déjà payé pour résoudre ça, combien, et qui a signé ?
- Les invités viennent-ils avec un téléphone ou un laptop ?
- L'IT autorise-t-elle un service cloud externe ? Faut-il un contrôle (validation, domaines) ?

## 8. Expérience à coût minimal (sans nouvelle fonctionnalité produit)

**[RECO]** Utiliser la version actuelle en l'état :
- un onglet desktop en plein écran sur la TV d'une salle ou d'une classe réelle devient « l'écran » ;
- les invités scannent le QR et envoient un lien ;
- mesurer : temps jusqu'au premier affichage, échecs (documents privés), réactions, demandes spontanées.

**Une** vraie salle ou classe pendant une semaine, avec un enseignant ou un gérant de coworking volontaire.

## Sources

- [Barco ClickShare Hub — prix 2026 (ITdaily)](https://itdaily.com/news/workplace/barco-clickshare-hub/) · [ClickShare Hub (Barco)](https://www.barco.com/en/products/clickshare-conferencing-collaboration/room-systems-video-conferencing)
- [Airtame pricing 2026 (Rise Vision)](https://www.risevision.com/blog/airtame-pricing) · [Airtame Pricing](https://airtame.com/pricing/) · [Airtame « Share from Browser »](https://airtame.com/blog/airtame-democratizes-screen-sharing-with-all-new-share-from-browser-feature/) · [Airtame — partage depuis un navigateur](https://help.airtame.com/hc/en-us/articles/10155341382173-How-to-screen-share-from-a-browser) · [Airtame — apps mobiles](https://help.airtame.com/hc/en-us/articles/27943393083165-How-to-use-the-Airtame-mobile-applications-for-iOS-and-Android)
- [Mersive pricing](https://www.mersive.com/pricing/) · [Vivi alternative (Airtame)](https://airtame.com/compare/vivi/) · [Best screen sharing software 2026 (Rise Vision)](https://www.risevision.com/blog/best-screen-sharing-software)
- [getDisplayMedia absent sur mobile (addpipe)](https://blog.addpipe.com/screen-sharing-a-single-tab-with-getviewportmedia-or-getdisplaymedia/) · [Twilio — screen share](https://www.twilio.com/docs/video/screen-share-chrome)
- [Chromecast entre VLAN / mDNS (kiljan.org)](https://kiljan.org/2023/02/27/chromecast-casting-support-across-ip-networks/) · [Cisco Chromecast deployment guide](https://www.cisco.com/c/en/us/td/docs/wireless/controller/technotes/7-6/chromecastDG76/ChromecastDG76.html)
- [Huddle room statistics (UC Today)](https://www.uctoday.com/collaboration/huddle-rooms/huddle-room-statistics/) · [Frost & Sullivan — huddle rooms](https://digitaltransformation.frost.com/expert-insights/viewpoints/huddle-room-video-conferencing-looking-beyond-hype/)
- [North America Wireless Presentation System Market (Intel Market Research)](https://www.intelmarketresearch.com/north-america-wireless-presentation-system-market-market-41471) · [Wireless Presentation Solutions Market (Verified Market Reports)](https://www.verifiedmarketreports.com/product/wireless-presentation-solutions-market/)
