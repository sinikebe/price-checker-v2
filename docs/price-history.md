# Modèle des prix V2

La migration `0007_price_history` crée des tables relationnelles séparées des fiches produit publiées : `v2_retailers`, `v2_stores`, `v2_offers`, `v2_offer_product_links` et `v2_price_observations`.

Une offre est une collecte brute, conservée même lorsque le prix ne change pas ; son horodatage permet de connaître la fraîcheur de la consultation. `source_kind='capture'` et `captured_via` indiquent une lecture déclenchée par une personne dans son navigateur. Une observation est un changement de prix, de source manuelle, connecteur ou tierce. Une offre peut rester non rapprochée ; le rapprochement vers un produit est explicite.

Une correction n'écrase pas un ancien relevé. C'est une observation manuelle avec `corrected_price` et `correction_status`. Les nouveaux relevés qui répètent le prix contesté restent dans l'historique brut mais sont marqués `superseded` ; un nouveau prix différent résout la correction. Le prix courant se calcule avec le dernier relevé effectif **par magasin**, puis le moins cher de ces magasins pour une enseigne. Les montants sont décimaux et les dates sont horodatées avec fuseau.

Les références `product_id` portent sur des fiches V2 publiées. Lorsqu'une fiche reçoit une nouvelle version (composition ou format changé), les anciennes observations gardent leur référence historique. Un lecteur peut remonter `predecessor_id` pour présenter cet historique archivé, mais ne doit pas le fusionner dans le prix courant de la nouvelle version. `import_key` est facultatif et sert aux imports idempotents, sans imposer une source particulière.

Ce schéma ne contient ni données initiales ni routes de saisie/lecture des prix. Il définit seulement la structure et les contraintes nécessaires avant un futur transfert de données ou l'activation de ces fonctions.

## Provenance et contributions

Open Food Facts fournit des fiches produit, **pas des prix**. Un relevé externe comme Open Prices utilise `source='third_party'`, un `source_provider` explicite (`open_prices`) et, si disponible, l'identifiant de la source. Les captures de pages d'enseigne gardent l'URL et la méthode de capture dans l'offre brute.

Une proposition personnelle de prix est une ligne de `v2_price_drafts`, liée à son auteur et **non publiée**. Elle ne crée aucune offre ni observation consultable publiquement et ne participe pas au prix courant. Après validation, l'observation publiée conserve le contributeur, l'identifiant du brouillon et l'identité/date du validateur. Si une capture ne change pas le prix, son offre brute reste liée au brouillon validé sans créer une fausse observation de changement. Les routes futures devront limiter l'accès aux brouillons à leur auteur et aux administrateurs, et publier atomiquement.
