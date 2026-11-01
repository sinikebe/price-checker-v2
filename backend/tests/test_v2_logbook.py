"""The journal: only registered events and closed values, the logs API and its filters, host results, retention."""
from __future__ import annotations

import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.api.v2 import connector_stores as api
from app.api.v2 import logs
from app.db.v2_migrations import connect_v2, migrate_v2
from app.main_v2 import app
from app.services import v2_logbook as logbook
from app.services import v2_observability as observability
from app.services import v2_request_stats as stats
from fastapi import HTTPException

PERSONAL = ("Jean Dupont", "jean.dupont@example.org", "192.168.1.20", "<script>alert(1)</script>",
            "x" * 500, {"name": "Jean"}, ["a"], None, 3.5, True)


RUN = "2026-11-01T10:00:00+00:00"
QUEUE = {"origin": "basket", "requested": 2, "queued": 1, "fresh": 1, "cooldown": 0, "rate_limited": 0, "other": 0}
# One valid example per registered event: a new event must come with one, and is stored by the test below.
SAMPLES = {
    "system.started": ({"version": "0.1.105"}, None),
    "system.migrated": ({"count": 2, "latest": "0037_logs_and_stats"}, None),
    "update.finished": ({"trigger": "manual", "result": "failed", "run_at": RUN, "reason": "other", "from_sha": "abc1234", "to_sha": "def5678"}, None),
    "cache.cleaned": ({"trigger": "update", "result": "done", "run_at": RUN, "freed_bytes": 10}, None),
    "host.alert": ({"metric": "disk", "pct": 85, "run_at": RUN}, None),
    "connector.queue.requested": (QUEUE, "auchan_houilles"),
    "connector.queue.added": ({"product_id": 1, "origin": "page"}, "auchan_houilles"),
    "connector.queue.dropped": ({"product_id": 1, "reason": "fresh_elsewhere"}, "auchan_houilles"),
    "connector.reading.finished": ({"product_id": 1, "outcome": "complete"}, "auchan_houilles"),
    "connector.price.saved": ({"product_id": 1, "store_id": 2, "price_cents": 259, "channel": "drive"}, "auchan_houilles"),
    "connector.worker.failed": ({"error": "TimeoutError"}, "auchan_houilles"),
    "basket.prices.fetched": ({"items": 1, "products": 2, "truncated": False, "credits_left": 4}, None),
    "basket.prices.refused": ({"reason": "no_credits"}, None),
}


def test_every_registered_field_refuses_names_addresses_and_free_text():
    assert set(SAMPLES) == set(logbook.EVENTS), "each event needs an example above"
    for name, definition in logbook.EVENTS.items():
        assert definition.source in logbook.SOURCES, name
        fields, connector = SAMPLES[name]
        logbook.validate(name, fields, connector)
        for field_name, check in definition.fields.items():
            assert field_name in fields or field_name in definition.optional
            for value in PERSONAL:
                if value is True and field_name == "truncated":
                    continue  # the only yes/no field: True is a legitimate value there
                with pytest.raises(logbook.LogError):
                    check(value)


def test_an_event_needs_its_registered_fields_and_nothing_else():
    ok = {"origin": "basket", "requested": 3, "queued": 1, "fresh": 1, "cooldown": 1, "rate_limited": 0, "other": 0}
    logbook.validate("connector.queue.requested", ok, "auchan_houilles")
    for bad in ({**ok, "username": "jean"}, {k: v for k, v in ok.items() if k != "other"}, {**ok, "queued": -1},
                {**ok, "origin": "somewhere"}, {**ok, "requested": "3"}):
        with pytest.raises(logbook.LogError):
            logbook.validate("connector.queue.requested", bad, "auchan_houilles")
    with pytest.raises(logbook.LogError):
        logbook.validate("connector.queue.requested", ok, None)  # a connector event needs its connector
    with pytest.raises(logbook.LogError):
        logbook.validate("connector.queue.requested", ok, "Jean Dupont")
    with pytest.raises(logbook.LogError):
        logbook.validate("basket.prices.refused", {"reason": "no_credits"}, "auchan_houilles")  # no connector expected
    with pytest.raises(logbook.LogError):
        logbook.validate("made.up.event", {})


def test_levels_follow_the_outcome():
    def level(event, **fields):
        needs_connector = logbook.EVENTS[event].connector
        definition, clean, _ = logbook.validate(event, fields, "auchan_houilles" if needs_connector else None)
        return definition.level_for(clean)
    run_at = "2026-11-01T10:00:00+00:00"
    assert level("update.finished", trigger="manual", result="updated", run_at=run_at) == "info"
    assert level("update.finished", trigger="manual", result="current", run_at=run_at) == "debug"
    assert level("update.finished", trigger="manual", result="failed", run_at=run_at) == "error"
    assert level("connector.reading.finished", product_id=1, outcome="rejected") == "warning"
    queue = {"origin": "basket", "requested": 2, "fresh": 2, "cooldown": 0, "rate_limited": 0, "other": 0}
    assert level("connector.queue.requested", queued=0, **queue) == "debug"
    assert level("connector.queue.requested", queued=1, **queue) == "info"


def test_enqueue_outcomes_are_counted_and_unknown_ones_fall_in_other():
    assert logbook.outcome_counts(["queued", "fresh", "fresh", "cooldown", "rate_limited", "paused", "weird"]) == {
        "queued": 1, "fresh": 2, "cooldown": 1, "rate_limited": 1, "other": 2}


def test_a_repeating_failure_is_journaled_once_per_period(monkeypatch):
    moment = [1000.0]
    monkeypatch.setattr(logbook.time, "monotonic", lambda: moment[0])
    key = secrets.token_hex(4)
    assert logbook.allow_every(key, 600) and not logbook.allow_every(key, 600)
    moment[0] += 601
    assert logbook.allow_every(key, 600)


pytestmark_db = pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required")
sync_db = pytest.mark.skipif(not os.getenv("V2_AUTH_TEST_CONFIG"), reason="Disposable V2 PostgreSQL required")


@pytest_asyncio.fixture
async def config():
    base = json.loads(Path(os.environ["V2_AUTH_TEST_CONFIG"]).read_text())
    database = "v2_logs_" + secrets.token_hex(5)
    admin = await connect_v2(base)
    try:
        await admin.execute('CREATE DATABASE "' + database + '"')
    finally:
        await admin.close()
    configured = {**base, "database": database}
    try:
        await migrate_v2(configured)
        yield configured
    finally:
        admin = await connect_v2(base)
        try:
            await admin.execute('DROP DATABASE "' + database + '" WITH (FORCE)')
        finally:
            await admin.close()


@pytest_asyncio.fixture
async def db(config):
    connection = await connect_v2(config)
    try:
        yield connection
    finally:
        await connection.close()


@pytest.fixture
def served(monkeypatch, config):
    async def connect():
        return await connect_v2(config)

    async def allowed(_request):
        return None
    monkeypatch.setattr(logs, "_connect", connect)
    monkeypatch.setattr(logs, "_require_admin", allowed)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test")


async def rows(db, where="true"):
    return [dict(row) for row in await db.fetch(f"SELECT * FROM v2_logs WHERE {where} ORDER BY id")]


@pytest.mark.asyncio
@pytestmark_db
async def test_migrations_leave_a_journal_entry_and_log_event_stores_only_the_validated_values(db):
    assert [row["event"] for row in await rows(db)] == ["system.migrated"]  # the migration run itself
    assert json.loads((await rows(db))[0]["data"])["count"] >= 30
    assert await logbook.log_event(db, "basket.prices.fetched", items=3, products=5, truncated=False, credits_left=4)
    row = (await rows(db, "event='basket.prices.fetched'"))[0]
    assert (row["level"], row["source"], row["connector"]) == (20, "basket", None)
    assert json.loads(row["data"]) == {"items": 3, "products": 5, "truncated": False, "credits_left": 4}
    moment = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)
    await logbook.log_event(db, "connector.queue.added", connector="auchan_houilles", product_id=7, origin="page", at=moment)
    assert (await rows(db, "event='connector.queue.added'"))[0]["at"] == moment


@pytest.mark.asyncio
@pytestmark_db
async def test_an_invalid_event_is_refused_in_tests_and_dropped_in_production(db, monkeypatch):
    with pytest.raises(logbook.LogError):
        await logbook.log_event(db, "basket.prices.fetched", items=3, products=5, truncated=False, credits_left=4, username="jean")
    monkeypatch.delenv("PRICE_CHECKER_V2_LOG_STRICT")
    assert await logbook.log_event(db, "basket.prices.fetched", items=3, products=5, truncated=False,
                                   credits_left=4, username="jean") is False
    assert await rows(db, "event='basket.prices.fetched'") == []


@pytest.mark.asyncio
@pytestmark_db
async def test_a_journal_failure_never_aborts_the_callers_transaction(db, monkeypatch):
    monkeypatch.delenv("PRICE_CHECKER_V2_LOG_STRICT")
    await db.execute("ALTER TABLE v2_logs RENAME TO v2_logs_away")
    async with db.transaction():
        assert await logbook.log_event(db, "basket.prices.refused", reason="no_credits") is False
        assert await db.fetchval("SELECT 1") == 1  # the surrounding transaction is still usable


@pytest.mark.asyncio
@pytestmark_db
async def test_a_connector_price_is_journaled_by_the_database_whoever_saved_it(db):
    store = await db.fetchval("INSERT INTO v2_connector_stores(name,repository) VALUES('s','https://github.com/o/r') RETURNING id")
    await db.execute("INSERT INTO v2_connector_installations(connector_id,store_id,version,commit_sha) VALUES('auchan_houilles',$1,'0.1.0',$2)",
                     store, "a" * 40)
    retailer = await db.fetchval("INSERT INTO v2_retailers(code,name) VALUES('t','Test') RETURNING id")
    shop = await db.fetchval("INSERT INTO v2_stores(retailer_id,name) VALUES($1,'Shop') RETURNING id", retailer)
    product = await db.fetchval("INSERT INTO v2_products(data) VALUES('{\"name\":\"Lait\"}'::jsonb) RETURNING id")

    async def observe(source, provider, price="2.59"):
        offer = await db.fetchval(
            "INSERT INTO v2_offers(retailer_id,store_id,source_kind,source_provider,channel,external_product_id,title,ean,"
            "price_amount,available,product_url,collected_at) VALUES($1,$2,'connector','auchan','drive','1','Lait','3017620422003',"
            "$3,true,'https://www.auchan.fr/x/pr-C1',now()) RETURNING id", retailer, shop, Decimal(price))
        await db.execute("INSERT INTO v2_price_observations(product_id,retailer_id,store_id,offer_id,source,source_provider,price,observed_at,sales_channel) "
                         "VALUES($1,$2,$3,$4,$5,$6,$7,now(),'drive')", product, retailer, shop, offer if source == "connector" else None,
                         source, provider, Decimal(price))
    await observe("connector", "auchan")
    await observe("connector", "newshop")
    await observe("connector", "Bad Name!")
    await observe("manual", None)
    saved = await rows(db, "event='connector.price.saved'")
    assert [row["connector"] for row in saved] == ["auchan_houilles", "newshop", None]
    assert json.loads(saved[0]["data"]) == {"product_id": product, "store_id": shop, "price_cents": 259, "channel": "drive"}
    assert all(row["level"] == 20 and row["source"] == "connector" for row in saved)


@pytest.mark.asyncio
@pytestmark_db
async def test_the_logs_api_filters_by_level_source_connector_and_period_and_pages_by_cursor(db, served):
    now = datetime.now(UTC)
    await db.execute("DELETE FROM v2_logs")
    await logbook.log_event(db, "system.started", version="0.1.105", at=now - timedelta(days=3))
    await logbook.log_event(db, "update.finished", trigger="manual", result="failed", reason="ci_not_passed",
                            run_at=(now - timedelta(hours=2)).isoformat(), at=now - timedelta(hours=2))
    await logbook.log_event(db, "update.finished", trigger="scheduled", result="current",
                            run_at=(now - timedelta(hours=1)).isoformat(), at=now - timedelta(hours=1))
    for number in range(5):
        await logbook.log_event(db, "connector.queue.added", connector="auchan_houilles" if number % 2 else "chronodrive_cormeilles",
                                product_id=number + 1, origin="basket", at=now - timedelta(minutes=30 - number))
    await logbook.log_event(db, "basket.prices.fetched", items=1, products=1, truncated=False, credits_left=3, at=now)
    async with served as client:
        everything = (await client.get("/api/v2/logs", params={"level": "debug", "period": "30d"})).json()
        assert len(everything["items"]) == 9 and everything["counts"] == {"debug": 1, "info": 7, "error": 1}
        info = (await client.get("/api/v2/logs", params={"period": "24h"})).json()
        assert [item["event"] for item in info["items"]][0] == "basket.prices.fetched"
        assert "update.finished" in {item["event"] for item in info["items"]} and len(info["items"]) == 7, "info and above, last day"
        assert info["connectors"] == ["auchan_houilles", "chronodrive_cormeilles"]
        errors = (await client.get("/api/v2/logs", params={"level": "error", "period": "30d"})).json()["items"]
        assert [(item["event"], item["data"]["reason"]) for item in errors] == [("update.finished", "ci_not_passed")]
        system = (await client.get("/api/v2/logs", params=[("source", "system"), ("period", "30d"), ("level", "debug")])).json()["items"]
        assert {item["source"] for item in system} == {"system"} and len(system) == 3
        mixed = (await client.get("/api/v2/logs", params=[("source", "basket"), ("source", "system"), ("period", "30d")])).json()["items"]
        assert {item["source"] for item in mixed} == {"basket", "system"}
        one = (await client.get("/api/v2/logs", params={"connector": "auchan_houilles"})).json()["items"]
        assert {item["connector"] for item in one} == {"auchan_houilles"} and len(one) == 2
        first = (await client.get("/api/v2/logs", params={"limit": 4, "period": "30d", "level": "debug"})).json()
        assert len(first["items"]) == 4 and first["next_before"].endswith("." + str(first["items"][-1]["id"]))
        assert [item["at"] for item in first["items"]] == sorted((item["at"] for item in first["items"]), reverse=True), "newest first, by time"
        second = (await client.get("/api/v2/logs", params={"limit": 4, "period": "30d", "level": "debug",
                                                          "before": first["next_before"]})).json()
        assert max(item["at"] for item in second["items"]) <= min(item["at"] for item in first["items"])
        assert not {item["id"] for item in second["items"]} & {item["id"] for item in first["items"]}
        last = (await client.get("/api/v2/logs", params={"limit": 200, "period": "30d", "level": "debug",
                                                        "before": second["next_before"]})).json()
        assert last["next_before"] is None and last["items"], "the last page has no cursor"
        assert (await client.get("/api/v2/logs", params={"period": "1h"})).json()["items"][-1]["event"] == "connector.queue.added"
        one_item = first["items"][0]
        assert set(one_item) == {"id", "at", "level", "source", "event", "connector", "data"}


@pytest.mark.asyncio
@pytestmark_db
async def test_the_logs_api_refuses_bad_filters_and_non_administrators(db, served, monkeypatch):
    async with served as client:
        for params in ({"level": "trace"}, {"source": "users"}, {"connector": "Jean Dupont"}, {"connector": "a"},
                       {"period": "1y"}, {"limit": 0}, {"limit": 201}, {"before": "0"}, {"before": "abc"}, {"before": "12.x"}):
            assert (await client.get("/api/v2/logs", params=params)).status_code == 422, params

        async def forbidden(_request):
            raise HTTPException(status_code=403)
        monkeypatch.setattr(logs, "_require_admin", forbidden)
        assert (await client.get("/api/v2/logs")).status_code == 403
        assert (await client.get("/api/v2/logs")).headers.get("cache-control") != "public"


@pytest.mark.asyncio
@pytestmark_db
async def test_host_results_become_events_once_without_their_free_text(db, tmp_path):
    ran = datetime.now(UTC) - timedelta(minutes=10)
    (tmp_path / "update-last-run.json").write_text(json.dumps({
        "at": ran.isoformat(), "result": "failed", "trigger": "manual",
        "message": "CI has not passed for the target commit jean@example.org", "from": "a" * 12}))
    (tmp_path / "cache-clean-last-run.json").write_text(json.dumps(
        {"at": ran.isoformat(), "result": "done", "trigger": "update", "freed_bytes": 1234}))
    (tmp_path / "host-health.json").write_text(json.dumps({"alerts": [
        {"metric": "disk", "at": ran.isoformat(), "pct": 85.4}, {"metric": "gpu", "at": ran.isoformat(), "pct": 90},
        {"metric": "cpu", "at": "not a date", "pct": 90}, "junk"]}))
    assert await observability.ingest_host_events(db, tmp_path) == 3
    assert await observability.ingest_host_events(db, tmp_path) == 0, "polling the same files adds nothing"
    update = json.loads((await rows(db, "event='update.finished'"))[0]["data"])
    assert update == {"trigger": "manual", "result": "failed", "from_sha": "a" * 12, "reason": "ci_not_passed", "run_at": ran.isoformat()}
    assert "example.org" not in json.dumps(update)
    assert json.loads((await rows(db, "event='cache.cleaned'"))[0]["data"])["freed_bytes"] == 1234
    assert json.loads((await rows(db, "event='host.alert'"))[0]["data"])["pct"] == 85
    assert (await rows(db, "event='update.finished'"))[0]["at"] == ran
    # A new run is a new event; a run in progress and unreadable files are ignored.
    (tmp_path / "update-last-run.json").write_text(json.dumps({"at": datetime.now(UTC).isoformat(), "result": "running"}))
    (tmp_path / "cache-clean-last-run.json").write_text("{oops")
    (tmp_path / "host-health.json").unlink()
    assert await observability.ingest_host_events(db, tmp_path) == 0


@pytest.mark.asyncio
@pytestmark_db
async def test_update_failure_reasons_are_closed_categories():
    for message, reason in (("CI has not passed for the target commit", "ci_not_passed"),
                            ("Remote update branch is not a fast-forward", "not_fast_forward"),
                            ("Previous manual update was interrupted", "interrupted"),
                            ("Command '['/opt/x/update.sh']' returned non-zero exit status 1.", "update_failed"),
                            ("something with /home/jean/secret", "other"), (None, "other")):
        assert observability._update_reason(message) == reason


@pytest.mark.asyncio
@pytestmark_db
async def test_old_events_and_counters_are_purged_and_the_journal_is_capped(db, monkeypatch):
    await db.execute("DELETE FROM v2_logs")
    now = datetime.now(UTC)
    await logbook.log_event(db, "system.started", version="0.1.1", at=now - timedelta(days=31))
    for number in range(5):
        await logbook.log_event(db, "system.started", version="0.1.2", at=now - timedelta(minutes=number))
    await db.execute("INSERT INTO v2_request_stats VALUES($1,'/api/v2/x','GET',2,1,5,5),($2,'/api/v2/x','GET',2,1,5,5)",
                     now - timedelta(days=31), now)
    await db.execute("INSERT INTO v2_page_stats VALUES($1,'home',1,1),($2,'home',1,1)", now - timedelta(days=31), now)
    removed = await stats.purge(db)
    assert removed["v2_logs"] == 1 and removed["v2_request_stats"] == 1 and removed["v2_page_stats"] == 1
    monkeypatch.setattr(logbook, "MAX_ROWS", 3)
    assert (await stats.purge(db))["v2_logs"] == 2
    assert await db.fetchval("SELECT count(*) FROM v2_logs") == 3
    assert await db.fetchval("SELECT count(*) FROM v2_request_stats") == 1


@pytest.mark.asyncio
@pytestmark_db
async def test_the_queue_journal_summarises_a_request_and_names_each_product_queued(db):
    await api._journal_queue(db, "auchan_houilles", "basket", {"1": "queued", "2": "fresh", "3": "rate_limited", "4": "weird", "5": "queued"})
    summary = (await rows(db, "event='connector.queue.requested'"))[0]
    assert (summary["connector"], summary["level"]) == ("auchan_houilles", 20)
    assert json.loads(summary["data"]) == {"origin": "basket", "requested": 5, "queued": 2, "fresh": 1,
                                           "cooldown": 0, "rate_limited": 1, "other": 1}
    added = await rows(db, "event='connector.queue.added'")
    assert sorted(json.loads(row["data"])["product_id"] for row in added) == [1, 5]
    await api._journal_queue(db, "auchan_houilles", "page", {"1": "fresh", "2": "cooldown"})
    assert (await rows(db, "event='connector.queue.requested'"))[-1]["level"] == 10, "nothing queued: debug"


@pytest.mark.asyncio
@pytestmark_db
async def test_every_registered_event_can_be_stored_and_read_back(db, served):
    await db.execute("DELETE FROM v2_logs")
    for name, (fields, connector) in SAMPLES.items():
        assert await logbook.log_event(db, name, connector=connector, **fields), name
    async with served as client:
        body = (await client.get("/api/v2/logs", params={"level": "debug", "period": "24h", "limit": 200})).json()
    assert {item["event"] for item in body["items"]} == set(SAMPLES)
    for item in body["items"]:
        assert set(item["data"]) <= set(logbook.EVENTS[item["event"]].fields)
        assert "@" not in json.dumps(item) and "user" not in json.dumps(item).replace("update.finished", "")


@pytest.mark.asyncio
@pytestmark_db
async def test_connector_queue_requests_are_journaled_by_every_route(db, config, monkeypatch, tmp_path):
    monkeypatch.setenv("PRICE_CHECKER_V2_STATE_DIR", str(tmp_path))
    store = await db.fetchval("INSERT INTO v2_connector_stores(name,repository) VALUES('s','https://github.com/o/r') RETURNING id")
    await db.execute("INSERT INTO v2_connector_installations(connector_id,store_id,version,commit_sha,enabled) VALUES('demo',$1,'0.1.0',$2,true)",
                     store, "b" * 40)

    async def connect():
        return await connect_v2(config)
    outcomes = {1: "queued", 2: "fresh", 3: "cooldown", 4: "mystery"}

    async def enqueue(_connection, _connector, product_id, **_kwargs):
        return outcomes[product_id]

    async def statuses(_connection, _connector, product_ids):
        return {str(number): {"status": "eligible" if outcomes[number] == "queued" else outcomes[number], "rank": None} for number in product_ids}
    monkeypatch.setattr(api, "_connect", connect)
    monkeypatch.setattr(api, "enqueue_installed", enqueue)
    monkeypatch.setattr(api, "page_product_statuses", statuses)
    write = {"origin": "https://test"}
    await db.execute("DELETE FROM v2_logs")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("10.9.9.9", 1)), base_url="https://test") as client:
        assert (await client.post("/api/v2/connector-stores/demo/products/refresh", headers=write,
                                  json={"product_ids": [1, 2, 3, 4]})).status_code == 200
        assert (await client.post("/api/v2/connector-stores/demo/products/1/refresh", headers=write)).status_code == 200
        assert (await client.post("/api/v2/connector-stores/demo/products/page-refresh", headers=write,
                                  json={"product_ids": [1, 2]})).status_code == 200
        assert (await client.post("/api/v2/connector-stores/unknown/products/refresh", headers=write,
                                  json={"product_ids": [1]})).status_code == 200
    summaries = await rows(db, "event='connector.queue.requested'")
    seen = [(json.loads(row["data"])["origin"], json.loads(row["data"])["requested"], json.loads(row["data"])["queued"]) for row in summaries]
    assert seen == [("basket", 4, 1), ("single", 1, 1), ("page", 2, 1)], "an unknown connector journals nothing"
    assert json.loads(summaries[0]["data"]) == {"origin": "basket", "requested": 4, "queued": 1, "fresh": 1,
                                                "cooldown": 1, "rate_limited": 0, "other": 1}
    assert {row["connector"] for row in await rows(db)} == {"demo"}
    added = await rows(db, "event='connector.queue.added'")
    assert sorted(json.loads(row["data"])["origin"] for row in added) == ["basket", "page", "single"]
    assert "10.9.9.9" not in json.dumps([str(row) for row in await rows(db)]), "no address in the journal"
