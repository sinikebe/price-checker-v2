# Installation et mise à jour sur un serveur Linux

Ce guide décrit l'installation de Price Checker V2 depuis la branche `main`. Il suppose un hôte Linux dédié, administré via SSH, et un reverse proxy HTTPS déjà prévu. Les scripts ne modifient pas les paquets système, le DNS, le pare-feu ni le certificat HTTPS public.

## Pré-requis

- Docker Engine, le plugin `docker compose`, Git, OpenSSL, curl et Python 3 (pour vérifier la cible de la sauvegarde avant une mise à jour).
- Espace disque pour les images, PostgreSQL et les sauvegardes avant mise à jour.
- Un répertoire persistant et sauvegardé pour `/var/lib/price-checker-v2`, **ainsi que** le volume Docker `price-checker-v2-prod_postgres_data`. Le répertoire seul ne contient pas les données de la base.
- Un reverse proxy HTTPS vers `127.0.0.1:8080`. Il doit transmettre `Host`, définir lui-même `X-Forwarded-Proto: https` et remplacer `X-Forwarded-For` par l'adresse réelle du client. Ne pas faire confiance aux valeurs de ces en-têtes envoyées par le navigateur.
- N'exposer publiquement que les ports nécessaires au service HTTPS. Les ports 8080 et 5432 doivent rester privés.

## Installation

```sh
sudo install -d -m 0755 /opt/price-checker-v2
sudo git clone --branch main --single-branch https://github.com/sinikebe/price-checker-v2.git /opt/price-checker-v2/source
sudo /opt/price-checker-v2/source/deployment/v2/install.sh
```

L'installation exige un checkout `main` propre. Elle crée un mot de passe PostgreSQL aléatoire dans `/var/lib/price-checker-v2/postgres/password`, génère un certificat TLS local pour le nom `db`, puis construit les conteneurs. Aucun compte administrateur n'est créé automatiquement. Le serveur web est lié à `127.0.0.1:8080`, sans exposition directe sur le réseau.

Configurer le reverse proxy HTTPS, puis ouvrir `https://<votre-domaine>/v2`. Le code d'installation se trouve dans `/var/lib/price-checker-v2/state/access-code` après le premier accès à l'API. Pour la base locale créée par le script, utiliser :

| Champ | Valeur |
| --- | --- |
| Fournisseur | PostgreSQL |
| Hôte | `db` |
| Port | `5432` |
| Base et utilisateur | `pricechecker_v2_prod` |
| Mot de passe | contenu de `/var/lib/price-checker-v2/postgres/password` |
| TLS | `verify-full` |

Lire le code et le mot de passe uniquement sur le serveur, par exemple avec `sudo cat`, sans les recopier dans Git. Le nom d'hôte public peut être renseigné dans l'interface. Le certificat PostgreSQL local n'est pas le certificat HTTPS public.

## Mise à jour depuis `main`

```sh
sudo /opt/price-checker-v2/source/deployment/v2/update.sh
```

Le script verrouille l'opération, refuse un checkout sale ou une branche autre que `main`, récupère `origin/main` et exige une avance fast-forward. Il sauvegarde **la base réellement configurée** au format dump vérifié dans `/var/lib/price-checker-v2/backups/` avant toute migration. Pour une base externe, il emploie l’hôte, le port, la base, l’utilisateur et le mode TLS de la configuration V2 ; le mot de passe passe par un fichier temporaire protégé, effacé après la sauvegarde. Le client `pg_dump` fourni est celui de PostgreSQL 16 : s’il ne peut pas sauvegarder une base d’une autre version, la mise à jour s’arrête avant le changement de code et les migrations. Une connexion réseau au serveur externe depuis le conteneur `db` est nécessaire. Le script reconstruit ensuite les images, applique les migrations, redémarre l’application et vérifie une requête API impliquant la base. En cas d'échec après le changement de commit, il restaure le code et reconstruit les anciens conteneurs. **Les migrations de base déjà exécutées ne sont pas annulées automatiquement** : conserver le dump pour une restauration manuelle si nécessaire.

Le certificat PostgreSQL local est renouvelé par ce même script dès qu’il lui reste moins de 60 jours de validité, même sans nouveau commit. La base et l’API sont redémarrées ensemble ; l’ancien certificat et sa clé restent dans un répertoire de sauvegarde protégé. Exécuter `update.sh` périodiquement (au moins une fois par mois) pour que cette rotation se produise avant l’expiration. Ce certificat ne concerne pas une base externe.

Sur une installation externe qui utilise encore l’ancien script refusant cette mise à jour, mettre d’abord le checkout à jour par `git fetch origin main` puis `git merge --ff-only origin/main` **après avoir réalisé et vérifié une sauvegarde externe indépendante** ; lancer ensuite le nouveau `update.sh`. Cette transition ponctuelle ne doit pas utiliser l’ancien updater.

Un push sur GitHub ne met pas le serveur à jour automatiquement. Lancer la commande après vérification des changements, ou la planifier explicitement dans une tâche système une fois l'installation validée.

Pour diagnostiquer, consulter `docker compose --env-file /opt/price-checker-v2/source/.env -f /opt/price-checker-v2/source/deployment/v2/compose.yaml logs --tail=100`. Le fichier `.env` local conserve la configuration de l'installation et est ignoré par Git. Exporter `PRICE_CHECKER_V2_DATA_DIR` avant l'installation si le stockage persistant est monté ailleurs ; ne pas remplacer ce volume pendant les mises à jour.

## Instance de développement isolée

Sur un hôte de test, définir `PRICE_CHECKER_V2_ENV=dev` lors de la première installation. Les valeurs par défaut deviennent `/var/lib/price-checker-v2-dev`, la base et l'utilisateur `pricechecker_v2_dev`, et `APP_ENV=dev`. Le fichier `.env` local conserve ces réglages pour les mises à jour suivantes. Un mot de passe de test peut être placé avant l'installation dans `/var/lib/price-checker-v2-dev/postgres/password` (mode 0600) ; le script ne le remplace pas.

```sh
sudo env PRICE_CHECKER_V2_ENV=dev /opt/price-checker-v2/source/deployment/v2/install.sh
sudo /opt/price-checker-v2/source/deployment/v2/update.sh
```

Même en développement, le port 8080 reste lié à la boucle locale. Configurer séparément un accès HTTPS privé pour l'initialisation dans le navigateur. Le champ « Nom d'hôte » est facultatif en développement et accepte un nom local (`localhost`, `machine.local`) ou une adresse IP ; il ne configure ni la résolution du nom ni HTTPS.
