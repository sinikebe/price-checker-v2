# Extension de navigateur : mettre à jour le panier en un clic

Certaines enseignes (Carrefour, Intermarché, Courses U) bloquent les lectures automatiques depuis un serveur. L’extension fait la lecture **dans votre navigateur**, sur le site de l’enseigne, avec **votre session et votre magasin choisi** : c’est une visite ordinaire, rien n’est contourné. Réservée aux administrateurs. Carrefour pour l’instant.

## En pratique

1. **Une fois** : *Paramètres → Connecteurs → Extension de navigateur* → *Télécharger l’extension*, décompresser, puis dans Chrome, Edge ou Brave : `chrome://extensions` → mode développeur → *Charger l’extension non empaquetée* sur le dossier. Sur `carrefour.fr`, choisir son drive.
2. **À chaque panier** : sur la page du panier, le même bouton *Récupérer les prix* qu’avant. Il récupère les prix, met en file les connecteurs, puis l’extension lit toute seule les prix Carrefour manquants ou anciens (plus de 7 jours), un produit à la fois, et la comparaison se rafraîchit à la fin. Aucun jeton, aucun numéro de magasin, aucune fenêtre à ouvrir.

Si Carrefour demande une vérification, l’extension amène son onglet au premier plan et attend : terminez la vérification, la lecture reprend seule. Elle s’arrête si le magasin choisi sur le site n’est pas celui de l’application, ou après trois lectures ratées de suite.

## Comment ça marche

- **L’archive est faite pour votre instance.** Le manifeste qu’elle contient ajoute l’adresse de l’instance aux pages que l’extension lit (une adresse précise : https, ou http sur la machine locale, sans joker). Un petit script y fait le lien entre la page du panier et l’extension par des messages locaux de la fenêtre ; il n’accepte qu’un travail vérifié champ par champ (jusqu’à 60 produits, des numéros et des codes-barres, une ville).
- **Qui décide quoi.** La page demande au serveur (`POST /api/v2/extension/plan`) quels produits du panier n’ont pas de prix récent au magasin de l’enseigne, et quel est ce magasin (le seul de l’enseigne qui a déjà des prix ; sinon rien n’est lu). L’extension lit chaque fiche : la recherche du site donne l’adresse, la fiche donne le prix (données structurées schema.org), la disponibilité et le magasin affiché. La page enregistre chaque résultat (`POST /api/v2/extension/readings`).
- **Garde-fous du serveur.** Navigateur et session administrateur seulement (jamais un jeton), origine contrôlée, 600 relevés par heure. Le magasin doit appartenir à l’enseigne lue ; le code-barres doit être celui du produit ; le prix est borné, à deux décimales ; l’adresse de la fiche doit être celle du site. Un prix récent déjà présent n’est pas remplacé.
- **Un produit absent** (la recherche répond normalement mais sans ce code-barres, et le magasin a déjà été confirmé par un prix pendant ce travail) est noté « retiré de la gamme » **à ce magasin seulement**, comme pour les connecteurs ; il n’est relu qu’après le délai réglé dans *Produits retirés de la gamme*.
- **Rythme.** Une pause de 6 à 12 secondes entre deux produits, une seule lecture à la fois, dans l’onglet Carrefour que vous avez déjà ouvert (sinon un onglet en arrière-plan, refermé ensuite).
- **Prix enregistrés** comme ceux d’un connecteur (source « connecteur », fournisseur `carrefour`, canal drive), avec le code-barres exact lu sur la fiche, et visibles dans le journal.

## Le panneau de l’extension

La fenêtre de l’icône reste utilisable seule (adresse, jeton « contribuer » et numéro de magasin) pour lire un produit à la main et le proposer comme capture à valider ; elle n’est pas nécessaire au mode automatique.
