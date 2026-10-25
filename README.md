# Price Checker V2

Catalogue collaboratif de produits, panier et recettes, avec une application web installable et utilisable partiellement hors ligne. Les données nutritionnelles peuvent être consultées depuis [Open Food Facts](https://world.openfoodfacts.org/).

Le projet est en cours de développement. La gestion des produits, du panier et des recettes est disponible ; le schéma des prix, magasins et relevés est documenté, mais ses interfaces de saisie et de consultation ne sont pas encore actives.

## Installation sur serveur

Prévoir Linux, Docker Engine, Docker Compose, Git, OpenSSL et curl, ainsi qu'un reverse proxy HTTPS. Le script prépare une instance PostgreSQL et construit l'API et l'interface web. Il n'installe pas Docker et ne configure ni DNS ni certificat HTTPS public.

```sh
sudo install -d -m 0755 /opt/price-checker-v2
sudo git clone --branch main --single-branch https://github.com/sinikebe/price-checker-v2.git /opt/price-checker-v2/source
sudo /opt/price-checker-v2/source/deployment/v2/install.sh
```

Le web écoute seulement sur `127.0.0.1:8080`. Après configuration du reverse proxy HTTPS, ouvrir `/v2` pour initialiser l'application. Le script indique où lire le code d'installation et le mot de passe PostgreSQL générés localement ; aucun compte administrateur n'est créé automatiquement. Conserver ces informations hors du dépôt.

La procédure complète, les sauvegardes et la mise à jour depuis `main` sont décrites dans [la documentation d'installation](docs/server-install.md). Une mise à jour se lance sur le serveur avec :

```sh
sudo /opt/price-checker-v2/source/deployment/v2/update.sh
```

Elle n'est pas déclenchée automatiquement par un push.

## Développement local

- Backend : Python 3.12 ou plus récent. Créer un environnement virtuel, installer `backend/requirements.txt` et le paquet `backend`, puis lancer `uvicorn app.main_v2:app --app-dir backend --reload`. L'API répond sur `http://127.0.0.1:8000`.
- Frontend : Node.js 20. Lancer `npm ci` puis `npm run dev` dans `frontend/`. Ouvrir `http://127.0.0.1:5173/v2.html` ; Vite relaie `/api` vers le backend local.
- L'initialisation nécessite une base PostgreSQL accessible et un navigateur en contexte sécurisé (HTTPS, ou localhost en développement).

Les commandes de vérification locales sont :

```sh
python -m ruff check backend
python -m pytest -q backend/tests
cd frontend && npm ci && npm run lint && npm run build
bash -n deployment/v2/install.sh deployment/v2/update.sh
```

Le test du schéma des prix utilise une base PostgreSQL jetable lorsque `V2_AUTH_TEST_CONFIG` désigne un fichier JSON de configuration de test ; sinon il est ignoré. La [CI GitHub Actions](.github/workflows/ci.yml) lance les vérifications avec sa propre base de test. Ne jamais utiliser une base contenant des données à conserver pour ce test.

## Structure

- `backend/` : API FastAPI, migrations et tests.
- `frontend/` : interface React/Vite et PWA.
- `deployment/v2/` : images Docker, installation et mise à jour.
- `docs/price-history.md` : modèle et provenance des prix.

Les contributions sont bienvenues via issues et pull requests. Licence : [AGPL-3.0](LICENSE).
