# Panier et crédits

Le panier reste sur l’appareil. Les prix, eux, sont récupérés **à la demande** : un bouton **Comparer les prix** (puis **Actualiser**) envoie le panier au serveur, qui renvoie en une seule requête les produits candidats et le dernier prix de chaque magasin. Cette récupération coûte **1 crédit**.

Le dernier relevé est conservé dans le navigateur (par compte) ; la page s’ouvre dessus sans rien demander. Filtrer les magasins, exclure un article, activer le panier avancé ou changer les quantités recalcule le résultat sur l’appareil, sans crédit. Un article ajouté ou remplacé depuis le relevé est signalé comme non inclus jusqu’à la prochaine actualisation.

## Crédits

Chaque compte reçoit **5 crédits par jour**, dans la limite de **20 crédits accordés par semaine** (du lundi au dimanche) et de **20 crédits détenus** à la fois. Le jour et la semaine sont ceux de Paris. Les crédits non utilisés sont reportés ; un jour sans visite n’en accorde pas de supplémentaires. Une requête refusée ou en erreur ne coûte rien : le crédit est dépensé dans la transaction qui lit les prix, une fois la lecture réussie.

Sans compte, le panier reste consultable et modifiable, mais ses prix ne peuvent pas être récupérés : l’interface propose de se connecter.

## API

Ces routes demandent une session de navigateur (pas de jeton personnel).

- `GET /api/v2/basket/credits` : solde, règles et prochaine date d’attribution.
- `POST /api/v2/basket/prices` : `{"items": [...]}` avec, par article, `{"kind": "product", "id"}`, `{"kind": "group", "name"}` ou `{"kind": "scope", "department", "family", "name"}`. Réponse : `lines` (dans l’ordre, avec les identifiants de produits candidats), `products`, `prices` et `credits`. Sans crédit, la réponse est `429` avec `Retry-After`.

Une requête porte au plus 100 articles, compare au plus 300 produits par groupe ou ensemble et 600 produits au total, et renvoie au plus 200 magasins par produit ; les limites atteintes sont signalées dans `lines[].truncated` et `prices[].stores_truncated`. La migration `0036_basket_credits` crée la table des soldes ; une ligne est créée à la première utilisation d’un compte et supprimée avec lui.
