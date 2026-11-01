# Panier et crédits

Le panier reste sur l’appareil. Les prix, eux, sont récupérés **à la demande** : un bouton **Comparer les prix** (puis **Actualiser**) envoie le panier au serveur, qui renvoie en une seule requête les produits candidats et le dernier prix de chaque magasin. Cette récupération coûte **1 crédit**.

Le dernier relevé est conservé dans le navigateur (par compte) ; la page s’ouvre dessus sans rien demander. Filtrer les magasins, exclure un article, activer le panier avancé ou changer les quantités recalcule le résultat sur l’appareil, sans crédit. Un article ajouté ou remplacé depuis le relevé est signalé comme non inclus jusqu’à la prochaine actualisation.

## Critère de comparaison : prix ou prix à l’unité

Le bouton **Prix à l’unité** de la barre d’outils change le critère de choix, sans nouvelle récupération ni crédit. Il est mémorisé dans le navigateur.

- **Prix** (par défaut) : pour chaque article, le produit qui coûte le moins pour la quantité nécessaire, en paquets entiers. C’est le bon choix pour faire ses recettes avec les quantités exactes en payant le moins possible.
- **Prix à l’unité** : pour chaque article, le produit au meilleur prix au kilo, au litre ou à la pièce, même dans un format plus grand que le besoin. C’est le bon choix pour économiser sur la durée, avec l’inconvénient d’acheter parfois plus que nécessaire (5 kg pour 500 g).

En prix à l’unité, le total affiché reste ce qu’il faut payer en caisse. Il est accompagné de la **valeur de la quantité utile** (ce que coûtent vos besoins à ce prix à l’unité), du prix à l’unité de chaque choix et du reste qui ne sert pas (« Reste après vos besoins : 4,5 kg »). Les magasins sont classés selon la valeur de la quantité utile, et l’économie de chaque magasin est mesurée sur cette valeur.

Règles : seuls sont comparés les produits dont la taille est connue et exprimée dans la même unité (grammes, millilitres ou pièces) ; c’est l’unité de la quantité demandée, sinon la plus courante parmi les candidats. Sans quantité demandée, le besoin est un plus petit paquet du groupe (multiplié par le nombre de paquets demandé). Un article dont aucun produit n’a de taille connue reste comparé au prix du paquet. Pour un produit unique, les deux critères donnent le même résultat.

## Économie par magasin

Dans la répartition entre enseignes, chaque magasin indique ce qu’il apporte : le panier est recalculé sans lui (mêmes filtres, mêmes quantités), chaque article prenant alors le prochain prix le plus bas dans les autres magasins comparés. L’écart entre les deux totaux est l’économie, aussi donnée en pourcentage du total sans ce magasin. Cela aide à décider si un détour par une enseigne en vaut la peine. Un magasin est identifié par son point de vente et son canal (magasin, drive, livraison). Si un article n’a de prix que dans ce magasin, la ligne l’indique au lieu d’une économie, et cet article est laissé hors de la comparaison. Le calcul est local, sans crédit, et suit les filtres et le panier avancé.

## Crédits

Chaque compte reçoit **5 crédits par jour**, dans la limite de **20 crédits accordés par semaine** (du lundi au dimanche) et de **20 crédits détenus** à la fois. Le jour et la semaine sont ceux de Paris. Les crédits non utilisés sont reportés ; un jour sans visite n’en accorde pas de supplémentaires. Une requête refusée ou en erreur ne coûte rien : le crédit est dépensé dans la transaction qui lit les prix, une fois la lecture réussie.

Les comptes administrateurs n’ont pas de limite de crédits, pour pouvoir tester : leurs récupérations ne sont pas décomptées (aucune ligne de solde n’est créée) et la réponse porte `unlimited: true`. Un plafond de 60 récupérations par minute et par compte administrateur reste en place contre une boucle incontrôlée ; il est refusé en `429` sans mention de crédit. Le rôle est lu dans la session côté serveur, jamais dans la requête.

Sans compte, le panier reste consultable et modifiable, mais ses prix ne peuvent pas être récupérés : l’interface propose de se connecter.

## API

Ces routes demandent une session de navigateur (pas de jeton personnel).

- `GET /api/v2/basket/credits` : solde, règles et prochaine date d’attribution.
- `POST /api/v2/basket/prices` : `{"items": [...]}` avec, par article, `{"kind": "product", "id"}`, `{"kind": "group", "name"}` ou `{"kind": "scope", "department", "family", "name"}`. Réponse : `lines` (dans l’ordre, avec les identifiants de produits candidats), `products`, `prices` et `credits`. Sans crédit, la réponse est `429` avec `Retry-After`.

Une requête porte au plus 100 articles, compare au plus 300 produits par groupe ou ensemble et 600 produits au total, et renvoie au plus 200 magasins par produit ; les limites atteintes sont signalées dans `lines[].truncated` et `prices[].stores_truncated`. Les prix d’un magasin où le produit est retiré de la gamme (voir `availability.md`) sont laissés de côté et comptés dans `prices[].withdrawn_count`. La migration `0036_basket_credits` crée la table des soldes ; une ligne est créée à la première utilisation d’un compte et supprimée avec lui.
