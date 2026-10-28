# Duplicate reports and reviewed merges

A signed-in user can report a published product or store duplicate. A URL to the other V2 sheet is optional. The report enters **À valider**. An administrator compares the reported sheet with a candidate found by URL or search, then explicitly acknowledges every differing field in the result editor: conflicting values are red; one-sided values are orange and prefilled; equal values require no action.

Merge requests carry both sheet revisions or content fingerprints. The API recomputes field classifications under row locks and rejects stale or unacknowledged submissions. Only current, public product sheets can merge; store sheets must be public and belong to the same retailer. The source sheet is the canonical result. A duplicate report can also be dismissed without merging.

A successful merge is atomic. The donor row remains as an audit record and its old URL redirects to the canonical sheet. `v2_content_merges` retains before and result snapshots. Product observations (including identical manual readings, preserved with a merge-duplicate marker), price drafts, recipe references, offer links where unambiguous, and transfer mappings are reassigned. Donor GTINs still resolve to the canonical product. Store offers, observations, drafts, accepted aliases and pending nonconflicting alias proposals are reassigned. Both OSM identifiers remain lookup aliases, so the external importer cannot recreate a merged store. A pending alias proposal that is identical to one already pending on the canonical store is rejected as redundant, not deleted.

Merge of stores from different retailers is intentionally refused: price, offer and draft records have composite retailer/store foreign keys. Such a case needs a separately designed retailer-identity change, not a silent relabeling of historical observations.

## Retailer families in the public store directory

The directory groups source retailer labels by an explicit family in
`v2_retailer_groups`. Migration `0024_retailer_groups` groups verified
Auchan, Carrefour, Intermarché and E.Leclerc variants, including duplicate
source rows with identical names. Other names keep separate groups until an
administrator assigns them in **Magasins → Gérer les groupes d’enseignes**.
A name-to-group mapping is retained for future source imports; changing an
assignment moves every source row with that exact normalized name and records
an audit event.

A group changes directory presentation only. Source retailer IDs and names
on stores, offers, drafts and price observations are not rewritten. It does
not silently combine physical points of sale, and the reviewed store merger
still requires both points of sale to have the same source retailer ID.
