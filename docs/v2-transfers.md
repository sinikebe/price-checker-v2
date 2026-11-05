# Open Food Facts et transfert inter-instances V2

## Open Food Facts, lu par le navigateur

Le serveur ne contacte plus la base produits d’Open Food Facts et n’en conserve rien : ni fiche complète, ni cache, ni file d’actualisation, ni quota partagé (la migration `0050_open_food_facts_in_browser` supprime ces tables). Le navigateur du visiteur lit Open Food Facts **à la demande**, une requête par action, comme le demande le projet :

- sur la fiche d’un produit (mode contribution), le bouton **Afficher les informations d’Open Food Facts** lit la composition, le Nutri-Score, le groupe NOVA et les valeurs nutritionnelles pour 100 g par le code-barres (`/api/v2/product/{code}.json`), affichés avec la mention de la source et de la licence ODbL ;
- dans l’éditeur d’un produit, **Chercher** (recherche par nom, `/cgi/search.pl`) et **Chercher le code saisi** proposent de reprendre seulement le **nom**, la **marque**, la **quantité** et le **code-barres** ; la fiche garde dans `off_source` le code consulté et les informations reprises.

Rien ne part vers Open Food Facts avant le clic ; l’adresse IP du visiteur leur est alors transmise (voir la notice de confidentialité de l’installation). La composition, le Nutri-Score et le groupe NOVA ne sont plus copiés depuis Open Food Facts ; ceux qu’un contributeur saisit lui-même restent. La migration `0050` vide ceux qui avaient été repris d’Open Food Facts (d’après `off_source`) dans les produits, les brouillons et leur historique.

Les relevés de prix d’Open Prices restent importés par le serveur (voir `price-history.md`).

## Transfert inter-instances

Dans **Paramètres → Transférer produits et prix**, un administrateur peut télécharger un JSON versionné puis l'importer dans une autre instance V2. L'archive contient les instantanés des **produits publiés** (y compris leurs versions précédentes), les enseignes et points de vente référencés, et les **observations de prix publiées non remplacées/non contestées** avec prix, date, canal, disponibilité et note. Elle exclut les comptes, sessions, brouillons de produits et de prix, recettes, paniers, offres brutes, journaux d'audit et captures. Les prix transférés sont identifiés sur la destination comme provenant d'une autre instance Price Checker (`third_party`), pas comme des saisies locales approuvées par son admin.

L'import vérifie le format et les références, puis applique le lot dans **une transaction**. L'identifiant stable de l'instance source et les identifiants source rendent un réimport identique idempotent ; de nouveaux produits ou prix source peuvent être ajoutés par un export ultérieur. Un EAN déjà présent dans le catalogue courant cible, un produit source modifié après un précédent import ou une archive invalide bloque le lot entier avec 409/422, sans écraser les données locales. Il s'agit d'un **transfert ponctuel, pas d'une synchronisation** : un relevé retiré ou contesté après l'export n'est pas supprimé automatiquement sur la destination. Exporter/importer uniquement depuis des instances V2 de confiance. Limite du transfert Web : 24 Mio par archive.

Avant l’import, le panneau administrateur vérifie l’archive avec `POST /api/v2/transfers/import/preview`. Les **points de vente déjà supprimés** y portent un repère visuel et nécessitent une validation explicite : le jeton `approval_token` renvoyé par l’aperçu est transmis dans l’en-tête `X-V2-Deleted-Store-Approval` du `POST /api/v2/transfers/import`. Ce jeton n’est accepté que pour le contenu exact de l’archive et les suppressions encore en vigueur ; sans validation, le lot entier reçoit 409. Après réimportation validée, le marqueur de suppression de cette source est retiré. Un point de vente désactivé doit être réactivé séparément avant l’import ; il ne l’est jamais implicitement.
