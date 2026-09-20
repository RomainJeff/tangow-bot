# Non-objectifs — qualité et pertinence du contexte

Écarté volontairement. Chaque entrée vient d'une recommandation générique d'« état de l'art » qui ne tient pas face au fonctionnement réel du harness. Documenté ici pour que personne ne les réintroduise par réflexe.

## Ré-injecter le prompt système tous les N tours
Le système est renvoyé intégralement à chaque requête par le runtime. Le « drift » que cette pratique corrige n'existe pas dans ce modèle d'exécution. Ré-injecter dans l'historique dédoublerait les règles et casserait le préfixe cacheable.

## Recherche d'outils à la demande au-delà de N outils
Le bot appelle ses outils de base à chaque tour. Un aller-retour de découverte avant chaque appel coûterait plus qu'il n'économise, d'autant que les schémas d'outils vivent dans le préfixe cacheable. Seul cas ouvert : borner les connecteurs externes (ticket 09).

## Résumés de compaction en JSON
Le format de checkpoint actuel est déjà structuré en sections. Passer en JSON ajouterait du parsing et des échecs de parsing pour zéro information supplémentaire. Ce qui manque aux résumés, c'est la matière — les actions réellement effectuées — et c'est le ticket 05 qui la fournit.

## Expiration automatique des mémoires, classement par « attention »
Aucun signal d'usage n'est collecté sur les mémoires. Une durée de vie arbitraire supprimerait des faits durables (préférences de l'utilisateur) ; un classement par attention suppose des métriques que personne ne produit. Abstraction spéculative. La purge par génération existe déjà pour les résumés d'historique.

## Rôle de message dédié aux événements (`event_handler`, `system_event`)
Ce rôle n'existe ni dans le runtime ni dans les API des providers. Toute émulation serait du texte dans un message utilisateur — exactement ce que fait déjà le prompt de réveil inter-bots. Le bon chemin est le marquage de l'historique (ticket 06).

## Rejouer les tours passés en blocs d'appels d'outils natifs
L'historique est persisté en texte rendu. Reconstruire des paires appel/résultat natives avec des identifiants cohérents par provider, pour des tours qui ont pu tourner sur un autre modèle — l'utilisateur change de modèle en cours de thread — est fragile et spécifique à un provider. Le gain réel est obtenu en texte par le ticket 05.

## Métadonnées de provenance sur chaque bloc de contexte
Déjà présentes là où elles comptent : les mémoires rappelées citent leur source, la mémoire durable cite son chemin et sa révision, le résumé compacté cite son point d'arrêt. Généraliser à chaque ligne d'historique ajouterait des tokens à chaque tour pour un bénéfice non démontré.

## Donner mémoire, résumé et rappel aux runs de canaux de messagerie
Ces runs sont volontairement privés de mémoire durable, de résumé et de rappel sémantique. C'est une frontière de confidentialité : un canal partagé ne doit pas faire fuiter la mémoire privée du bot. Ne pas « optimiser » par erreur.

## Corriger la constante de budget hors-historique toute seule
Piège d'ordonnancement : tant que la fenêtre de contexte du modèle n'est pas renseignée (ticket 03), la sélection d'historique ne passe pas par le budget tokens pour la majorité des providers, et la constante ne sert à rien. Ordre obligatoire : 03 puis 04.
