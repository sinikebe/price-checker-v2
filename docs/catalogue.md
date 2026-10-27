# Catalogue par groupes comparables

La page /v2/produits affiche **les groupes comparables existants**, sans créer de champ « catégorie » parallèle. Les produits sans groupe apparaissent dans « Sans groupe ». La casse est ignorée pour regrouper les libellés, mais les libellés enregistrés ne sont pas modifiés.

La liste de groupes, les résultats de recherche et la liste des produits dans une fiche de groupe sont paginés ; le lecteur choisit 10, 20 ou 50 éléments par page. La recherche textuelle couvre le nom, la marque, le nom commercial, la quantité et le code-barres. Les filtres de groupe et de magasin sont repliés par défaut pour garder un écran mobile court. Le filtre magasin porte sur les points de vente ayant au moins un relevé publié pour la référence ; il nécessite une connexion. La sélection se fait par recherche de nom ou de ville et reste explicite avant l’application du filtre.

La fiche /v2/categories/<groupe> trace les relevés disponibles non contestés de **tous** les produits du groupe, au plus 30 relevés récents par produit. Tous les produits restent listés et liés même sans prix. En mode hors ligne, le catalogue peut déduire les groupes et rechercher parmi les produits publics déjà conservés dans le cache PWA ; le graphique des prix et le filtre magasin ne sont pas disponibles hors ligne.
