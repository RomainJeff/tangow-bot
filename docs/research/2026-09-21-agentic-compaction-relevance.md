# Compaction, pertinence et mémoire pilotée par l’agent

Recherche arrêtée au **21 septembre 2026**. Sources publiques uniquement ; aucun essai exécuté sur des conversations privées. Les dates ci-dessous sont celles des publications, non celles de leur indexation. Les liens de code sur `main` décrivent l’état consulté ce jour et peuvent évoluer.

## Conclusion

Les deux posts critiquent **une implémentation particulière de sélection des appels d’outils**, `fast-jev-compaction`. Ils n’établissent ni que la compaction doit toujours être un résumé, ni que l’agent serait incapable de choisir ce qui lui sera utile. La distinction utile pour Rakazo est entre **l’état nécessaire à la prochaine action**, **les connaissances durables** et **l’archive consultable**. Réduire le contexte envoyé au modèle ne doit pas automatiquement effacer les preuves ou promouvoir une information en mémoire de confiance.

## Ce que disent réellement les deux posts

Les deux originaux ont été lus intégralement dans le navigateur, malgré le refus d’accès du lecteur web direct.

Le **18 septembre**, Theo écrit « Compaction isn't a filter ». Il reproche au prototype de sélectionner des appels avec une vision réduite de la conversation, sans leurs résultats, et de risquer de faire disparaître les tentatives déjà effectuées. Il invoque aussi la conservation du raisonnement et le coût des modifications du cache. Ce sont plusieurs arguments distincts : la cécité du sélecteur est vérifiable dans le code ; ses affirmations générales sur tous les fournisseurs, leur entraînement et le coût de son usage personnel ne constituent pas une démonstration universelle. [Post de Theo](https://x.com/theo/status/2100762304862384257).

Le **19 septembre**, Teknium rapporte que le mécanisme a supprimé tous les appels candidats dans son évaluation : « it simply removed all tool calls from the chat history ». Il critique également l’accumulation du texte non compressé et les pertes de cache, puis renvoie à une évaluation Hermes publique. Son message suivant précise que la critique vise cette stratégie et ce dépôt, pas tous les usages de Jev. [Post de Teknium](https://x.com/Teknium/status/2101398453578555898), [précision de portée](https://x.com/Teknium/status/2101406210335658307).

Tous deux répondent au post de Tamara du **17 septembre**, présentant une compaction par score de pertinence des appels. Le projet correspondant est [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). Son README distingue la bibliothèque et son intégration par hooks ; la démonstration vidéo est scénarisée et ne constitue pas une mesure de performance.

## Comment la sélection est effectivement réalisée

Le sélecteur reçoit un objectif calculé par défaut à partir des **trois derniers messages utilisateur**, chacun tronqué à 500 caractères. Son état doit tenir dans environ **25 000 tokens**. Pour respecter cette limite, les entrées d’outils puis des textes anciens sont abrégés, remplacés par des indications d’omission ou exclus. Les contenus des résultats d’outils sont absents dès le départ : seule une indication succès/erreur et leur longueur les représente. Le juge peut donc devoir estimer l’utilité future d’une sortie qu’il n’a jamais lue. [Construction de l’état](https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/src/state.ts).

Deux questions sont posées par appel : est-il encore utile de savoir que cet appel a eu lieu, et faut-il conserver sa sortie intégrale parce que le relancer ne suffirait pas ? Au seuil par défaut de **0,5**, le résultat est conservé, tronqué ou supprimé avec l’appel. Certains messages sont protégés et les associations appel/résultat restent cohérentes. Le texte utilisateur/assistant conservé n’est pas reformulé. Il s’agit d’une politique de retrait sélectif, dont les probabilités répondent aux questions fournies ; elles ne certifient ni la vérité du contenu ni l’innocuité de sa suppression. [Décisions et application](https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/src/compact.ts).

**Nuance absente d’une lecture rapide des posts :** l’intégration actuelle déclenche la compaction à 60 % d’occupation, mais revient au résumé natif en cas d’erreur ou lorsque la réduction obtenue reste inférieure à 25 %. L’objection d’une accumulation sans fin concerne donc la stratégie Jev utilisée seule ; le plugin possède une solution de repli. Ce repli ne prouve toutefois pas la qualité de l’état qu’il transmet. [Hooks consultés le 21 septembre](https://raw.githubusercontent.com/tamaratran/fast-jev-compaction/main/hooks/fast-jev.ts).

## Ce qui a été mesuré, avec quelles limites

L’[évaluation ajoutée à Hermes, fusionnée le 19 septembre](https://github.com/NousResearch/hermes-agent/pull/116246), compare un portage Python de cette stratégie aux mécanismes Hermes et à des règles simples.

Le scorecard utilise trois historiques de 500 000 tokens, 45 questions de rappel et un modèle pour répondre et juger.

| Variante | Rappel moyen | Contexte conservé |
| --- | ---: | ---: |
| Résumé seul | 43,3 % | 55 000 tokens |
| Résumé avec récupération dans l’historique | 78,9 % | 55 000 tokens |
| Jev, réglages par défaut | 75,5 % | 115 000 tokens |

Jev supprime les 851 appels candidats non protégés. À budget comparable, son classement et la récence obtiennent chacun 77,8 %. Sa compaction est plus rapide et moins chère à produire, sans établir un meilleur coût total. Les auteurs signalent une variabilité de 2 à 7 points sur un même chemin de code. Les conversations originales ne sont pas publiées ; le programme permet des essais sur d’autres données, pas une reproduction intégrale identique. La relecture de cycles successifs montre un texte incompressible croissant ; elle ne mesure pas une continuation interactive réelle. [Résultats et méthode](https://github.com/NousResearch/hermes-agent/blob/main/evals/compaction/results/SCORECARD-2026-09-19-jev.md).

**Interprétation :** ce petit échantillon ne démontre pas une supériorité statistique générale de 3,4 points. Il montre surtout qu’un grand gain face au résumé isolé peut venir du texte préservé, sans prouver l’utilité du classement appris. Le multiplicateur de coût « 10× » du post ne doit pas devenir une constante produit : il faut mesurer lectures/écritures de cache, volume conservé, fréquence et coût de récupération sur la connexion utilisée.

Hermes offre un autre découpage concret : résumé, index d’identifiants extrait mécaniquement, messages récents, puis recherche dans les anciens tours archivés. Compacter le contexte actif ne supprime pas ces tours du stockage. Cela fournit une référence d’architecture, sans garantir que l’agent saura demander la bonne récupération. [Documentation du mécanisme Hermes](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-compression-and-caching.md).

## Une piste réellement centrée sur l’activité de l’agent

Une recherche distincte, **Self-Compacting Language Model Agents**, n’est pas la proposition citée par les deux posts. Ce préprint, déposé le **22 juin 2026**, révisé le **10 juillet**, associe un outil de résumé et une grille invitant le modèle à compacter à une transition utile : sous-problème résolu ou trajectoire convergente, plutôt qu’au milieu d’une dérivation. Les auteurs évaluent sept modèles sur six benchmarks de mathématiques et recherche. Les ablations montrent qu’offrir l’outil seul ne suffit pas. Ces résultats étayent l’intérêt d’un déclenchement sensible à l’activité ; ils ne valident pas une mémoire durable autonome ni sa résistance à l’empoisonnement. [Préprint et code associé](https://arxiv.org/abs/2606.23525v2).

## Recommandations pour Rakazo — propositions, non résultats démontrés

L’agent peut proposer **quand réorganiser son contexte** et **quelles informations rechercher ou mémoriser**. Le moteur conserve la responsabilité de l’archive, des budgets et des autorisations. Une information pertinente pour continuer peut être fausse ; une source répétée peut rester une seule source ; un résumé fluide peut faire disparaître l’origine d’une instruction malveillante. Les garanties de sécurité doivent donc porter sur les accès et la filiation, pas sur une promesse de sélection parfaite. Voir la [recherche sur l’empoisonnement de mémoire](2026-09-21-memory-poisoning-defenses.md).

1. **Séparer trois espaces.** Un état de travail révisable, des connaissances durables avec provenance, et une archive récupérable. Une sortie retirée du contexte demeure consultable selon la politique de conservation et les droits applicables.

2. **Définir la pertinence par la suite du travail.** Conserver objectif courant, contraintes, décisions, hypothèses ouvertes, essais échoués et références utiles à la prochaine action. Éviter un score abstrait d’« importance » indépendant de la tâche.

3. **Protéger les événements coûteux à perdre.** Épingler explicitement les autorisations, changements d’objectif et effets déjà exécutés. Relire un fichier modifié ne restitue pas forcément son ancien contenu ; refaire une action externe peut dupliquer son effet.

4. **Donner au sélecteur les preuves nécessaires.** Une politique de sélection des résultats doit voir leur contenu pertinent ou une représentation traçable de celui-ci. Si le budget l’empêche, reconnaître cette incertitude et garder une référence de récupération.

5. **Faire précéder l’oubli actif par un point de reprise.** L’agent propose une synthèse à une transition de tâche ; le moteur applique un seuil de secours avant saturation. Les adaptateurs préservent les blocs et associations nécessaires au protocole utilisé.

6. **Conserver l’origine pendant les transformations.** Un résumé, une fusion ou un transfert à un autre agent hérite des sources, restrictions et incertitudes. La consolidation ne transforme pas une assertion récupérée en instruction utilisateur.

7. **Préserver les réfutations et révocations.** Une information rejetée doit garder son statut dans les dérivés concernés. La réingestion du même document ne doit pas annuler mécaniquement une suppression ou faire compter une répétition comme confirmation indépendante.

8. **Mesurer la continuation, pas seulement le souvenir.** Comparer résumé avec récupération, récence et sélection apprise après plusieurs compactions : réussite de tâche, respect des contraintes, répétition d’actions, rappel des erreurs, résistance aux injections et coût total. Utiliser des données synthétiques publiques pour les tests déterministes.

Ces contrôles garantissent certaines propriétés vérifiables du moteur lorsqu’ils sont correctement implémentés. La compréhension de la tâche, le choix du bon souvenir et la qualité d’une synthèse restent des décisions probabilistes à évaluer.
