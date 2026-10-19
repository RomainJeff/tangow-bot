# Défendre la mémoire des agents contre l’empoisonnement

Recherche arrêtée au **21 septembre 2026**. Huit sources primaires ; dates de publication ou de dépôt vérifiées dans les documents, distinctes des dates d’indexation. Les recommandations sont une proposition de conception pour Rakazo, pas une description de protections déjà implémentées. Aucun benchmark n’a été reproduit ici.

**Recommandation : conserver une mémoire utile sans lui permettre d’accorder des droits.** Le stockage, le rappel et l’autorisation d’agir doivent être trois décisions séparées. Une architecture peut imposer des limites d’accès vérifiables ; elle ne peut garantir que tout souvenir est vrai ni que le modèle ne sera jamais influencé.

## Faits documentés et portée des preuves

**MINJA — une interaction ordinaire peut contaminer la mémoire.** Déposé le 5 mars 2025, révisé le 12 février 2026, ce travail montre une injection sans accès direct à la base : l’attaquant utilise les requêtes et les réponses de l’agent pour provoquer l’enregistrement d’exemples qui orienteront des requêtes ultérieures. L’enjeu ne se limite donc pas aux administrateurs autorisés à modifier la mémoire. Le canal conversationnel peut devenir un canal d’écriture indirect. Les expériences démontrent cette possibilité sur les configurations étudiées ; elles ne donnent pas un taux universel pour les assistants actuels. [MINJA, version 5](https://arxiv.org/abs/2503.03704v5).

**MemoryGraft — une « réussite passée » peut transporter une procédure dangereuse.** Le préprint du 18 décembre 2025 étudie des artefacts ingérés par DataInterpreter de MetaGPT avec GPT-4o. L’agent conserve des expériences malveillantes, ensuite rappelées pour des tâches similaires. La procédure acquiert l’apparence d’un précédent utile. Limites importantes : petit jeu de données construit manuellement, connaissance par l’attaquant des artefacts lus, et mesures principalement centrées sur le rappel. La propagation entre agents est évoquée comme travail futur, pas établie par cette étude. [MemoryGraft, étude et limites](https://arxiv.org/html/2512.16962v1).

**Utility Under Attack — le poison peut être un faux fait sans instruction.** Ce préprint du 21 août 2026 mesure une seule implémentation, avec un lecteur, un modèle d’embedding et un moteur de rappel. Sur 120 questions de LongMemEval, 360 faux souvenirs, soit 1,2 % du corpus, font passer l’exactitude de 0,850 à 0,300 ; son filtre d’écriture n’en refuse aucun. Renforcer la pénalité de provenance aide dans certaines conditions mais exclut aussi des preuves légitimes venues de canaux non fiables. Les quotas de provenance proposés en remplacement ne sont pas évalués. Ces résultats démontrent une limite de ce système et motivent une hypothèse plus générale ; ils ne prouvent pas que tout filtrage ou tout classement échoue toujours. [Utility Under Attack, résultats et limites](https://arxiv.org/html/2608.21230v1).

**MemSecBench — persister, influencer, agir et réparer sont des résultats différents.** Déposé le 29 juillet 2026, ce préprint évalue 310 cas sur 24 combinaisons d’agent, de mémoire et de modèle. Il distingue écriture acceptée, persistance sémantique, rappel, adoption, conséquence observable, réparation et conservation des souvenirs bénins. Les agrégats rapportent 84,2 % de persistance et 50,3 % de réussite complète écriture–exécution, dans ce protocole. Une partie des décisions dépend d’un modèle juge : son accord avec deux annotateurs humains atteint respectivement 90,6 % et 91,8 % sur 500 observations. Le benchmark est utile pour construire une évaluation, pas pour prédire directement le risque de Rakazo. [MemSecBench, protocole et validation](https://arxiv.org/html/2607.27080v1).

**MemLineage — la filiation apporte une garantie conditionnelle.** Le préprint du 14 mai 2026 associe signatures, journal append-only, graphe de dérivation et blocage des actions sensibles. Son théorème exige que chaque lien pertinent dépasse un seuil d’attribution. Un résumé signé peut conserver une origine hostile ; signer le nouvel auteur ne suffit donc pas. Les auteurs reconnaissent qu’une attribution affaiblie ou omise peut laisser passer le poison ; le comportement par défaut sans parent assez fort est permissif. Ils proposent un refus prudent et des approches complémentaires. Les expériences déterministes et quelques essais avec modèle ne constituent pas une validation complète contre un adversaire adaptatif. Ce mécanisme est une piste d’ingénierie, pas un produit certifié sûr. [MemLineage, notamment section 8](https://arxiv.org/html/2605.14421v1).

**OWASP — couvrir le cycle et les frontières.** Le Top 10 pour applications agentiques, édition 2026 publiée en décembre 2025, classe ce risque en ASI06. Il inclut résumés, embeddings, historique, mémoire partagée et échanges entre agents. Il recommande cloisonnement, attribution des sources, rétention limitée, quarantaine, retour arrière et prévention de la réingestion automatique des propres sorties comme mémoire fiable. Ce guide exprime des pratiques de prévention ; il ne mesure pas leur efficacité combinée. [OWASP, ASI06, pages 24–26](https://genai.owasp.org/download/52117/).

**Anthropic — contenir les capacités, y compris si le modèle est trompé.** L’article du 25 mai 2026 distingue environnement, modèle et contenus externes. Il place les frontières de fichiers, processus et réseau hors de la seule décision probabiliste du modèle. Un connecteur audité peut néanmoins retourner un document hostile. L’article rappelle aussi les limites de l’approbation humaine répétitive. Cela appuie une défense par restriction des capacités, avec un périmètre explicite et des contrôles réellement appliqués. [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude).

**OpenAI — contrôler les conséquences et les transferts.** L’article du 11 mars 2026 décrit des attaques ressemblant à de l’ingénierie sociale et explique pourquoi classer les entrées ne suffit pas. Il recommande de relier les sources d’influence aux opérations dangereuses et d’imposer des contraintes déterministes sur ces dernières. Les contrôles de transmission, les blocages et les confirmations portent sur l’action et les données concernées. [Designing AI agents to resist prompt injection](https://openai.com/index/designing-agents-to-resist-prompt-injection/).

## Déductions pour l’architecture de Rakazo

Les conclusions suivantes sont une synthèse de conception à vérifier dans le produit.

| Propriété recherchée | Ce que l’architecture peut imposer | Limite persistante |
| --- | --- | --- |
| Accès à une mémoire | Filtrage côté serveur par utilisateur, espace et droit, sur chaque chemin de lecture | Un document autorisé peut mentir |
| Modification des règles | Stockage séparé, droits absents pour les agents d’ingestion | Une règle autorisée peut être mal définie |
| Autorisation d’un outil | Vérification externe de l’action, cible, paramètres, budget et portée | Une action permise peut rester inopportune |
| Provenance | Identité de source et liens conservés hors du texte généré | Provenance et signature ne prouvent pas la vérité |
| Containment | Fichiers, réseau et secrets hors d’atteinte selon la politique | Bugs du dispositif et dommages dans le périmètre autorisé |
| Qualité du souvenir | Contradictions, corroboration, classification, revue | Jugements sémantiques faillibles |

Une garantie doit préciser son invariant, son périmètre et sa preuve. « Aucun outil ne peut écrire dans cet espace avec ces droits » est vérifiable si tous les chemins passent par le même contrôle. « Aucun souvenir malveillant n’influencera jamais une réponse » ne l’est pas avec un simple filtre ou prompt.

Le suivi des influences doit rester prudent : si une session lit une source non fiable, ses nouvelles synthèses ne deviennent pas fiables parce que le modèle dit s’en être détaché. Une propagation conservatrice peut marquer tous les dérivés ; elle bloque davantage de travail légitime. Une attribution fine peut rendre davantage de tâches possibles, mais devient une défense probabiliste dès qu’un modèle décide des liens. Ce compromis doit apparaître dans les mesures.

Séparer aussi **confidentialité**, **intégrité**, **pertinence** et **autorité**. Une information publique peut être fausse ; une information privée peut être exacte mais inaccessible à cet agent ; un fait correct peut être périmé ; aucun de ces faits n’accorde à lui seul le droit d’envoyer un message ou de changer une configuration.

## Dix contrôles concrets à évaluer

1. **Admettre des candidats, pas des règles.** Chaque entrée reçoit côté serveur une origine, une portée, un type et un état. Une extraction de document devient une affirmation attribuée. Une autorisation ou préférence sensible exige une source habilitée pour ce champ. Limite : le typage valide la forme, pas la vérité.

2. **Protéger les métadonnées de confiance.** L’agent ne choisit ni son niveau d’autorité ni son identité de source. Conserver identifiant, version et référence vérifiable au passage cité. Tester la falsification de ces champs. Limite : une source authentique peut être compromise.

3. **Conserver les parents pendant la consolidation.** Résumés, dédoublonnages, traductions et transferts entre agents héritent des sources et restrictions. Un parent manquant interdit une promotion automatique. Limite : une filiation sémantique exhaustive peut être coûteuse et imparfaite.

4. **Éviter la corroboration circulaire.** Compter les origines indépendantes, pas les répétitions, copies ou citations entre bots. Les fréquences servent à détecter une anomalie, jamais à transformer automatiquement une assertion en vérité. Limite : reconnaître des origines réellement indépendantes nécessite parfois une enquête externe.

5. **Cloisonner tout le rappel.** Appliquer les droits avant le classement, puis sur les résultats ; inclure caches, recherche exacte, recherche vectorielle, export et mémoire injectée automatiquement. Tester les identifiants devinés et espaces voisins. Limite : cela empêche certains accès, pas l’influence d’un contenu autorisé.

6. **Autoriser l’action au dernier moment.** Vérifier l’intention habilitée, la destination et les paramètres juste avant exécution. Un souvenir « déjà approuvé » n’est pas un justificatif. Lier toute confirmation au contenu réellement exécuté. Limite : les autorisations trop larges laissent un dommage possible.

7. **Limiter les capacités de chaque tâche.** Donner aux lecteurs de documents uniquement leurs outils nécessaires ; garder secrets et contrôles hors de leur environnement. Borner fichiers, réseau et sorties des connecteurs. Limite : les contrôles doivent couvrir toutes les voies équivalentes et leur composition.

8. **Prévoir un oubli avec prévention du retour.** Révoquer l’entrée et ses dérivés connus, invalider caches et index, puis empêcher la réimportation automatique depuis l’ancien document, historique ou résumé. Garder une trace minimale de révocation selon la politique de rétention. Limite : reconnaître toutes les paraphrases d’un fait oublié reste probabiliste.

9. **Mesurer sécurité et utilité ensemble.** Tester hors ligne les faux faits, instructions déguisées, contradictions, répétitions, consolidation, partage entre bots et rappel après suppression. Mesurer conséquences observables, faux blocages, maintien des souvenirs bénins et réapparition après plusieurs sessions. Limite : une suite finie ne couvre pas tous les adversaires.

10. **Rendre la récupération opérable.** Conserver versions, raisons d’admission et événements d’action ; permettre quarantaine et reconstruction depuis un état sain. Une alerte doit indiquer les souvenirs et tâches concernés. Limite : un retour arrière de mémoire n’annule pas un message envoyé ni une donnée divulguée.
