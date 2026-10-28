# Journal public des composants

Le journal est dans `frontend/src/v2/component-changelog.json`. Il est visible sur `/v2/changelog` (toutes les mises à jour) et `/v2/changelog/<composant>` ; `/v2/versions` donne accès à chaque composant.

- `start_versions` fixe le point de départ du contrôle : les anciennes versions ne sont pas à documenter et ce point de départ ne doit plus changer. Les phrases de `baseline` résument quelques fonctions déjà présentes, **sans numéro de version**.
- Pour chaque version incrémentée, choisir **une** décision éditoriale : une note publique dans `releases`, ou une omission justifiée dans `scripts/changelog-omissions.json`. Une petite retouche sans intérêt pour les visiteurs va dans les omissions ; une nouveauté utile va dans le journal. Les deux sont incompatibles pour une même version.
- Les groupes publics de `releases` sont conservés dans l’ordre des mises à jour et affichés du plus récent au plus ancien. `application_version` les regroupe ; le groupe et la note du composant application sont facultatifs quand rien ne mérite d’être annoncé. La version de l’application change toutefois à chaque mise à jour d’un composant.
- Écrire pour les visiteurs : une fonctionnalité ou un bénéfice par phrase, 160 caractères maximum, sans détail technique. Une touche d’humour est bienvenue, pas obligatoire.

La CI exécute `scripts/check_component_changelog.py --base <révision-précédente>` en plus du contrôle des numéros de version. Elle échoue si une version postérieure au point de départ n’a ni note ni omission explicite, si les versions ne correspondent pas ou si une note ou une justification est invalide. `python3 -m unittest discover -s scripts/tests` teste aussi les refus attendus.
