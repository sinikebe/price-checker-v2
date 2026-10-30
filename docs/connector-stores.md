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

**Fetch** validates the manifest and stages a snapshot without importing code. **Install** verifies the entry, records its exact Git commit and starts processing. **Disable** prevents new work while preserving historical prices and pending queue data. **Enable** resumes. **Update** first stages and verifies a higher numeric version, then switches the installation row. **Restore previous version** switches back to the retained snapshot if necessary. **Uninstall** removes the active installation but preserves price observations. Removing a store also uninstalls its connectors and deletes its local key/snapshots; it does not revoke the GitHub deploy key, which the repository owner should remove separately.

The Versions page reports installed connector versions from each pinned snapshot, including the connector's own changelog. The store catalogue displays the fetched revision's changelog before installation. Manifest changes alone never activate code. Per-connector operational settings may be provided by a trusted connector separately.
