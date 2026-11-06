# Discovery scorecard

**Rôle** : décider sur des **données**, pas sur des préférences. Les scores ci-dessous sont des **a priori issus de la seule recherche documentaire** ; ils **doivent** être remplacés par les résultats des entretiens et expériences.
**B et C ne sont pas classés à ce stade.**

## 1. Hypothèses à tester

### B — Action Router
| # | Hypothèse | Test | Seuil de validation |
|---|---|---|---|
| H-B1 | Les gens s'envoient régulièrement des liens qui doivent aller « ailleurs que le PC » | Entretiens B (artefacts : 5 derniers envois à soi) | ≥ 6/10 montrent ≥ 3 envois/semaine avec une destination autre que « lire plus tard » |
| H-B2 | Les solutions actuelles (menu Partager, Raccourcis, HTTP Shortcuts) sont trop pénibles pour la majorité | Entretiens B | ≥ 5/10 ont tenté puis **abandonné** une automatisation |
| H-B3 | Une destination webhook sans configuration serait utilisée chaque semaine | Bêta concierge (10–20 pers.) | ≥ 5 utilisateurs actifs hebdo sur 2 semaines |
| H-B4 | Ces utilisateurs paieraient 20–30 $/an | Pré-achat « early supporter » | ≥ 3 paiements réels |
| H-B5 | Une extension « équipe » (Share → #research) intéresse des petites équipes | Entretiens équipes | ≥ 2 équipes demandent un essai |

### C — Shared Screen
| # | Hypothèse | Test | Seuil de validation |
|---|---|---|---|
| H-C1 | Afficher du contenu sur un écran partagé est une friction **hebdomadaire** | Entretiens C | ≥ 6/10 décrivent un incident récent sans y être poussés |
| H-C2 | Une part suffisante du contenu est **publique ou partagée par lien** | Entretiens C (question clé) | ≥ 50 % du contenu affiché, au moins dans un segment (probablement l'éducation) |
| H-C3 | Les invités ont surtout un **téléphone** ou sont sur un **autre réseau** (avantage sans app / sans LAN) | Entretiens C | ≥ 5/10 citent ces situations |
| H-C4 | Un pilote dans une vraie salle est accepté et **utilisé** | Pilote 1 semaine | ≥ 3 organisations acceptent ; ≥ 1 salle utilisée ≥ 3 fois par semaine |
| H-C5 | Quelqu'un paie ~5–10 $/écran/mois (ou un forfait) | Proposition de prix après pilote | ≥ 1 paiement ou lettre d'intention |

### A — Utility (Loop 1)
| # | Hypothèse | Mesure | Seuil |
|---|---|---|---|
| H-A1 | Une niche mal servie (Linux, Firefox, multi-navigateur, sans compte) adopte SendLink | Lancement ciblé, 100 premiers utilisateurs | Rétention S4 des émetteurs ≥ 20 % |
| H-A2 | Le geste Partager est adopté | Part des envois via Partager | ≥ 50 % chez les rétenus |

## 2. Grille de score (à remplir après la discovery)

Échelle 0–3 par critère. **Confiance** indiquée à côté (faible / moyenne / forte).

| Critère (poids) | B a priori | C a priori | B après | C après |
|---|---|---|---|---|
| Douleur (×3) | 1–2 (faible) | 2 (faible) | | |
| Fréquence (×2) | 2–3 (moyenne, cf. étude « emails-to-self ») | 1–2 (faible) | | |
| Disposition à payer (×3) | 1 (faible) | 2 (moyenne : budgets matériels élevés observés) | | |
| Acheteur identifiable (×2) | 1 (l'utilisateur lui-même) | 2 (école, gérant, office manager) | | |
| Distribution scalable (×2) | 2 (communautés, SEO) | 1–2 (ascendant enseignants, sinon vente) | | |
| Moat potentiel (×1) | 1 | 1–2 | | |
| Taille pour une vraie entreprise (×2) | 2 (si extension équipes) | 2 (si le parc s'étend → D) | | |
| Ajustement avec l'existant technique (×1) | 3 | 3 | | |
| Temps jusqu'au 1er revenu (×1) | 2 | 1 | | |

**Lecture honnête de l'a priori** :
- **C** a l'acheteur et les références de prix les plus nets, mais une **limite technique** (contenus privés) qui peut réduire le marché à l'éducation et aux usages publics.
- **B** a la fréquence la plus crédible, mais une **disposition à payer faible** et une concurrence DIY.
- **Aucun des deux ne peut être choisi sans entretiens.**

## 3. Critères GO / NO-GO (fixés avant de commencer)

| Décision | Condition |
|---|---|
| **GO C** | H-C1 **et** H-C2 validées dans au moins un segment, **et** ≥ 3 pilotes acceptés, **et** ≥ 1 engagement payant ou lettre d'intention |
| **GO B** | H-B1 **et** H-B2 validées, **et** H-B3 (≥ 5 actifs hebdo en bêta concierge), **et** ≥ 3 pré-achats |
| **GO Pro individuel** | ≥ 1 hypothèse H-P validée selon son critère (free-vs-pro) |
| **GO lancement public (Loop 1)** | L1–L8 terminés (product-led-strategy §2.1) — **indépendant** de B/C |
| **NO-GO B/C** | Aucun engagement (pilote, pré-achat, intro qualifiée) après 10 entretiens de la direction |
| **Si tout est NO-GO** | SendLink reste une **utility open source vitrine** (valeur réelle pour ton profil sécurité), sans investissement supplémentaire ; on garde les 8 docs pour une autre idée |

## 4. Calendrier proposé (10 jours)

| Jours | Loop 1 (produit) | Loop 2 (discovery) |
|---|---|---|
| 1–2 | Décisions : domaine, open source, hébergement | Recrutement : 10 C + 10 B contactés |
| 3–7 | (Aucun code sans validation — préparation L1–L8 à planifier) | Entretiens (≈ 3 par jour max), notes le jour même |
| 5–10 | | 1 pilote C (vraie salle/classe) ; bêta concierge B (webhooks manuels) |
| 10 | Revue | Remplir la grille, décision GO/NO-GO |
