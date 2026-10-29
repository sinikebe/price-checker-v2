# Price Checker V2

![IA assistée](https://img.shields.io/badge/IA-assist%C3%A9e-2f7955)

Plateforme développée avec l’aide d’outils d’IA.

Catalogue collaboratif de produits, panier et recettes, avec une application web installable et utilisable partiellement hors ligne. Les données nutritionnelles peuvent être consultées depuis [Open Food Facts](https://world.openfoodfacts.org/).

Le projet est en cours de développement. Le code source est public sur [GitHub](https://github.com/sinikebe/price-checker-v2). Les fiches produit affichent une courbe de prix par magasin et canal, ainsi que le dernier relevé de chacun classé par prix et signalé selon sa fraîcheur, avec détails au survol, zoom temporel, déplacement et remise à zéro. Un compte peut proposer un prix, publié après validation administrative. Le catalogue se parcourt par rayon, famille, ensemble facultatif, groupe comparable puis produit. La recherche couvre les références, les groupes et les magasins ; les fiches de groupe et d’ensemble comparent les produits qu’elles réunissent.

Les produits, relevés de prix et recettes soumis par un compte sont examinés par un administrateur avant publication. Une modification de recette laisse la version approuvée visible pendant cet examen.

Un compte peut exporter ses données puis demander sa suppression ; les contributions déjà publiées restent visibles sans auteur. Le panier reste sur l’appareil, et la date des relevés est limitée au jour. Le [comportement détaillé](docs/account-deletion.md) est documenté séparément.

## Installer l’application sur un appareil

Depuis l’accueil V2, le bouton **Installer l’application** ouvre l’invitation du navigateur quand elle est disponible. Sinon, il indique le parcours manuel ; sur iPhone et iPad, utiliser **Partager → Sur l’écran d’accueil**. L’installation dépend du navigateur et requiert un accès HTTPS (ou localhost en développement). Elle ne déploie pas le serveur. Le panier reste sur l’appareil ; seules certaines données publiques déjà chargées sont consultables hors ligne. Il accepte un produit précis, un groupe comparable ou un ensemble. Deux boutons comparent les derniers prix publiés : total par point de vente et canal, ou répartition de chaque article au prix relevé le plus bas. Un groupe ou ensemble compte pour un article et retient un produit au prix total le plus bas, dont le conditionnement est affiché. Les résultats peuvent être filtrés par plusieurs magasins, communes et départements. Les comparaisons partielles et les dates des relevés sont signalées ; aucun prix actuel n’est garanti.

## Relever un prix depuis une fiche d’enseigne

Le bookmarklet V2 (`/v2/capture/installer`) lit la fiche produit déjà ouverte dans votre navigateur, sans nouvelle requête à l’enseigne. Après l’avoir ajouté aux favoris, choisissez d’abord le magasin ou Drive sur le site de l’enseigne, ouvrez une fiche, puis lancez « Capturer ce prix ». V2 recherche le produit par EAN. S’il est absent, la même action envoie un brouillon produit privé et une proposition de prix liée, sans attendre la publication de la fiche. Si vous possédez déjà un brouillon pour cet EAN, le prix peut lui être joint directement. Le magasin sélectionné est prérempli quand la page l’expose ; V2 propose une correspondance exacte, des magasins proches ou la création d’un nouveau magasin. Choisir un magasin proche joint une proposition de nom supplémentaire, validée séparément du produit et du prix. Vérifiez le conditionnement, le prix et le point de vente avant l’envoi. L’installateur affiche les enseignes vérifiées sur les captures de test ; voir [rapprochement des magasins](docs/v2-store-aliases.md).

Si le prix affiché ou l’EAN ne sont pas lisibles, la capture ne les invente pas : la recherche du catalogue et le formulaire de prix restent disponibles. Les sites peuvent changer leur présentation ; la capture doit toujours être vérifiée par une personne.

## Informations du service

Les pages **Mentions légales** (`/v2/mentions-legales`), **Confidentialité** (`/v2/confidentialite`) et **Conditions d’utilisation** (`/v2/conditions-utilisation`) sont liées depuis le pied de page et l’inscription. Leur **contenu appartient à chaque instance**, dans trois fichiers Markdown sous son répertoire d’état privé : il n’est ni inclus dans ce dépôt ni copié d’une autre installation. La production refuse de s’installer si ces fichiers manquent. Voir la [procédure d’installation](docs/server-install.md#informations-légales-par-instance) avant de rendre le site public.

## Installation sur serveur

Prévoir Linux, Docker Engine, Docker Compose, Git, OpenSSL, Python 3 et curl, ainsi qu'un reverse proxy HTTPS. Le script prépare une instance PostgreSQL locale par défaut et construit l'API et l'interface web. La configuration de l'application permet aussi de choisir une base PostgreSQL externe, dont Supabase. Il n'installe pas Docker et ne configure ni DNS ni certificat HTTPS public.

```sh
sudo install -d -m 0755 /opt/price-checker-v2
sudo git clone --branch main --single-branch https://github.com/sinikebe/price-checker-v2.git /opt/price-checker-v2/source
sudo /opt/price-checker-v2/source/deployment/v2/install.sh
```

Le web écoute par défaut seulement sur `127.0.0.1:8080` (port configurable à l’installation). Après configuration du reverse proxy HTTPS, ouvrir `/v2` pour initialiser l'application. Le script indique où lire le code d'installation et le mot de passe PostgreSQL générés localement ; aucun compte administrateur n'est créé automatiquement. Conserver ces informations hors du dépôt.

La procédure complète, les sauvegardes et la mise à jour depuis `main` sont décrites dans [la documentation d'installation](docs/server-install.md). Lorsque le programmateur serveur est installé, un administrateur peut demander la mise à jour depuis **Paramètres → Mises à jour du serveur**. La commande manuelle reste disponible :

```sh
sudo /opt/price-checker-v2/source/deployment/v2/update.sh
```

Un push ne déclenche pas directement la mise à jour du serveur ; le programmateur ne la lance automatiquement que si les mises à jour planifiées ont été activées.

## Versions des composants

La page **Versions** est accessible depuis le pied de page de l'accueil V2 (`/v2/versions`). Son [manifeste dans le dépôt](frontend/src/v2/component-versions.json) est inclus dans le build web. Elle distingue l'application, les produits, la capture de prix, les recettes, le panier, la connexion PostgreSQL, les connexions Open Food Facts et Open Prices, les comptes, la PWA et le déploiement. Open Prices importe à faible débit des relevés publics français en euros pour les produits ayant un code-barres ; les relevés restent identifiés comme source tierce. Voir [la politique de synchronisation](docs/v2-prices.md#synchronisation-open-prices).

Les versions sont incrémentées dans les commits de développement, avant la PR vers `main`. La [CI](.github/workflows/ci.yml) vérifie que les composants modifiés ont une version supérieure à la révision précédant chaque push (ou à `main` pour une PR) et que les métadonnées des paquets restent cohérentes ; elle ne pousse plus de commit automatiquement. La capture de prix / bookmarklet a sa propre version numérique, affichée dans le nom du favori ; toute modification de son script ou de sa page exige un incrément. Un changement partagé peut incrémenter plusieurs composants. Documentation et tests seuls ne demandent pas d'incrément. Les règles sont dans [le script de versionnement](scripts/component_versions.py) ; un nouveau fichier applicatif sans règle fait échouer la CI pour imposer un rattachement explicite. La CI ne crée ni tag ni déploiement. Les versions sont celles du code, pas des révisions de synchronisation PWA ni du schéma des données.

Le travail V2 passe par la branche `dev`, puis par une PR vers `main`. La protection de `main` exige une PR à jour et les contrôles backend, frontend, déploiement et **mise à jour d'une installation existante**. Ce dernier installe une révision antérieure, crée des données, lance le véritable `update.sh`, vérifie le démarrage, la conservation des données et la restauration de la sauvegarde ; il teste aussi une installation neuve. Les pushs sur `dev` exercent également ce parcours depuis le SHA précédant le push. L'instance privée de développement suit `dev` ; une publication sur `main` ou en production est une opération distincte.

Le script de versionnement incrémente par défaut la partie correctif ; les changements de version majeure/mineure restent des décisions de publication explicites. Une version affichée sur une installation ne change qu'après mise à jour de cette installation.

## Développement local

- Backend : Python 3.12 ou plus récent. Créer un environnement virtuel, installer `backend/requirements.txt` et le paquet `backend`, puis lancer `uvicorn app.main_v2:app --app-dir backend --reload`. L'API répond sur `http://127.0.0.1:8000`.
- Frontend : Node.js 20. Lancer `npm ci` puis `npm run dev` dans `frontend/`. Ouvrir `http://127.0.0.1:5173/v2.html` ; Vite relaie `/api` vers le backend local.
- L'initialisation nécessite une base PostgreSQL accessible et un navigateur en contexte sécurisé (HTTPS, ou localhost en développement).

Les commandes de vérification locales sont :

```sh
python -m ruff check backend
python -m pytest -q backend/tests
python3 scripts/component_versions.py check
python3 scripts/check_component_changelog.py
python3 -m unittest discover -s scripts/tests
cd frontend && npm ci && npm run lint && npm run test:basket && npm run test:bookmarklet && npm run build
bash -n deployment/v2/install.sh deployment/v2/update.sh
```

Les tests d’intégration PostgreSQL utilisent une base jetable lorsque `V2_AUTH_TEST_CONFIG` désigne un fichier JSON de configuration de test ; sinon ils sont ignorés. La [CI GitHub Actions](.github/workflows/ci.yml) lance les vérifications avec sa propre base de test. Ne jamais utiliser une base contenant des données à conserver pour ces tests.

## Structure

- `backend/` : API FastAPI, migrations et tests.
- `frontend/` : interface React/Vite et PWA.
- `deployment/v2/` : images Docker, installation et mise à jour.
- `docs/price-history.md` : modèle et provenance des prix.

Pour contribuer, ouvrez une [issue publique](https://github.com/sinikebe/price-checker-v2/issues) afin de signaler un problème ou de proposer une amélioration. Licence : [AGPL-3.0](LICENSE).
