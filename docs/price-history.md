# Modèle des prix V2

La migration `0007_price_history` crée des tables relationnelles séparées des fiches produit publiées : `v2_retailers`, `v2_stores`, `v2_offers`, `v2_offer_product_links` et `v2_price_observations`.

Une offre est une collecte brute, conservée même lorsque le prix ne change pas ; son horodatage permet de connaître la fraîcheur de la consultation. `source_kind='capture'` et `captured_via` indiquent une lecture déclenchée par une personne dans son navigateur. Une observation est un changement de prix, de source manuelle, connecteur ou tierce. Une offre peut rester non rapprochée ; le rapprochement vers un produit est explicite.

Une correction n'écrase pas un ancien relevé. C'est une observation manuelle avec `corrected_price` et `correction_status`. Les nouveaux relevés qui répètent le prix contesté restent dans l'historique brut mais sont marqués `superseded` ; un nouveau prix différent résout la correction. Le prix courant se calcule avec le dernier relevé effectif **par magasin**, puis le moins cher de ces magasins pour une enseigne. Les montants sont décimaux et les dates sont horodatées avec fuseau.

Les références `product_id` portent sur des fiches V2 publiées. Lorsqu'une fiche reçoit une nouvelle version (composition ou format changé), les anciennes observations gardent leur référence historique. Un lecteur peut remonter `predecessor_id` pour présenter cet historique archivé, mais ne doit pas le fusionner dans le prix courant de la nouvelle version. `import_key` est facultatif et sert aux imports idempotents, sans imposer une source particulière.

Le schéma ne contient pas de prix initiaux. Les routes V2 exposent les observations publiées et les propositions privées ; la fiche produit affiche les relevés disponibles et non contestés sur une courbe chronologique unique, sans distinguer les magasins ou canaux en séries séparées. Le graphique affiche le détail de chaque point au survol ou au focus clavier ; la molette et les boutons zooment dans le temps, le glisser-déposer et les flèches déplacent la vue, et le bouton Réinitialiser restaure la période complète. Le tableau conserve le détail de chaque relevé. L’export/import V2 transfère les produits et prix publiés entre instances.

## Provenance et contributions

Open Food Facts fournit des fiches produit, **pas des prix**. Un relevé externe comme Open Prices utilise `source='third_party'`, un `source_provider` explicite (`open_prices`) et, si disponible, l'identifiant de la source. Les captures de pages d'enseigne gardent l'URL et la méthode de capture dans l'offre brute.

Une proposition personnelle de prix est une ligne de `v2_price_drafts`, liée à son auteur et **non publiée**. Elle ne crée aucune offre ni observation consultable publiquement et ne participe pas au prix courant. Après validation, l'observation publiée conserve le contributeur, l'identifiant du brouillon et l'identité/date du validateur. Si une capture ne change pas le prix, son offre brute reste liée au brouillon validé sans créer une fausse observation de changement. Les routes limitent l’accès aux brouillons à leur auteur et aux administrateurs, et publient après validation.
