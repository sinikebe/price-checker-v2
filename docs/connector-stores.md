# Connector stores (V2)

A store is a GitHub repository added by an administrator in **Settings → Connector stores**. The backend fetches it; the browser never handles Git or a deploy key. Only `https://github.com/owner/repo` URLs are accepted. For a private repository, paste an existing unencrypted OpenSSH private key or generate a new key in Settings and add the displayed public key to that repository as a **read-only GitHub deploy key**. Each private store needs its own key. The key is stored under the instance's `/state/connector-stores/<store-id>/deploy-key`, outside the source checkout and database, with mode `0600`; the API never returns it. GitHub's Ed25519 host key is pinned.

The repository root contains `connector-store.json`:

```json
{
  "api": 1,
  "connectors": [{
    "id": "example",
    "name": "Example retailer",
    "version": "0.1.0",
    "changelog": [{"version": "0.1.0", "notes": ["First working release."]}]
  }]
}
```

Each connector supplies `connectors/<id>/entry.py` with `async enqueue(connection, product_id) -> str` and `async process_one() -> None`. It may also export `async setup(connection) -> None`, run transactionally on installation and update to create or migrate its own tables in the `v2_connectors` schema. The bundled database grants the limited application role `CREATE` only within that schema; external database administrators must grant the corresponding privilege to their runtime role. The entry may use relative imports from its directory. The application does not install third-party dependencies from the store: dependencies must be provided by the backend image. A connector can access the backend environment and database; install only trusted code.
An optional `async resume(connection) -> None` hook runs transactionally when an administrator enables a disabled installation. A connector that stops itself after failures can preserve its queue, mark its installation disabled, and clear its internal pause in this hook. A failed hook leaves the installation disabled.

The core calls `process_one()` of each enabled installation in turn, about every 15 seconds. A connector sets its own pace and returns at once when nothing is due; a slow call delays the connectors after it. Shoppers trigger `enqueue` without an account: the basket sends its products, up to 50 per request, to `POST /api/v2/connector-stores/<connector-id>/products/refresh`, and a single product can be sent to `POST /api/v2/connector-stores/<connector-id>/products/<product-id>/refresh`. For basket requests the core calls the optional `async enqueue_basket(connection, product_id) -> str` instead of `enqueue` when the entry exports it, so a connector can serve products a shopper is waiting for before its other queued work; the single-product route always uses `enqueue`. The string a hook returns is passed to the client. The core itself reports `disabled` (the connector is not installed or not enabled), `unavailable` (its code cannot be loaded) and `rate_limited`.

Demand is bounded per product, not per request. Each product costs one unit of two hourly budgets, 6 per client and 12 per connector (`CLIENT_REFRESH_REQUESTS_PER_HOUR` and `REFRESH_REQUESTS_PER_HOUR` in `connector_stores.py`), however many products a request carries. A batch is admitted in order while both budgets last and its remaining products are returned as `rate_limited`; the request is refused with HTTP 429 only when no product fits. A refused product is not charged.

**Fetch** validates the manifest and stages a snapshot without importing code. **Install** verifies the entry, records its exact Git commit and starts processing. **Disable** prevents new work while preserving historical prices and pending queue data. **Enable** resumes. **Update** first stages and verifies a higher numeric version, then switches the installation row. **Restore previous version** is offered only when the new manifest explicitly sets `"rollback_supported": true`, meaning its author has verified compatibility with the prior version's durable state. **Uninstall** removes the active installation but preserves price observations. Removing a store also uninstalls its connectors and deletes its local key/snapshots; it does not revoke the GitHub deploy key, which the repository owner should remove separately.

The Versions page reports installed connector versions from each pinned snapshot, including the connector's own changelog. The store catalogue displays the fetched revision's changelog before installation. Manifest changes alone never activate code. An installed connector may provide admin-only operational settings via `async settings_read(connection) -> dict` and `async settings_write(connection, expected_revision, values) -> None`. The read hook returns a numeric `revision`, `fields` (boolean or bounded integer descriptors) and `values`, and may add a read-only `status` object. Its optional keys are `pending_count` (queued products), `eligible_count` (products due for a reading outside the queue), `paused_at` (set when the connector paused itself), `consecutive_failures` and `next_run_at`. The panel re-reads the settings every minute while it is open, so keep `settings_read` cheap. The write hook validates every value and the expected revision before updating within the core's transaction. Only the installed, pinned version's hooks run; old versions without these hooks remain usable but have no settings form.
