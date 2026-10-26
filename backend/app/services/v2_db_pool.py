"""Bounded API connection pool; migration connections remain separate."""

from __future__ import annotations

import asyncio

import asyncpg

from app.db.v2_migrations import ssl_option

_POOL_SIZE = 10
_pool: asyncpg.Pool | None = None
_pool_key: tuple | None = None
_pool_loop: asyncio.AbstractEventLoop | None = None
_pool_lock = asyncio.Lock()


class PooledConnection:
    def __init__(self, pool: asyncpg.Pool, connection):
        self._pool = pool
        self._connection = connection
        self._closed = False

    def __getattr__(self, name):
        return getattr(self._connection, name)

    async def close(self):
        if not self._closed:
            self._closed = True
            await self._pool.release(self._connection)


async def acquire_v2(config: dict) -> PooledConnection:
    global _pool, _pool_key, _pool_loop, _pool_lock
    loop = asyncio.get_running_loop()
    if _pool_loop is not loop:
        if _pool is not None:
            _pool.terminate()
        _pool, _pool_key, _pool_loop, _pool_lock = None, None, loop, asyncio.Lock()
    key = tuple(config[field] for field in (
        "host", "port", "database", "username", "password", "tls_mode",
    ))
    async with _pool_lock:
        if _pool is None or _pool_key != key:
            if _pool is not None:
                _pool.terminate()
            _pool = await asyncpg.create_pool(
                host=config["host"], port=config["port"],
                user=config["username"], password=config["password"],
                database=config["database"], ssl=ssl_option(config),
                min_size=0, max_size=_POOL_SIZE, timeout=8,
                command_timeout=15,
                server_settings={
                    "statement_timeout": "15000",
                    "idle_in_transaction_session_timeout": "30000",
                },
            )
            _pool_key = key
        pool = _pool
    return PooledConnection(pool, await pool.acquire(timeout=8))


async def close_v2_pool():
    global _pool, _pool_key
    if _pool is not None:
        try:
            await asyncio.wait_for(_pool.close(), timeout=10)
        except (TimeoutError, RuntimeError):
            _pool.terminate()
        _pool, _pool_key = None, None
