# Journal public des composants

Le journal est dans `frontend/src/v2/component-changelog.json`. Il est visible sur `/v2/changelog` (toutes les mises à jour) et `/v2/changelog/<composant>` ; `/v2/versions` donne accès à chaque composant.

- `start_versions` fixe le point de départ du contrôle : les anciennes versions ne sont pas à documenter. Les phrases de `baseline` résument quelques fonctions déjà présentes, **sans numéro de version**.
- À chaque incrément, ajouter un groupe `releases` dont `application_version` est la nouvelle version de l’application. Y ajouter une entrée `application`, puis une entrée pour chaque autre composant incrémenté avec sa version exacte et une à trois phrases courtes.
- Les groupes sont conservés dans l’ordre des mises à jour ; le site les affiche du plus récent au plus ancien. La version de l’application change à chaque mise à jour d’un composant : c’est la clé du journal global.
- Écrire pour les visiteurs : une fonctionnalité ou un bénéfice par phrase, 160 caractères maximum, sans détail technique. Une touche d’humour est bienvenue, pas obligatoire.

La CI exécute `scripts/check_component_changelog.py --base <révision-précédente>` en plus du contrôle des numéros de version. Elle échoue si une version postérieure au point de départ n’a pas de note, si les versions du groupe ne correspondent pas ou si une note est vide/trop longue. `python3 -m unittest discover -s scripts/tests` teste aussi les refus attendus.
