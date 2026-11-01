# Produits retirés de la gamme d’un magasin

Quand une enseigne ne vend plus un produit dans un magasin, seul ce couple **produit + magasin + canal de vente** est marqué « retiré de la gamme ». Le produit lui-même, ses prix dans les autres magasins et son historique ne changent pas.

## Pourquoi

Sans ce statut, un produit retiré d’un magasin est relu à chaque cycle de fraîcheur (7 jours par défaut) : une lecture inutile chaque semaine, et un échec de lecture qui finit par désactiver le connecteur. Avec lui, le connecteur ne revient sur ce produit qu’après un délai réglable.

## Règles

- **Marquage.** Un connecteur qui lit une page où l’enseigne dit que le produit n’est plus vendu l’inscrit dans `v2_store_product_status` (`v2_mark_store_product_discontinued`). Ce n’est ni un échec de lecture ni un motif de désactivation.
- **Délai de revérification.** Paramètres → Connecteurs → *Produits retirés de la gamme* : de 0 à 365 jours, 30 par défaut ; **0 = jamais de revérification automatique**. Le délai court depuis la dernière vérification. Une nouvelle vérification qui trouve encore le produit retiré repart pour un délai complet et garde la date de départ.
- **Fin du statut.** Il se lève tout seul dès qu’un prix plus récent que la dernière vérification est relevé pour ce magasin et ce canal (par un connecteur, une contribution ou Open Prices), ou quand un administrateur demande une nouvelle vérification sur la page du produit (bouton *Revérifier*). Un produit qui revient puis disparaît de nouveau reçoit une nouvelle date de départ.
- **Panier.** Les prix d’un magasin où le produit est retiré, et qui n’ont pas été revus depuis, ne sont pas comparés ; le panier indique combien de prix ont été ignorés (`prices[].withdrawn_count`). L’historique des prix reste affiché sur la page du produit, avec la mention « Retiré de la gamme ».

## Contrat avec les connecteurs

Trois fonctions SQL portent les règles, pour qu’elles restent au même endroit :

- `v2_store_product_held(product_id, store_id, channel) → boolean` : vrai tant que le produit est retiré et que le délai n’est pas écoulé (ou si le délai est 0) ;
- `v2_mark_store_product_discontinued(product_id, store_id, channel)` ;
- `v2_clear_store_product_status(product_id, store_id, channel)`.

Les canaux sont `in_store`, `drive` et `delivery`. Un connecteur qui a lu un prix efface le statut ; un connecteur installé sur une version du cœur qui ne les connaît pas refuse de s’initialiser.

## API

- `GET /api/v2/availability/products/{product_id}` : magasins où le produit est retiré (public, 200 au plus, `truncated` si la liste est coupée).
- `DELETE /api/v2/availability/products/{product_id}/stores/{store_id}?channel=drive` : administrateurs, demande une nouvelle vérification.
- `GET` et `PUT /api/v2/availability/settings` : administrateurs, `recheck_days` et `revision` (un `PUT` périmé reçoit `409`).

La migration `0038_store_product_status` crée les deux tables et les trois fonctions. Aucune donnée personnelle : des identifiants de produit et de magasin, des dates et des valeurs de listes fermées.
