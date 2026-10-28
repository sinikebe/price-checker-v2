# Duplicate reports and reviewed merges

A signed-in user can report a published product or store duplicate. A URL to the other V2 sheet is optional. The report enters **À valider**. An administrator compares the reported sheet with a candidate found by URL or search, then explicitly acknowledges every differing field in the result editor: conflicting values are red; one-sided values are orange and prefilled; equal values require no action.

Merge requests carry both sheet revisions or content fingerprints. The API recomputes field classifications under row locks and rejects stale or unacknowledged submissions. Only current, public product sheets can merge; store sheets must be public and belong to the same explicitly configured retailer group. The source sheet is the canonical result. A duplicate report can also be dismissed without merging.

A successful merge is atomic. The donor row remains as an audit record and its old URL redirects to the canonical sheet. `v2_content_merges` retains before and result snapshots. Product observations (including identical manual readings, preserved with a merge-duplicate marker), price drafts, recipe references, offer links where unambiguous, and transfer mappings are reassigned. Donor GTINs still resolve to the canonical product. Store offers, observations, drafts, accepted aliases and pending nonconflicting alias proposals are reassigned. Both OSM identifiers remain lookup aliases, so the external importer cannot recreate a merged store. A pending alias proposal that is identical to one already pending on the canonical store is rejected as redundant, not deleted.

A reviewed store merge may combine two source-retailer IDs only when they belong to the same explicit retailer group. The canonical store keeps its retailer ID. Price observations, offers and drafts move both composite keys together; their original retailer ID is retained in source_retailer_id and exposed in price history. Different groups still cannot merge. The admin comparison shows both source labels, and no stores are merged automatically.

After a merge, new bookmarklet readings for an old product GTIN can attach to the canonical product and pass separate price moderation. Open Prices checks each canonical or merged GTIN under the existing global/hourly and per-GTIN/day budgets. A repeated source price ID does not create another observation. Known Open Prices location IDs and OSM IDs resolve through donor records/aliases to the canonical store, even when an upstream OSM ID changes. Existing Open Food Facts snapshots and queued refreshes remain tied to their source GTIN and can be viewed from the canonical product.

## Retailer families in the public store directory

The directory groups source retailer labels by an explicit family in
`v2_retailer_groups`. Migration `0024_retailer_groups` groups verified
Auchan, Carrefour, Intermarché and E.Leclerc variants, including duplicate
source rows with identical names. Other names keep separate groups until an
administrator assigns them in **Magasins → Gérer les groupes d’enseignes**.
A name-to-group mapping is retained for future source imports; changing an
assignment moves every source row with that exact normalized name and records
an audit event.

A group does not silently combine physical points of sale. It also defines
which variants may be merged by the reviewed editor and considered as capture
candidates. The source retailer on migrated offers, drafts and observations is
kept separately from the canonical store's retailer. Migration
0025_merge_source_retailers_and_barcode_sync seeds the verified family labels
even when they were absent at the time of the initial group migration.
