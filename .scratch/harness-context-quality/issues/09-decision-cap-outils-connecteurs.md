# 09: Décision — borner le nombre d'outils de connecteurs exposés

**What to build:** Une décision, pas du code. Les outils intégrés sont déjà filtrés par run selon les capacités du bot et le déclencheur. Les outils découverts via les connecteurs externes, eux, sont exposés sans plafond : un serveur qui publie deux cents outils gonfle le prompt de chaque run de ce bot.

Question à trancher : pose-t-on un plafond sur les outils de connecteurs, avec une mention explicite des outils masqués dans les instructions, ou laisse-t-on ouvert ?

À instruire avec le chiffre que produit le ticket 01 : la taille réelle des catalogues d'outils sur les runs existants. Tant qu'aucun run réel ne dépasse un catalogue raisonnable, ne rien faire est la bonne réponse.

Hors périmètre : un mécanisme de recherche d'outils à la demande, écarté dans les non-objectifs.

**Blocked by:** 01 (instrumentation)

**Status:** needs-decision

- [ ] Distribution de la taille des catalogues d'outils par run relevée
- [ ] Décision tranchée et consignée : plafond ou statu quo
- [ ] Si plafond : valeur choisie sur la base des chiffres, pas d'un seuil de référence externe
