"""PostgreSQL advisory locks taken by the backend, and the whole key space they share.

Two features that pick the same key would wait on each other, and a feature that changes its key
stops excluding the processes still using the old one (old and new backends overlap during an
update). So every key is listed here and none may change:

- (795244, 1): the store lifecycle (a store created, switched on or off, or deleted; an archive
  imported; Open Prices readings saved), transaction lock.
- hashtextextended(lpad(gtin, 14, '0'), 0): one barcode, leading zeros ignored, transaction lock.
- (783216, account id): an account's contribution quotas, transaction lock.
- (783217, account id): an account's shared-basket creation and joining, transaction lock.
- 6782732671: migrate_v2 (app/db/v2_migrations.py), transaction lock.
- 745923101 to 745923103: reserved by the private connectors (session locks).
"""

from __future__ import annotations

STORE_LIFECYCLE = (795244, 1)
ACCOUNT_WRITES = 783216
SHARED_BASKET_MEMBERSHIP = 783217


async def lock_store_lifecycle(connection) -> None:
    """Serialise store lifecycle changes until the end of the caller's transaction."""
    await connection.execute(f"SELECT pg_advisory_xact_lock({STORE_LIFECYCLE[0]}, {STORE_LIFECYCLE[1]})")


async def lock_gtin(connection, barcode: str) -> None:
    """Serialise, until the end of the caller's transaction, what may give one GTIN a product.

    Product approval, the initial submission of a price draft with its product draft, and the
    creation of a barcode-only product take it. Leading zeros are ignored, so "03073781178042"
    and "3073781178042" share the lock.
    """
    await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(lpad($1,14,'0'),0))", barcode)
