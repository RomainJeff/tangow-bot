# 18: Exportateur de traces optionnel (Langfuse) — décision avant code

**What to build:** Un opérateur qui pose une paire de clés Langfuse dans son environnement voit ses runs d'agent apparaître comme des traces arborescentes — run, tours, appels d'outils, compaction — sans que le dépôt dépende de Langfuse et sans qu'un déploiement qui ne pose rien change de comportement.

Le cadrage complet est dans `../langfuse-observabilite.md` ; ce ticket n'en reprend que la décision. Trois points à trancher **avant** d'écrire une ligne :

1. **Que sort-il vers le tiers ?** Trois modes possibles : métriques seules (ids, tokens, latences, noms d'outils, statut) ; métadonnées plus contenu expurgé ; contenu complet. La redaction existante protège des secrets techniques à motif connu, pas de la vie privée : la mémoire injectée et les sorties d'outils (un fichier lu, une page web) partiraient telles quelles. Le code existant penche deux fois vers les métriques seules. Le mode contenu n'est pas une nouvelle capacité — le transcript JSONL local en est déjà une — c'est un **nouveau destinataire**, donc une question de gouvernance, pas de technique, et il implique de mettre le tiers dans le parcours de consentement documenté.
2. **Le `userId` sort-il ?** Opaque, haché, ou omis. Aucune des trois options n'est neutre : sans lui, plus de filtre « qu'est-il arrivé à cet utilisateur » ; avec lui, une donnée personnelle chez un tiers.
3. **Faut-il ce ticket du tout ?** Après le ticket 17, ce que Langfuse apporte en exclusivité se réduit à une interface de navigation arborescente et, en mode contenu, à la relecture cross-run. Aucun des deux n'est un besoin exprimé par les tickets 01–17. **Ne pas ouvrir ce ticket tant qu'un besoin concret n'est pas apparu que les logs, `Event` et `UsageRecord` ne couvrent pas.**

Si la décision est « oui », la forme est déjà déterminée par le dépôt et ne demande pas d'invention : l'exportateur Axiom optionnel est le patron à copier trait pour trait — lecture d'environnement, config partielle qui logue un warning unique et reste éteinte, no-op total si rien n'est posé, installation au point de composition, test offline avec client injecté. Les garde-fous de sink (écriture avalée, une remontée d'erreur par fenêtre de 30 s, flush borné) existent déjà, donc « ne jamais faire échouer un run » est acquis. La clé de corrélation est le `runId`, déjà porté comme `traceId` et déjà en base.

Deux réserves à ne pas perdre si le code s'écrit : les messages d'historique rejoués sont de l'**entrée de trace, jamais des generations** — ils portent le modèle du run courant et un usage à zéro, donc exportés naïvement ils s'affichent comme des appels gratuits sous un modèle qui ne les a pas produits. Et aucune signature d'API ni aucun nom de variable d'environnement n'est figé ici : le choix de version du SDK (client classique léger vs pile OpenTelemetry) et les noms exacts sont à lire dans la doc de la version retenue.

**Blocked by:** 17 (le critère d'ouverture est qu'un besoin subsiste après lui)

**Status:** needs-decision — trois décisions du mainteneur avant tout code

- [ ] Le mainteneur a tranché la politique de données par défaut et l'a écrite dans le cadrage
- [ ] Le mainteneur a tranché le sort du `userId`
- [ ] Le mainteneur a confirmé, après le ticket 17, qu'un besoin concret subsiste — sinon ce ticket est clos avec ce constat, sans code
- [ ] Si le code s'écrit : rien posé en environnement = aucun import du SDK exécuté, aucun appel réseau, aucun changement de comportement
- [ ] Si le code s'écrit : config partielle = un warning unique au démarrage, exportateur éteint
- [ ] Si le code s'écrit : une panne du tiers ne fait jamais échouer un run ni retenir l'arrêt du process
- [ ] Si le code s'écrit : variables documentées dans la doc self-host et entrée CHANGELOG, le comportement étant observable par l'opérateur
