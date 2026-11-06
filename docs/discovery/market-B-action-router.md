# Marché B — Action Router / destinations programmables

> « Je tombe sur quelque chose n'importe où → je décide immédiatement où ça doit aller. »
> Share → **appareil** (Linux PC · Chrome) · **projet** (CyberPath / Research) · **action** (webhook, rappel, workflow).

Légende : **[FAIT]** observé et sourcé · **[SIGNAL]** indice venant d'utilisateurs ou du marché · **[HYP]** hypothèse à tester · **[RECO]** recommandation.
Date : 2026-09-27. Recherche documentaire uniquement, **aucun entretien réalisé**.

---

## 1. Le problème supposé

**[HYP]** Les gens capturent des informations sur leur téléphone (liens, vidéos, articles, produits) qui doivent **aller quelque part** : l'ordinateur pour agir, un projet, un collègue, un outil. Aujourd'hui, ce routage est **dispersé** (messages à soi-même, e-mails, favoris, 5 apps différentes dans le menu Partager) ou **bricolé** (Raccourcis, Tasker, Zapier).

## 2. Signaux que le besoin existe

- **[FAIT]** Une recherche Microsoft (CHIIR 2017) sur les e-mails envoyés à soi-même : **80–90 % des utilisateurs d'e-mail en ont déjà envoyé un**, certains **plusieurs fois par jour**. Les rappels et les éléments à traiter dominent.
- **[FAIT]** WhatsApp a généralisé « **Message yourself** » (2022), explicitement pour sauvegarder des liens, notes et documents.
- **[FAIT]** Pocket a **fermé le 8 juillet 2025** (données supprimées en novembre 2025). Des utilisateurs cherchent un remplaçant. **[SIGNAL]** De nombreux articles « Pocket alternatives 2026 » et des utilisateurs qui disent « pas de vrai remplaçant ».
- **[FAIT]** L'automatisation est un marché payant massif : Zapier ≈ **310 M$ d'ARR estimé en 2024**, plus de 3 M d'utilisateurs, plus de 100 000 clients payants.

## 3. Ce qui existe déjà

| Catégorie | Exemples | Prix | Ce que ça couvre | Ce qui manque (hypothèse) |
|---|---|---|---|---|
| **Le menu Partager lui-même** | Slack, Trello, Notion, Todoist, Gmail… | Gratuit | Envoi **vers une app installée** | Pas de destinations « appareil précis » ni « endpoint perso » ; une app par destination |
| **Envoi vers ses appareils** | Chrome « Send to your devices » (amélioré en **sept. 2026** : position de défilement conservée), Microsoft Phone Link, Apple Handoff, KDE Connect | Gratuit | Envoi vers **ses** appareils, **dans un même écosystème ou compte** | Multi-navigateur (Firefox ↔ Chrome), sans compte Google/Microsoft, entre comptes perso et pro, vers des appareils qui ne sont pas à soi |
| **Share → HTTP / webhook** | **HTTP Shortcuts** (Android, open source : cible de partage vers une requête HTTP, Direct Share), **Apple Raccourcis**, **Tasker + Join** (achat unique) | Gratuit ou achat unique | Routage programmable complet | **Réservé aux bricoleurs** : configuration technique, pas de destination « appareil » intégrée, pas de multi-plateforme simple |
| **Automatisation** | Zapier, Make, n8n, IFTTT | 0 à plusieurs centaines $/mois | Le « après » (workflows) | Le « point de capture mobile » reste un e-mail, un formulaire ou un webhook bricolé |
| **Lire plus tard / marque-pages** | Raindrop (~28 $/an), Readwise Reader (9,99–12,99 $/mois), Instapaper, Matter | Freemium | Stocker, organiser, lire | Ce n'est pas du routage vers des appareils ou des actions ; marché saturé après Pocket |
| **Envoi multi-usage** | Pushbullet (4,99 $/mois ou 39,99 $/an, toujours commercialisé), Join | Freemium / achat unique | Liens, notifications, presse-papiers, SMS | Produits vieillissants, orientés « miroir du téléphone » |

## 4. L'angle SendLink

**[HYP]** Un **point de capture universel, sans compte, multi-plateforme**, dont les destinations peuvent être :
1. **un appareil précis** (existe déjà) ;
2. **un endpoint** (webhook : n8n, Zapier, Make, NAS, script perso) ;
3. plus tard, **un projet ou une boîte** (« Research », « Achats », « Voyage »), avec une action (notifier le PC, déposer dans un outil).

**Différence avec les existants** : on ne remplace pas Zapier, Readwise ou le menu Partager. SendLink serait la **cible de partage** qui sait aller **là où il n'y a pas d'app** : un navigateur précis, un appareil qui n'est pas à moi, mon serveur, mon workflow.

## 5. Analyse stratégique

| Critère | Analyse | Statut |
|---|---|---|
| **Wedge** | Commence comme A (« envoyer à mon PC ») ; l'utilisateur avancé découvre la destination webhook | [HYP] |
| **Monétisation** | Pro pour les destinations programmables (webhooks, règles, plusieurs projets) — utilisateurs qui paient déjà pour l'automatisation. Références : Pushbullet 39,99 $/an, Raindrop 28 $/an, Join en achat unique | [HYP] |
| **Expansion** | Destinations d'équipe (« Share → #research »), API, intégrations natives, historique et recherche | [HYP] |
| **Rétention** | Habitude du geste Partager → SendLink ; destinations configurées (coût de changement) | [HYP] |
| **Distribution** | Communautés d'automatisation et self-hosted (r/selfhosted, n8n, Home Assistant) ; **répertoires d'intégrations** (templates n8n/Zapier) ; SEO « share to webhook android » | [HYP] ; [SIGNAL] LocalSend (~92 600 étoiles GitHub) montre l'appétit pour les outils multi-plateformes ouverts |
| **Moat** | **Faible** : HTTP Shortcuts et Raccourcis font déjà le routage. Le moat viendrait de la **simplicité** (zéro configuration), des **destinations appareil intégrées**, des **modèles**, et plus tard d'un **historique et d'une recherche** propres à l'utilisateur | [HYP] |
| **Taille de marché** | Large en théorie : tout travailleur du savoir qui s'envoie des liens. **Mais la disposition à payer d'un « routeur » seul est inconnue** ; l'automatisation paie, la capture beaucoup moins | [HYP] |
| **Vers une vraie entreprise ?** | Possible **seulement** si le routage devient le **point d'entrée** d'un produit à valeur plus forte (équipes, connaissance partagée, workflows). Sinon, c'est une bonne utility Pro, pas une grosse entreprise | [HYP] |

## 6. Risques majeurs

1. **Les gens avancés bricolent déjà**, et les autres n'en ressentent pas le besoin. Le « milieu » est-il assez grand ?
2. **Tapis roulant des intégrations** : chaque destination native coûte de la maintenance. **[RECO]** Rester longtemps sur *une seule* destination générique (webhook).
3. **iOS** : pas de Web Share Target, donc une app native est nécessaire pour être dans le menu Partager (voir `ios-share-extension.md`).
4. **Chrome « Send to your devices »** s'améliore activement ([FAIT], sept. 2026) : le cas « même compte Chrome » est bien servi gratuitement.
5. **Proximité avec le « read-later »** : tentation de dériver vers un gestionnaire de favoris (marché saturé).

## 7. Questions que les entretiens doivent trancher

- Où va aujourd'hui ce que vous capturez sur votre téléphone ? Montrez vos 5 derniers « messages à vous-même ».
- Avez-vous déjà construit un raccourci ou une automatisation pour ça ? Qu'est-ce qui l'a cassé ?
- Payez-vous déjà pour Zapier, Make, Readwise, Raindrop ou Pushbullet ? Pour quel usage précis ?
- Si demain « Share → mon workflow » existait sans configuration, qu'est-ce que vous brancheriez en premier ?

## 8. Expérience à coût minimal

**[RECO]** Avant toute intégration, un **test « fake door + webhook manuel »** :
- sur la landing, « Destinations programmables : envoyez vers n8n, Zapier, Make, votre serveur — rejoindre la bêta » ;
- recruter 10–20 personnes, leur configurer **à la main** un webhook côté relais (pas de fonctionnalité produit), puis observer l'usage réel sur 2 semaines.

C'est l'équivalent d'un test *concierge*. La destination webhook produit ne serait construite qu'après signal.

## Sources

- [Self-Es: The Role of Emails-to-Self in Personal Information Management (Microsoft Research, CHIIR 2017)](https://www.microsoft.com/en-us/research/publication/self-es-role-emails-self-personal-information-management/)
- [WhatsApp « Message yourself » (TechCrunch)](https://techcrunch.com/2022/11/28/whatsapp-rolls-out-a-feature-that-makes-it-easier-to-message-yourself/)
- [Pocket shut down in July 2025 — alternatives (web-highlights)](https://web-highlights.com/blog/pocket-shuts-down-in-july-2025-the-10-best-alternatives/) · [Pocket alternatives 2026 (Marqly)](https://www.marqly.com/blog/best-pocket-alternatives-2026)
- [Zapier revenue (Sacra)](https://sacra.com/c/zapier/) · [Zapier stats (Latka)](https://getlatka.com/companies/zapier)
- [HTTP Shortcuts (GitHub)](https://github.com/waboodoo/http-shortcuts) · [HTTP Shortcuts — advanced (share)](https://http-shortcuts.rmy.ch/advanced)
- [Join by joaoapps](https://joaoapps.com/join/) · [Pushbullet alternatives / pricing (G2)](https://www.g2.com/products/pushbullet/competitors/alternatives)
- [Chrome send tab fix, sept. 2026 (Android Headlines)](https://www.androidheadlines.com/2026/09/chrome-send-tab-to-phone-feature-fix.html)
- [Raindrop pricing 2026](https://contextbolt.com/blog/raindrop-pricing/) · [Readwise Reader pricing 2026](https://www.readless.app/blog/readwise-reader-pricing-2026)
- [LocalSend (GitHub)](https://github.com/localsend/localsend) · [Microsoft Phone Link](https://support.microsoft.com/en-us/windows/apps/phonelink/introducing-microsoft-phone-link-and-link-to-windows)
