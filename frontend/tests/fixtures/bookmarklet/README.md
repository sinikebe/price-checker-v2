# Bookmarklet DOM regressions

These five reduced HTML fixtures are derived from the user-supplied, sanitized loaded-page captures for Auchan, Carrefour, Intermarché (priced and unavailable), and Courses U. They preserve the actual product JSON-LD, heading, and price/status markup needed by the bookmarklet tests. Full captures stay outside this public repository.

Only public product and selected-store names, barcodes, prices, and necessary CSS/HTML structure are retained. A minimal Courses U fixture annotation supplies the selected-store name originally exposed by tc_vars; the test injects only that value into the page context. Account/session data, addresses, retailer application scripts, analytics payloads, and unrelated page content are omitted. The tests assert the expected barcode and price for every fixture; the unavailable Intermarché fixture must yield no price.
