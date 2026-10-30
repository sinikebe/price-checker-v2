"""Server-side GitHub connector store: validated catalogues and pinned code snapshots.

Only administrators can configure a store. A store is trusted executable Python code;
fetching a catalogue never imports or runs it. Each installation is pinned to a commit.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


_REPO = re.compile(r"^https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$")
_ID = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
_SHA = re.compile(r"^[a-f0-9]{40}$")
# GitHub's published Ed25519 host key, pinned instead of trust-on-first-use.
_GITHUB_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n"
_cache: dict[tuple[str, str], object] = {}
_fetch_lock = asyncio.Lock()


def repository_url(value: str) -> tuple[str, str]:
    match = _REPO.fullmatch(value.strip())
    if not match or match.group(2) in (".", ".."):
        raise ValueError("Utilisez une URL HTTPS de dépôt GitHub (github.com/propriétaire/dépôt).")
    owner, repo = (part.lower() for part in match.groups())
    return f"https://github.com/{owner}/{repo}.git", f"git@github.com:{owner}/{repo}.git"


def store_dir(store_id: int) -> Path:
    from app.api.v2.setup import _ensure_state_dir
    return _ensure_state_dir() / "connector-stores" / str(store_id)


def key_path(store_id: int) -> Path:
    return store_dir(store_id) / "deploy-key"


def save_key(store_id: int, value: str) -> None:
    if len(value) > 16384 or not value.startswith("-----BEGIN OPENSSH PRIVATE KEY-----\n"):
        raise ValueError("Clé privée SSH OpenSSH invalide.")
    directory = store_dir(store_id)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix="deploy-key-", dir=directory)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(value.rstrip() + "\n")
        temporary.chmod(0o600)
        subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(temporary)],
                       check=True, capture_output=True, timeout=10)
        temporary.replace(key_path(store_id))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ValueError("Clé privée SSH non prise en charge ou protégée par une phrase secrète.") from exc
    finally:
        temporary.unlink(missing_ok=True)


def generate_key(store_id: int) -> str:
    directory = store_dir(store_id)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        path = Path(temporary) / "key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path)],
                       check=True, capture_output=True, timeout=10)
        public = path.with_suffix(".pub").read_text(encoding="utf-8").strip()
        path.chmod(0o600)
        path.replace(key_path(store_id))
        return public


def public_key(store_id: int) -> str | None:
    path = key_path(store_id)
    if not path.is_file():
        return None
    result = subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(path)],
                            check=True, capture_output=True, text=True, timeout=10)
    return result.stdout.strip()


def _git_env(store_id: int, private: bool) -> dict[str, str]:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_LFS_SKIP_SMUDGE"] = "1"
    if private:
        path = key_path(store_id)
        if not path.is_file():
            raise ValueError("Ajoutez ou générez d’abord la clé SSH de ce store.")
        known_hosts = store_dir(store_id) / "known-hosts"
        if not known_hosts.exists():
            known_hosts.write_text(_GITHUB_HOST_KEY, encoding="ascii")
            known_hosts.chmod(0o600)
        env["GIT_SSH_COMMAND"] = (
            f"ssh -i {shlex.quote(str(path))} -o IdentitiesOnly=yes -o BatchMode=yes "
            f"-o StrictHostKeyChecking=yes -o UserKnownHostsFile={shlex.quote(str(known_hosts))}"
        )
    return env


def validate_catalog(root: Path) -> list[dict]:
    path = root / "connector-store.json"
    if not path.is_file() or path.is_symlink():
        raise ValueError("Le dépôt doit contenir connector-store.json à sa racine.")
    if path.stat().st_size > 256_000:
        raise ValueError("Manifeste de store trop volumineux.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Manifeste JSON invalide.") from exc
    if not isinstance(data, dict) or data.get("api") != 1 or not isinstance(data.get("connectors"), list):
        raise ValueError("Format de manifeste non pris en charge.")
    if len(data["connectors"]) > 100:
        raise ValueError("Trop de connecteurs dans ce store.")
    seen: set[str] = set()
    result = []
    for item in data["connectors"]:
        if not isinstance(item, dict):
            raise ValueError("Entrée de connecteur invalide.")
        identifier, version, name = item.get("id"), item.get("version"), item.get("name")
        if not isinstance(identifier, str) or not _ID.fullmatch(identifier) or identifier in seen:
            raise ValueError("Identifiant de connecteur invalide ou dupliqué.")
        if not isinstance(version, str) or not _VERSION.fullmatch(version):
            raise ValueError("Version numérique de connecteur requise.")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("Nom de connecteur invalide.")
        entry = f"connectors/{identifier}/entry.py"
        entry_path = root / entry
        if (not entry_path.is_file() or entry_path.is_symlink()
                or not entry_path.resolve().is_relative_to(root.resolve())
                or entry_path.stat().st_size > 200_000):
            raise ValueError(f"Code d’entrée absent ou invalide pour {identifier}.")
        changes = item.get("changelog")
        if not isinstance(changes, list) or not changes or len(changes) > 50:
            raise ValueError(f"Journal des versions requis pour {identifier}.")
        versions = set()
        for change in changes:
            if not isinstance(change, dict) or not isinstance(change.get("version"), str) or not _VERSION.fullmatch(change["version"]):
                raise ValueError("Version de journal invalide.")
            notes = change.get("notes")
            if change["version"] in versions or not isinstance(notes, list) or not notes or any(not isinstance(note, str) or not 1 <= len(note) <= 500 for note in notes):
                raise ValueError("Notes de changement invalides ou répétées.")
            versions.add(change["version"])
        if version not in versions:
            raise ValueError(f"Le journal de {identifier} doit décrire la version courante.")
        rollback_supported = item.get("rollback_supported", False)
        if not isinstance(rollback_supported, bool):
            raise ValueError("Compatibilité de restauration invalide.")
        seen.add(identifier)
        result.append({"id": identifier, "name": name.strip(), "version": version,
                       "entry": entry, "changelog": changes,
                       "rollback_supported": rollback_supported})
    return result


def _fetch_sync(store_id: int, repository: str, private: bool) -> tuple[str, list[dict]]:
    public_url, ssh_url = repository_url(repository)
    directory = store_dir(store_id)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fetch-", dir=directory) as temporary:
        root = Path(temporary) / "source"
        try:
            subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--depth=1",
                            ssh_url if private else public_url, str(root)],
                           env=_git_env(store_id, private), check=True, capture_output=True, timeout=90)
            commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                                    check=True, capture_output=True, text=True, timeout=10).stdout.strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ValueError("Impossible de récupérer le dépôt GitHub avec cet accès.") from exc
        if not _SHA.fullmatch(commit):
            raise ValueError("Révision Git invalide.")
        catalog = validate_catalog(root)
        target = directory / "revisions" / commit
        if not target.exists():
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.rmtree(root / ".git")
            root.replace(target)
        return commit, catalog


async def fetch_store(store_id: int, repository: str, private: bool) -> tuple[str, list[dict]]:
    async with _fetch_lock:
        return await asyncio.to_thread(_fetch_sync, store_id, repository, private)


def load_installed(store_id: int, connector_id: str, commit: str):
    cache_key = (str(store_id) + "/" + connector_id, commit)
    if cache_key in _cache:
        return _cache[cache_key]
    if not _ID.fullmatch(connector_id) or not _SHA.fullmatch(commit):
        raise ValueError("Connecteur ou révision invalide.")
    path = store_dir(store_id) / "revisions" / commit / "connectors" / connector_id / "entry.py"
    if (not path.is_file() or path.is_symlink()
            or not path.resolve().is_relative_to((store_dir(store_id) / "revisions" / commit).resolve())):
        raise FileNotFoundError("Code du connecteur installé introuvable.")
    name = f"price_checker_connector_{store_id}_{connector_id}_{commit}"
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)])
    if spec is None or spec.loader is None:
        raise ImportError("Connecteur illisible.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        if not callable(getattr(module, "enqueue", None)) or not callable(getattr(module, "process_one", None)):
            raise ValueError("Le connecteur doit fournir enqueue et process_one.")
    except Exception:
        sys.modules.pop(name, None)
        raise
    _cache[cache_key] = module
    return module
