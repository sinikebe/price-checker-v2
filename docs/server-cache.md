# Espace disque et cache du serveur

Chaque mise à jour reconstruit les images de l’application. Les images de la version précédente restent alors sur le disque, sans nom (« dangling »), et le cache de build s’accumule. Sans nettoyage, le disque se remplit au rythme des mises à jour.

## Ce qui est nettoyé

Le nettoyage a une politique fixe, qui ne dépend d’aucun paramètre venant du navigateur :

- `docker image prune -f` : les images sans nom (les versions précédentes de l’application) ;
- `docker builder prune -f --filter until=24h` : le cache de build qu’aucune construction n’a utilisé depuis 24 heures. Le cache réutilisé par les mises à jour quotidiennes reste en place.

Il ne supprime jamais de volume, de conteneur, d’image nommée, ni la base de données et ses sauvegardes.

## Quand

- **Après chaque mise à jour réussie** : `update.sh` lance `deployment/v2/clean_server_cache.py`. Un échec est signalé mais ne fait pas échouer la mise à jour.
- **À la demande** : **Paramètres → Serveur → Espace disque et cache → Nettoyer le cache** (administrateur). Le backend ne peut pas exécuter Docker : il dépose une demande dans le répertoire d’état, que le programmateur système (le minuteur root des mises à jour) exécute au prochain passage, en une minute environ. Un nettoyage est refusé pendant qu’un autre est demandé ou en cours, et dans les cinq minutes qui suivent le précédent. Il attend aussi la fin d’une mise à jour en cours.

Cette fonction demande donc le programmateur système (`deployment/v2/install-scheduler.sh`), qui n’a pas besoin de planification activée.

## Ce que montre la page

L’espace utilisé sur le disque, la taille des images de l’application (et le nombre d’anciennes images), celle du cache de build, le nombre et la taille des sauvegardes locales, et le résultat du dernier nettoyage. Le minuteur actualise ces mesures au moins toutes les six heures, et après chaque nettoyage.

Les sauvegardes locales de mise à jour (`backups/`) sont conservées six mois (voir `prune_local_backups.py`) et ne sont pas touchées par ce nettoyage. Sur une instance qui se met à jour chaque jour, elles peuvent devenir le premier poste d’occupation : leur taille est affichée pour cette raison.

## Fichiers d’état

Le répertoire d’état est écrit par le conteneur backend, donc les scripts root n’y suivent aucun lien symbolique, n’attendent pas sur un tube et ne changent pas le mode d’un fichier par son nom (`deployment/v2/state_files.py`). Fichiers : `cache-clean-request.json` (demande, sans contenu utile), `cache-clean-last-run.json` (résultat), `server-usage.json` (mesures).
