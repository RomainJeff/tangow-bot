# 11: Garder l'attribution des membres dans le résumé de compaction

**What to build:** Quand un thread de groupe est compacté, le résumé produit dit qui a fait quoi. Aujourd'hui non : le transcript envoyé au modèle qui résume préfixe chaque message par son rôle brut, donc tous les membres du groupe se confondent sous un même `bot:`, indistinguables les uns des autres et du bot qui relira le résumé. Les blocs `handoff` y repartent en identifiants bruts, faute de roster.

C'est la même racine que le ticket 10, une couche au-dessus : les deux requêtes de batch de la compaction ne sélectionnent pas l'auteur du message, et le rendu des blocs n'y reçoit pas la table id→nom que le ticket 10 a rendue disponible.

Ce qui rend ce trou plus coûteux que celui du ticket 10 : le résumé est durable. Il survit à la fenêtre d'historique, donc une attribution perdue à la compaction l'est pour tout le reste du thread — c'est le seul endroit où l'erreur devient permanente. Un bot relisant un thread compacté peut s'attribuer la décision d'un coéquipier sans plus aucun moyen de la rattacher.

Portée : le transcript de compaction uniquement.

**Hors périmètre, à ne pas toucher :**
- La fonction de correspondance de citation dans l'API (`quoteAppearsInBlocks`) : elle compare une citation au texte rendu des blocs. Lui passer un roster changerait le texte comparé et casserait des correspondances qui fonctionnent aujourd'hui.
- Le rendu des steering messages : aucun bloc `handoff` n'emprunte ce chemin.

Le rendu des blocs accepte déjà une table id→nom optionnelle depuis le ticket 10 ; rien de neuf n'est à ajouter côté core. Le roster se charge une fois par compaction, seulement si le thread appartient à un groupe.

**Blocked by:** 10 (attribution des membres dans l'historique), mergé

**Status:** done — mergé en `ec33b9a6`

- [x] Dans un thread de groupe compacté, le transcript soumis au résumé attribue chaque message de membre à son auteur par son nom
- [x] Les `handoff` du transcript se lisent avec des noms, pas des identifiants
- [x] Hors groupe, le transcript est inchangé
- [x] Un auteur absent du roster (membre archivé ou retiré) dégrade proprement, sans nom inventé ni exception
- [x] Le roster est chargé au plus une fois par compaction, et pas du tout hors groupe
- [x] Le budget de caractères du transcript reste respecté, en tenant compte du texte d'attribution ajouté
- [x] La fonction de correspondance de citation et le rendu des steering messages gardent leur comportement actuel
- [x] Test offline : un thread de groupe où les membres B et C ont chacun agi produit un transcript qui distingue les deux
