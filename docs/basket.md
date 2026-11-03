# Panier et crédits

Le panier reste sur l’appareil, sauf s’il est partagé en direct (voir [Panier partagé](#panier-partagé)). Les prix, eux, sont récupérés **à la demande** : un bouton **Comparer les prix** (puis **Actualiser**) envoie le panier au serveur, qui renvoie en une seule requête les produits candidats et le dernier prix de chaque magasin. Cette récupération coûte **1 crédit par article inclus** (un groupe ou un ensemble compte pour un article) ; le bouton affiche le montant avant tout envoi. Les articles exclus ne sont ni envoyés ni comptés.

Le dernier relevé est conservé dans le navigateur (par compte) ; la page s’ouvre dessus sans rien demander. Filtrer les magasins, exclure un article, activer le panier avancé ou changer les quantités recalcule le résultat sur l’appareil, sans crédit. Un article ajouté ou remplacé depuis le relevé est signalé comme non inclus jusqu’à la prochaine actualisation.

## Critère de comparaison : prix ou prix à l’unité

Le bouton **Prix à l’unité** de la barre d’outils change le critère de choix, sans nouvelle récupération ni crédit. Il est mémorisé dans le navigateur.

- **Prix** (par défaut) : pour chaque article, le produit qui coûte le moins pour la quantité nécessaire, en paquets entiers. C’est le bon choix pour faire ses recettes avec les quantités exactes en payant le moins possible.
- **Prix à l’unité** : pour chaque article, le produit au meilleur prix au kilo, au litre ou à la pièce, même dans un format plus grand que le besoin. C’est le bon choix pour économiser sur la durée, avec l’inconvénient d’acheter parfois plus que nécessaire (5 kg pour 500 g).

En prix à l’unité, le total affiché reste ce qu’il faut payer en caisse. Il est accompagné de la **valeur de la quantité utile** (ce que coûtent vos besoins à ce prix à l’unité), du prix à l’unité de chaque choix et du reste qui ne sert pas (« Reste après vos besoins : 4,5 kg »). Les magasins sont classés selon la valeur de la quantité utile, et l’économie de chaque magasin est mesurée sur cette valeur.

Règles : seuls sont comparés les produits dont la taille est connue et exprimée dans la même unité (grammes, millilitres ou pièces) ; c’est l’unité de la quantité demandée, sinon celle que vous avez choisie pour l’article, sinon la plus courante parmi les candidats (les grammes avant les millilitres, puis les pièces, à égalité). Sans quantité demandée, le besoin est un plus petit paquet du groupe (multiplié par le nombre de paquets demandé). Un article dont aucun produit n’a de taille connue reste comparé au prix du paquet. Pour un produit unique, les deux critères donnent le même résultat.

### Plusieurs unités pour un même produit

Un produit peut se mesurer de plusieurs façons : au poids, au volume ou à la pièce. La fiche produit liste ces **mesures** (au plus une par unité). Elles viennent de la quantité saisie (« 4x125 g » vaut 500 g et 4 pièces) et d’**autres unités de mesure** ajoutées à la main sur la fiche (« 6 pièces » pour un produit de 750 g). Un lot écrit « 4x125 g » compte donc déjà ses pièces ; une quantité que le programme ne sait pas lire (« 30 tablettes ») peut recevoir son nombre de pièces de la même façon.

Quand les produits d’un article se mesurent dans plusieurs unités, le prix à l’unité propose de basculer : sous le prix à l’unité, des boutons **kg / L / pièce** choisissent l’unité de comparaison de cet article, et le meilleur produit peut changer (le sachet de 10 pièces au meilleur prix au kilo n’a pas forcément le meilleur prix à la pièce). Le choix est mémorisé dans le navigateur, par compte, et n’est pas inclus dans un panier partagé. Il ne change pas la quantité demandée : une quantité demandée en grammes, en millilitres ou en pièces fixe l’unité, et les boutons ne sont pas proposés. Un produit sans mesure dans l’unité choisie est laissé de côté pour cet article ; sans produit mesuré dans cette unité, le choix est ignoré.

Changer les unités d’un produit ne crée pas de nouveau produit : ajouter ou retirer une unité, corriger l’unité de la quantité (« 500 g » devient « 500 ml ») ou la réécrire à l’identique (« 415 g » et « 415g », « 0,5 L » et « 50 cl ») sont des corrections de la même référence, qui garde son historique de prix. Une autre taille dans la même unité (« 250 g » devient « 220 g ») ou un autre conditionnement reste une nouvelle version, puisque les anciens prix valaient pour l’ancienne taille.

La même règle sert aux quantités demandées : « 1 kg » d’un produit vendu en 4 pièces et mesuré aussi à 500 g demande deux paquets. Le graphique du catalogue en tient compte : un produit apparaît dans le prix au kilo, au litre ou à l’unité dès qu’il a une mesure dans cette unité.

## Économie par magasin

Dans la répartition entre enseignes, chaque magasin indique ce qu’il apporte : le panier est recalculé sans lui (mêmes filtres, mêmes quantités), chaque article prenant alors le prochain prix le plus bas dans les autres magasins comparés. L’écart entre les deux totaux est l’économie, aussi donnée en pourcentage du total sans ce magasin. Cela aide à décider si un détour par une enseigne en vaut la peine. Un magasin est identifié par son point de vente et son canal (magasin, drive, livraison). Si un article n’a de prix que dans ce magasin, la ligne l’indique au lieu d’une économie, et cet article est laissé hors de la comparaison. Le calcul est local, sans crédit, et suit les filtres et le panier avancé.

### Désactiver un magasin dans la répartition

Chaque magasin de la répartition a un bouton **Désactiver** : il le laisse de côté pour ce panier sans le retirer des filtres. La répartition est recalculée sur l’appareil, sans nouvelle récupération ni crédit : chaque article prend le prochain meilleur prix dans les magasins restés actifs, et les économies sont mesurées entre eux. C’est utile pour écarter un magasin qui fait peu gagner (un détour qui ne vaut pas la peine). Un article que seul ce magasin vendait reste sans prix dans la répartition, et la page le dit.

Les magasins désactivés sont listés sous la répartition avec un bouton **Réactiver** et ce que leur retour ferait gagner (ou les articles qu’ils sont seuls à vendre). Ils restent dans le classement des magasins, marqués « Désactivé dans la répartition ». Le choix est gardé dans le navigateur, par compte, et n’est pas inclus dans un panier partagé.

## Crédits

Les prix coûtent des crédits partout où ils sont affichés, pour éviter qu’un robot lise tout le catalogue :

- **page d’un produit** : 1 crédit ;
- **page d’un groupe comparable ou d’un ensemble** : 1 crédit par produit qui a un prix (un produit sans prix ne coûte rien) ;
- **panier** : 1 crédit par article inclus.

Rien n’est dépensé en ouvrant une page : un bouton **Voir les prix · N crédits** annonce le montant et le solde, et les prix ne sont récupérés qu’au clic. Les prix payés restent affichés dans ce navigateur, avec leur date, jusqu’à ce que le lecteur demande **Actualiser les prix** (au même coût). Un nouveau relevé arrivé entre-temps est signalé, sans dépense automatique. Le serveur ne facture jamais plus que le montant annoncé : si le nombre de produits avec un prix a augmenté entre-temps, il refuse (`409`) et la page annonce le nouveau montant.

Chaque compte reçoit **50 crédits par jour** (à sa première visite du jour, heure de Paris) et en garde **100 au plus** : au-delà, les crédits du jour sont perdus. Un jour sans visite n’en accorde pas de supplémentaires. Un **visiteur sans compte** dispose de **10 crédits par jour**, comptés par adresse réseau et sans report ; l’adresse n’est jamais enregistrée (seule une empreinte HMAC avec le secret de l’installation, effacée après deux jours). Ces trois montants se règlent dans *Paramètres → Serveur → Crédits pour voir les prix* ; 0 crédit pour les visiteurs impose un compte pour voir les prix.

### Crédits de contribution

Contribuer rapporte des crédits, une fois la contribution **validée par un administrateur** : par défaut **5 par relevé de prix**, **10 par fiche produit** (création ou modification) et **10 par recette**. Ces crédits de contribution :

- n’ont **pas de limite** et ne comptent pas dans les 100 crédits gardés au plus ;
- **n’expirent pas** ;
- ne servent **que lorsque les crédits du jour sont épuisés** (les crédits du jour sont toujours dépensés en premier).

Chaque contribution n’est récompensée qu’une fois, au moment de sa validation ; une contribution refusée ne rapporte rien. Les formulaires (relevé de prix, fiche produit, recette) disent combien leur validation rapportera. *Paramètres → Compte → Vos crédits* montre les deux soldes, la façon d’en gagner et les dernières contributions récompensées. Les montants se règlent avec les autres dans *Paramètres → Serveur* (0 pour qu’un type de contribution ne rapporte rien). Les administrateurs, qui ne sont pas comptés, n’en reçoivent pas.

Une requête refusée ou en erreur ne coûte rien : les crédits sont dépensés dans la transaction qui lit les prix. Une requête venue d’un autre site avec la session du navigateur est refusée avant toute dépense. Les jetons API personnels dépensent les crédits du compte, comme le site.

Les comptes administrateurs n’ont pas de limite de crédits, pour pouvoir tester : leurs récupérations ne sont pas décomptées (aucune ligne de solde n’est créée), la réponse porte `unlimited: true` et leurs pages affichent les prix sans bouton. Un plafond de 60 récupérations de panier par minute et par compte administrateur reste en place contre une boucle incontrôlée ; il est refusé en `429` sans mention de crédit. Le rôle est lu dans la session côté serveur, jamais dans la requête.

Sans compte, le panier reste consultable et modifiable, mais ses prix ne peuvent pas être récupérés : l’interface propose de se connecter.

## Panier partagé

Un compte peut créer un panier partagé, vide ou à partir de son panier (articles et réglages copiés), depuis **Partager → Partager en direct** ou la page **Panier partagé** (`/v2/panier/partage`). Ce panier est **enregistré sur le serveur, jusqu’à ce que son créateur le supprime ou supprime son compte** : l’interface l’indique avant la création et avant de rejoindre.

Le panier personnel et le panier partagé existent côte à côte : chacun a son entrée dans la barre du bas (« Panier » et « Partagé », avec le nombre d’articles ; la seconde apparaît dès que le compte suit un panier partagé, y compris créé sur un autre appareil). Les fiches produit, les pages de groupe et d’ensemble et les recettes proposent **Ajouter au panier** et **Ajouter au panier partagé** : chaque produit va dans l’un, dans l’autre, ou dans les deux.

- **Inviter.** Le panier a un lien d’invitation (`/v2/panier/partage#rejoindre=…` ; les premiers liens en `/v2/panier#rejoindre=…` y mènent aussi, copiable, partageable ou en QR code). Toute personne connectée qui l’ouvre voit qui partage quoi, puis peut **Rejoindre**. Ouvert sans être connecté, le lien est repris après la connexion. Le créateur peut créer un **nouveau lien** : l’ancien cesse de fonctionner, les membres restent. Le lien est un HMAC de l’identifiant du panier et d’un numéro de version, signé avec le secret de l’installation : rien de secret n’est stocké en base.
- **En direct.** Chaque ajout et chaque modification (quantité, inclusion, retrait) du panier partagé est enregistré aussitôt. Chaque membre voit les changements des autres en une seconde environ, sans recharger : une lecture attend sur le serveur le changement suivant (25 s au plus, sans connexion à la base pendant l’attente), et reprend aussitôt. La lecture s’arrête quand la page est masquée.
- **Hors connexion.** Le dernier état connu du panier partagé, le moment où le serveur l’a confirmé et les coches pas encore envoyées sont gardés dans le navigateur : le panier s’ouvre hors connexion **en lecture seule**, avec « Hors ligne » et la date de sa dernière synchronisation dans le bandeau. Seules les coches de sa liste changent hors connexion ; elles partent une à une (`{"op": "tick", "key", "on"}`) dès le retour de la connexion et s’ajoutent à celles des autres membres au lieu de les remplacer. Une modification que le serveur refuse (article retiré du catalogue, limite atteinte) disparaît de l’écran avec un message. Le panier personnel et le dernier relevé de prix de chaque panier sont déjà sur l’appareil. Le lien d’invitation n’est jamais gardé dans le navigateur : hors connexion, il s’affiche au retour de la connexion. À la déconnexion, les copies des paniers partagés, leurs modifications non envoyées et les brouillons du compte sont effacés de l’appareil (le site prévient s’il reste des modifications ou des brouillons jamais envoyés) ; le panier personnel et ses réglages restent. Un bandeau indique l’état (« En direct », « Reconnexion… ») et annonce ce que les autres viennent d’ajouter ; la liste des articles dit qui a ajouté chaque ligne.
- **Réglages communs.** Les filtres de magasins, le panier avancé (quantités), le choix prix ou prix à l’unité, les magasins désactivés dans la répartition, l’unité de chaque article et les articles cochés de la liste de courses sont enregistrés avec le panier partagé : un changement fait par un membre s’affiche chez les autres en direct. Les réglages du panier personnel restent dans le navigateur.
- **Prix.** Chaque membre récupère les prix avec ses propres crédits, comme pour son panier ; le dernier relevé est gardé dans le navigateur, séparément pour chaque panier.
- **Membres.** Le créateur peut renommer le panier, retirer un membre ou **supprimer le panier pour tous** : la suppression est définitive et ne peut pas être annulée, ce que le site rappelle avant de la confirmer. Retirer un membre change aussi le lien d’invitation, pour qu’il ne puisse pas revenir avec l’ancien. Un membre peut quitter le panier ; les articles qu’il a ajoutés restent.

Limites : 100 articles par panier partagé, 20 membres, 10 paniers créés et 30 paniers suivis par compte ; 60 modifications et 120 lectures par minute et par compte ; 30 tentatives d’invitation par 10 minutes, par adresse et par compte ; 200 lectures en attente sur le serveur, 4 par compte (au-delà, le navigateur relit après 10 s). Le serveur fonctionne en un seul processus : le réveil des lectures en attente se fait en mémoire, et une lecture qui le manquerait se termine au plus tard après 25 s.

La migration `0042_shared_baskets` crée les tables `v2_shared_baskets`, `v2_shared_basket_members` et `v2_shared_basket_lines`. L’export des données du compte contient ses paniers partagés et leurs lignes (sans le nom des autres membres). La suppression d’un compte supprime les paniers qu’il a créés ; dans les autres, ses lignes restent sans lien vers lui.

## Hors connexion

L’application installée (ou déjà ouverte dans le navigateur) s’ouvre sans connexion, avec le dernier compte connecté sur l’appareil. La règle est simple : **hors connexion, tout est en lecture seule**, sauf les coches des listes de courses.

- On peut consulter le panier personnel, le panier partagé, leurs articles, leurs derniers prix récupérés et leurs listes, et cocher les articles des listes (pour un panier partagé, les coches partent au retour de la connexion).
- Tout le reste attend la connexion et est désactivé à l’écran : ajouter ou retirer un article (depuis le panier, une fiche produit, un groupe, un ensemble ou une recette), l’exclure, changer sa quantité ou son unité, les quantités, le prix à l’unité, les filtres, les magasins désactivés, le mode de la liste, récupérer les prix, partager, inviter ou gérer un panier partagé. Le panier de démonstration suit la même règle.
- Un panier partagé indique la date de sa dernière synchronisation avec le serveur.

Au retour de la connexion, l’application revérifie la session (elle a pu expirer) et le panier partagé reprend le direct.

## Liste de courses

Chaque panier (personnel ou partagé) a sa vue **Liste de courses** (`/v2/panier/liste`, `/v2/panier/partage/liste`), ouverte depuis le haut du panier ou depuis ses résultats. Ce n’est pas une copie : la liste suit le panier, et pour un panier partagé, elle change en direct pour tous ses membres. Elle a trois modes, gardés avec le panier (dans le navigateur pour le panier personnel, pour tous les membres en direct pour un panier partagé : n’importe quel membre peut changer de mode) :

- **Tous les articles** : les articles inclus du panier, à cocher, avec leur quantité quand le panier avancé est actif. Ce mode n’a besoin d’aucun prix : il fonctionne avant toute comparaison et hors connexion.
- **Répartie entre les magasins** : la répartition la moins chère, magasin par magasin, avec ce qu’il faut prendre dans chacun, son prix et le total du magasin. Les articles qu’aucun magasin comparé ne propose viennent en premier, à chercher sur place.
- **Tout dans un magasin** : tout le panier dans le magasin choisi (la carte d’un magasin du classement ouvre la liste dans ce mode). Les articles sans prix dans ce magasin viennent **en tête**, avec un lien vers leurs alternatives (le groupe comparable, avec ses prix) et, pour un produit, vers sa fiche pour relever son prix sur place.

Les deux modes par magasin suivent les **filtres de magasins** du panier et laissent de côté les **magasins désactivés** : un magasin désactivé n’est plus proposé pour « Tout dans un magasin », et s’il était choisi, la liste le signale. Ils se construisent avec les prix déjà récupérés et gardés sur l’appareil : ils fonctionnent hors connexion, ne coûtent aucun crédit et ne font aucune requête de prix ; un article ajouté depuis le dernier relevé est signalé, à actualiser. Chaque article se coche quand il est pris (pour tous les membres d’un panier partagé) ; **Tout décocher** repart de zéro.

## Panier de démonstration

La page d’accueil raconte un exemple en quatre étapes (remplir le panier, comparer les magasins, répartir les courses, partir avec la liste), puis montre le panier auquel il aboutit, avec un lien vers le **panier de démonstration** (`/v2/panier/demo`, et sa liste `/v2/panier/demo/liste`). Cette page est le panier lui-même, sur les prix de l’exemple : quantités, prix à l’unité, unité de chaque article, filtres par magasin, commune ou département, magasins désactivés, articles exclus ou retirés et liste de courses fonctionnent comme dans un vrai panier. Tout se calcule dans le navigateur : aucun compte, aucun crédit, aucune requête de prix. Les changements du visiteur restent dans l’onglet (`sessionStorage`) ; **Recommencer la démonstration** revient au départ. Tous les chiffres de l’accueil viennent du même calcul que la page, avec les réglages de l’exemple.

Sans autre choix, l’exemple est celui de l’application : un mois de courses (18 articles avec leurs quantités) dans quatre magasins **fictifs**, aux prix fictifs datés à partir du jour, sans lien vers le catalogue. Un **administrateur** peut le remplacer par un panier réel depuis son panier : **Partager → Panier de démonstration**, avec un titre affiché sur l’accueil. Le serveur relit alors lui-même les prix actuels des articles (comme `POST /api/v2/basket/prices`, sans crédit) et enregistre les articles, leurs quantités, les réglages du panier (sans les coches de la liste) et ce relevé. Ces prix deviennent visibles par tous, sans crédit, jusqu’au remplacement suivant ; la page indique leur date. **Revenir à l’exemple intégré** efface le panier enregistré. Un nouvel enregistrement fait repartir la démonstration de zéro pour chaque visiteur.

## API

Ces routes demandent une session de navigateur (pas de jeton personnel).

- `GET /api/v2/basket/credits` : solde, règles et prochaine date d’attribution (comme `GET /api/v2/credits`, qui répond aussi aux visiteurs sans compte).
- `POST /api/v2/basket/prices` : `{"items": [...]}` avec, par article, `{"kind": "product", "id"}`, `{"kind": "group", "name"}` ou `{"kind": "scope", "department", "family", "name"}`. Réponse : `lines` (dans l’ordre, avec les identifiants de produits candidats), `products`, `prices` et `credits`. Sans crédit, la réponse est `429` avec `Retry-After`.

Une requête porte au plus 100 articles, compare au plus 300 produits par groupe ou ensemble et 600 produits au total, et renvoie au plus 200 magasins par produit ; les limites atteintes sont signalées dans `lines[].truncated` et `prices[].stores_truncated`. Les prix d’un magasin où le produit est retiré de la gamme (voir `availability.md`) sont laissés de côté et comptés dans `prices[].withdrawn_count`. La migration `0036_basket_credits` crée la table des soldes ; une ligne est créée à la première utilisation d’un compte et supprimée avec lui.

Paniers partagés (session de navigateur, origine vérifiée pour les écritures, réponses `Cache-Control: private, no-store`) :

- `GET /api/v2/shared-baskets` : les paniers partagés du compte.
- `POST /api/v2/shared-baskets` : `{"name", "lines": [{"line", "quantity", "disabled"}], "settings"?}`, crée un panier partagé ; `line` vaut `{"kind": "product", "product_id"}`, `{"kind": "group", "name"}` ou `{"kind": "scope", "department", "family", "name"}`.
- `GET /api/v2/shared-baskets/{id}` : le panier (membres, lignes avec le produit actuel, lien d’invitation). Avec `?after=<revision>&wait=true`, la réponse attend un changement jusqu’à 25 s ; `204` signifie « rien de neuf », éventuellement avec `Retry-After`.
- `POST /api/v2/shared-baskets/{id}/changes` : `{"ops": [...]}` appliquées dans l’ordre, une ligne étant désignée par ce qu’elle est (`line`) : `{"op": "add", "line", "quantity", "disabled"}` (ajoutée une seule fois), `{"op": "remove", "line"}`, `{"op": "update", "line", "quantity"?, "disabled"?}`, `{"op": "tick", "key", "on"}` (coche ou décoche un seul article de la liste, 100 coches au plus), et `{"op": "settings", "advanced"?, "compare"?, "filters"?, "stores_off"?, "units"?, "checked"?, "list_mode"?}`, qui remplace les réglages nommés (bornés : 200 magasins, 100 villes ou départements, 50 magasins désactivés, une unité et une coche par article ; `list_mode` vaut `all`, `split` ou `store:<magasin>:<canal>`). La migration `0043_shared_basket_settings` ajoute la colonne `settings`.
- `POST /api/v2/shared-baskets/join` : `{"invite", "confirm"}` ; sans `confirm`, décrit le panier sans le rejoindre.
- `PATCH /api/v2/shared-baskets/{id}` (`{"name"}`), `POST /api/v2/shared-baskets/{id}/invite`, `DELETE /api/v2/shared-baskets/{id}` : réservés au créateur. `DELETE /api/v2/shared-baskets/{id}/members/{user_id}` : quitter (son propre identifiant) ou retirer un membre (créateur).

Panier de démonstration :

- `GET /api/v2/demo-basket` : public, `{"demo": null}` sans panier enregistré, sinon `{"demo": {"title", "saved_at", "content": {"items", "settings", "result"}}}`, où `result` a la forme de la réponse de `POST /api/v2/basket/prices` (sans les crédits). Réponse `Cache-Control: no-cache` avec un `ETag` (`304` quand rien n’a changé) ; au plus 60 lectures par minute et par client.
- `PUT /api/v2/demo-basket` : administrateur (session de navigateur, origine vérifiée), `{"title", "lines": [{"line", "quantity", "disabled"}], "settings"}` comme pour un panier partagé (100 articles au plus). Les prix sont relus par le serveur ; un produit qui n’est plus au catalogue, deux articles qui désignent la même chose ou un contenu de plus de 2 Mo sont refusés (`422`). `DELETE /api/v2/demo-basket` revient à l’exemple intégré. Au plus 10 écritures par minute et par compte ; chaque enregistrement est journalisé avec ses seuls nombres d’articles et de produits.
- La migration `0046_demo_basket` crée la table `v2_demo_basket` (une ligne au plus, sans lien vers un compte).
