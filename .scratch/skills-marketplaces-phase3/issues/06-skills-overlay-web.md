# 06: Panneau web « Skills »

**What to build:** Un bouton « Skills » dans la sidebar ouvre un overlay (même gabarit que Integrations) avec trois onglets. **Installed** : le composant de gestion des skills existant (liste, création, édition, visibilité par bot) avec compteur `n / 50` et avertissement au-delà. **Marketplaces** : liste des marketplaces du space, formulaire d'ajout (URL GitHub + ref), par ligne : Check update (affiche « à jour » ou la liste des fichiers changés avec statut, tailles, et avant/après côte à côte pour les textes modifiés) → Apply update, et Remove. **Browse** : choix d'une marketplace, cartes de plugins (nom, description, badge source non supportée) avec Install / Remove, et sous un plugin installé la liste de ses skills avec rappel d'activer par bot dans Installed. Toute mutation rafraîchit le slash picker. Chaînes lingui extraites et compilées.

**Décisions :** pas d'onglet « New skill » séparé (déjà couvert par Installed, `// ponytail:`). Pas de lib de diff : avant/après dans deux `<pre>`. Web only, mobile et panneau Knowledge inchangés.

**Blocked by:** 03 (RPC marketplaces), 04 (catalogue avec skills mkt)

**Status:** ready-for-agent

- [ ] Bouton sidebar + overlay lazy avec `data-testid` sur le bouton et les onglets
- [ ] Installed embarque le composant existant + compteur/avertissement 50
- [ ] Marketplaces : add, check update avec diff lisible, apply, remove
- [ ] Browse : plugins avec install/remove et skills du plugin installé
- [ ] `intl:extract` + `intl:compile` ; check web + biome verts ; vérification navigateur (URL non GitHub → erreur visible)
