# Bookmarklet DOM regressions

These five reduced HTML fixtures are derived from the user-supplied, sanitized loaded-page captures for Auchan, Carrefour, Intermarché (priced and unavailable), and Courses U. They preserve the actual product JSON-LD, heading, and price/status markup needed by the bookmarklet tests. Full captures stay outside this public repository.

Only public product names, brands, barcodes, prices, and CSS/HTML structure are retained. Store identity, account/session data, retailer application scripts, analytics, and unrelated page content are omitted. The tests assert the expected barcode and price for every fixture; the unavailable Intermarché fixture must yield no price.
