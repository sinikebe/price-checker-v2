# Journal et statistiques du serveur

Deux écrans réservés aux administrateurs, dans **Paramètres → Journaux** et **Paramètres → Statistiques**. Ils ne contiennent que des codes d’événements, des nombres et des valeurs tirées de listes fermées : jamais de nom, d’adresse IP, d’identifiant de compte, d’URL ni de texte saisi.

## Ce qui est garanti, et comment

- **Registre fermé.** Un événement n’existe que s’il est déclaré dans `EVENTS` (`backend/app/services/v2_logbook.py`), avec ses champs. Chaque champ n’accepte qu’un entier borné, un booléen, une valeur d’une liste fermée ou une chaîne de forme stricte (version, commit court, identifiant). Il n’y a aucun champ de texte libre, ni pour un nom, ni pour un compte, ni pour une requête. Un événement ou une valeur hors registre est écarté, et refusé dans les tests.
- **Phrases côté navigateur.** Le serveur ne stocke aucune phrase : l’écran compose le texte à partir du code et des nombres.
- **Statistiques par modèle de route.** Les requêtes sont comptées par modèle (`/api/v2/products/{product_id}`), méthode et classe de statut, jamais par URL, adresse ou compte. Les routes inconnues sont regroupées sous `unmatched`. Les routes de ces écrans ne sont pas comptées.
- **Pages vues anonymes.** L’application envoie le nom d’une page parmi une liste fixe (`accueil`, `panier`…), sans cookie ni adresse. Une visite est le premier affichage d’une page dans un onglet du navigateur : ce n’est pas un nombre de personnes. Le limiteur de ces envois reste en mémoire et ne stocke aucune adresse.
- **Comptes et contributions.** Ils sont dénombrés à partir des dates que l’application conserve déjà (comptes, propositions, prix publiés par source, recettes, signalements, fusions), sans nouvelle donnée.

## Journal

Niveaux : détail, information, alerte, erreur. Sources : système, connecteurs, panier. Filtres : niveau minimum, sources, connecteur, période (1 h à 30 jours), avec pagination et un suivi en direct facultatif. Conservation : 30 jours et 200 000 lignes au plus.

Événements actuels :

- **Système** : démarrage, migrations appliquées, résultat des mises à jour, nettoyage du cache, alertes de l’hôte. Le backend relit les fichiers de résultat que l’hôte écrit déjà (`update-last-run.json`, `cache-clean-last-run.json`, `host-health.json`) et journalise chaque exécution une fois.
- **Connecteurs** : chaque demande de file d’attente (un résumé par requête : demandés, ajoutés, déjà à jour, en délai, limités) et chaque produit ajouté, les erreurs du worker (au plus une par connecteur et par dix minutes), et chaque prix enregistré par un connecteur, journalisé par un déclencheur de la base quel que soit le code du connecteur.
- **Échecs des connecteurs** : le backend lit les avertissements et erreurs que les connecteurs écrivent dans leur propre journal technique, mais n’en retient que des faits fermés : le nom de la classe de l’exception (`TimeoutError`, `ConnectError`…), le statut HTTP d’un refus du site (403, 429…), le numéro du produit et le fait qu’un connecteur s’est désactivé lui-même. Le texte du message, que le connecteur peut remplir avec n’importe quoi, n’est jamais lu. Un même échec n’est journalisé qu’une fois par tranche de dix secondes. Cela fonctionne avec les connecteurs déjà installés : l’écran traduit la cause (délai dépassé, connexion impossible, navigateur, base de données, refus du site).
- **Panier** : chaque récupération des prix (nombre d’articles et de produits, crédits restants) et chaque refus faute de crédit.

Un connecteur peut aussi journaliser, depuis `app.services.v2_logbook.log_event`, le retrait d’un produit de sa file (`connector.queue.dropped`, avec la raison parmi `fresh_elsewhere`, `cooldown`, `unavailable`) et le résultat d’une lecture (`connector.reading.finished`, avec `complete`, `skipped`, `discontinued` pour un produit retiré de la gamme du magasin, `not_found` pour un produit absent du catalogue de l’enseigne, `rejected` ou `failed`). Ces appels doivent tolérer l’absence du module (`ImportError`).

## Statistiques

Périodes : 1 heure, 24 heures, 7 jours, 30 jours. Les requêtes sont agrégées par tranches de cinq minutes, conservées 30 jours, et ajoutées à la base toutes les 30 secondes. L’écran montre le panier, les prix, les produits et le catalogue, le total des requêtes (refusées et en échec), les visites, les pages vues et les comptes créés, puis les points d’accès triables (requêtes, par heure, erreurs, durée moyenne) et les contributions. Les compteurs commencent à l’installation de cette fonction : l’écran le signale pour les périodes plus longues.

## Ajouter un événement

1. Déclarer l’événement et ses champs dans `EVENTS`, avec le niveau, éventuellement calculé.
2. Ajouter un exemple dans `SAMPLES` de `backend/tests/test_v2_logbook.py` : le test de non-régression vérifie que chaque champ refuse noms, adresses et textes libres.
3. Ajouter sa phrase dans `frontend/src/v2/v2-log-events.ts`.
