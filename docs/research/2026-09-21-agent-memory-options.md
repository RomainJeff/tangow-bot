# Mémoire des agents : quatre approches

Recherche au 21 septembre 2026, sur sources publiques officielles. Comportements documentés, sans validation expérimentale dans Rakazo. Comparaison conceptuelle, sans classement de fournisseurs.

| Approche | Unité durable | Principal choix produit |
| --- | --- | --- |
| Fichiers explicites | Document lisible et modifiable | Autoriser ou valider chaque écriture |
| Extraction et rappel | Fait extrait, déduit ou corrigé | Donner quelle autorité aux inférences ? |
| Orchestration | État de conversation et documents persistants | Quoi retenir, quand et pour qui ? |
| Graphe temporel | Relation datée reliée à ses sources | Remplacer une vérité sans perdre son histoire |

## Fichiers explicites — Anthropic Memory Tool

Le modèle demande des opérations de lecture, création, modification, suppression et renommage sous `/memories`. L’application les exécute dans son propre stockage, éventuellement par utilisateur. La lecture se fait à la demande. Limites, protection des chemins, filtrage sensible et expiration incombent à l’application. [Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).

**Déduction :** format favorable à l’inspection et à l’export ; l’application peut appliquer une écriture immédiatement ou attendre une validation. Historique, provenance et arbitrage des contradictions nécessitent toutefois une représentation explicite. Le fichier seul ne fournit pas ces garanties.

## Extraction et rappel — Supermemory

Les documents reçus produisent des souvenirs atomiques. Les relations `updates`, `extends` et `derives` désignent remplacement, enrichissement et inférence ; `isLatest` identifie la version courante. La documentation décrit aussi expiration et filtrage du bruit. [Graph memory](https://supermemory.ai/docs/concepts/graph-memory).

Les fragments sources sont conservés. Le statut documentaire `done` signifie qu’ils sont indexés ; l’extraction des souvenirs peut continuer ensuite en mode `dynamic`. [How Supermemory Works](https://supermemory.ai/docs/concepts/how-it-works).

Une revue des inférences existe : les non-validées restent recherchables avec un poids réduit ; approuver retire cette pondération, refuser les exclut, annuler rétablit leur état. **Ce n’est donc pas une validation préalable à toute utilisation.** [Review Inferred Memories](https://supermemory.ai/docs/recall/memory-review).

Les `containerTag` séparent utilisateur, projet, agent ou espace ; l’application définit leur sens. Des clés limitées aux conteneurs renforcent la frontière. [Container Tags](https://supermemory.ai/docs/concepts/container-tags), [API keys & auth](https://supermemory.ai/docs/authentication).

Corriger crée une version ; `forget` exclut du rappel sans effacer physiquement. La création directe de faits est possible. L’oubli par requête peut être prévisualisé puis appliqué aux identifiants retenus. [Memory Operations](https://supermemory.ai/docs/recall/memory-operations).

**Déduction :** davantage de rappel automatique, mais extraction et admission restent deux décisions distinctes. Une inférence pondérée reste une inférence.

## Types et moment d’écriture — LangGraph

LangGraph sépare état de conversation conservé par checkpoints et documents JSON persistants partagés entre conversations, organisés par espaces de noms. Sa taxonomie distingue faits (*sémantique*), expériences (*épisodique*) et instructions (*procédurale*). Mémoire sémantique et recherche sémantique désignent respectivement un contenu et une méthode de rappel. [Memory overview](https://docs.langchain.com/oss/python/concepts/memory).

Écrire pendant la réponse rend le souvenir immédiatement disponible mais ajoute travail et latence. Écrire en arrière-plan sépare les responsabilités, avec un délai et un déclenchement à choisir. Aucun mode n’implique une approbation humaine. [Writing memories](https://docs.langchain.com/oss/python/concepts/memory#writing-memories).

**Déduction :** cette approche fournit une grille et des primitives ; validation, provenance, remplacement et rétention restent des politiques produit.

## Temporalité et provenance — Graphiti / Zep

Graphiti est un framework ouvert de graphe temporel ; Zep est un produit distinct. Graphiti combine recherches textuelle, sémantique et par graphe. [Overview](https://help.getzep.com/graphiti/getting-started/overview).

Les épisodes relient les faits à leurs sources. Les relations conservent `created_at`, `expired_at`, `valid_at` et `invalid_at` : dates de connaissance par le système et périodes de validité du fait sont distinctes. [Adding Episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes), [modèle public des relations](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py), [explication des dates](https://help.getzep.com/facts).

Graphiti propose les espaces `group_id` et la suppression physique des nœuds et relations. [Graph Namespacing](https://help.getzep.com/graphiti/core-concepts/graph-namespacing), [CRUD Operations](https://help.getzep.com/graphiti/working-with-data/crud-operations).

Limite documentée dans **Zep**, sans la généraliser à Graphiti : supprimer un épisode ne régénère pas les résumés partagés et ne réactive pas un fait précédemment invalidé. [Deleting Data](https://help.getzep.com/deleting-data-from-the-graph).

**Déduction :** utile pour expliquer un changement et retrouver un état passé ; les dates ne garantissent pas la justesse de l’extraction.

## Conséquences de conception

Propositions de cadrage, sans présumer de l’existant Rakazo :

- Séparer privé, projet et espace partagé ; une promotion élargit les lecteurs et nécessite une autorisation explicite.
- Distinguer déclaration, observation, inférence et validation ; conserver source précise, dates et révisions.
- Séparer correction d’erreur et remplacement d’un fait devenu obsolète.
- Séparer retrait du rappel et suppression physique ; vérifier aussi résumés, profils, index et sources susceptibles de recréer le souvenir.
- Conserver une source canonique par souvenir ; une source externe consultée peut rester indépendante et référencée, sans copie automatique.

Ces approches peuvent se combiner. Le format de stockage, la méthode de rappel, le moment d’écriture et le contrôle humain constituent quatre décisions indépendantes.
