# Free vs Pro — hypothèses (à valider, pas une liste de fonctionnalités)

**Règle** : chaque hypothèse payante correspond à **un problème**, **un segment** identifiable et **un test**. Sinon, elle n'existe pas.

Légende : **[FAIT]** · **[SIGNAL]** · **[HYP]** · **[RECO]**.

## 1. Ce qui doit rester gratuit (principes)

**[RECO]**
- **Le geste cœur, sans limite artificielle** : Partager → un appareil, présence, file d'attente, historique de base, hors-ligne honnête. Limiter le geste cœur tuerait le wedge. Les concurrents gratuits (Chrome, Phone Link) fixent le plancher.
- **La sécurité de base** : révocation, et **plus tard l'E2EE**. La vie privée ne se vend pas comme une option : c'est une condition de confiance.
- **Assez de destinations pour l'usage personnel normal.** [HYP] 1 téléphone + 2 ou 3 destinations. **À calibrer avec les données** (métrique « destinations par téléphone »), pas à deviner.

## 2. Hypothèses payantes

| # | Problème | Segment | Offre Pro supposée | Test à coût minimal | Critère de validation |
|---|---|---|---|---|---|
| **H-P1** | « J'ai beaucoup d'appareils ou de navigateurs (maison, travail, laptop), je veux tout router depuis un téléphone » | Utilisateurs avancés multi-machines | Destinations illimitées, **groupes par machine**, plusieurs téléphones | Mesurer la distribution « destinations par téléphone » ; fake door au-delà de N | ≥ 10 % des actifs hebdo ont 3+ destinations **et** ≥ 3 % cliquent le fake door |
| **H-P2** | « Je retrouve difficilement un lien envoyé il y a 3 semaines » | Veilleurs, chercheurs, devs | **Historique long + recherche** (sur le poste de l'utilisateur, compatible E2EE) | Fake door « Rechercher dans l'historique (Pro) » ; question aux entretiens B | ≥ 5 % d'actifs cliquent ; ≥ 3 entretiens citent la recherche **spontanément** |
| **H-P3** | « Je veux que mes liens aillent dans *mon* workflow (n8n, Zapier, serveur) » | Utilisateurs d'automatisation (**direction B**) | **Destinations programmables** (webhook, règles) | Bêta concierge : webhook configuré à la main pour 10–20 personnes | ≥ 5 utilisent chaque semaine pendant 2 semaines ; ≥ 3 acceptent de payer |
| **H-P4** | « Je veux héberger moi-même, avec support et mises à jour » | Self-hosters, petites entreprises soucieuses de leurs données | Licence / support self-host | Formulaire d'intérêt sur la landing (si open source) | ≥ 20 inscriptions qualifiées |
| **H-P5** | « Je veux afficher sur l'écran de ma salle ou classe sans matériel » | Enseignants, coworkings, stands (**direction C**) | **Écrans partagés** : 1 gratuit, puis par écran | Pilote dans 1 vraie salle ou classe (voir market-C §8) | ≥ 3 organisations acceptent un pilote ; ≥ 1 paie |
| **H-P6** | « Je veux que ça marche même sans Internet (ou sans que le lien quitte mon réseau) » | Soucieux de vie privée, terrain, réseaux restreints | Mode LAN (agent desktop) | Question aux entretiens + fake door « Local mode » | ≥ 5 % de clics **et** demandes spontanées. *Sinon, laisser en pause* |

## 3. Hypothèses de prix [HYP]

| Référence observée [FAIT] | Prix |
|---|---|
| Pushbullet Pro | 4,99 $/mois ou 39,99 $/an |
| Raindrop Pro | ~28 $/an |
| Join | achat unique |
| Readwise (Reader inclus) | 9,99–12,99 $/mois |
| Airtame (écran) | 120–300 $/écran/an après le pack initial |

Pistes à tester (une à la fois, par fake door ou pré-achat) :
- **Pro individuel** : **2–3 $/mois ou 20–25 $/an**, ou « early supporter » à vie à 20–30 $ (utile pour mesurer la disposition à payer sans abonnement).
- **Écrans (C)** : **5–10 $/écran/mois**, 1 écran gratuit.
- **Teams** : au siège, **uniquement quand un pilote le demande**.

## 4. Anti-patterns à éviter [RECO]

- Rendre payant ce qui est gratuit chez Google, Microsoft ou Apple (échec garanti).
- Mettre la sécurité (E2EE) derrière un paywall.
- Inventer des fonctionnalités Pro « pour avoir un Pro ». **Pas de Pro tant qu'aucune hypothèse H-P n'est validée.**
