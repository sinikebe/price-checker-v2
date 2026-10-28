#!/usr/bin/env python3
"""Validate and patch-bump V2 component versions from changed source paths.

The manifest is shipped with the frontend so the displayed numbers are the
numbers in the installed bundle. GitHub Actions runs this after checks on main.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tomllib
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "frontend/src/v2/component-versions.json"
FRONTEND_PACKAGE = ROOT / "frontend/package.json"
FRONTEND_LOCK = ROOT / "frontend/package-lock.json"
BACKEND_PACKAGE = ROOT / "backend/pyproject.toml"

# A rule may affect several components. The application version is bumped
# once for every push with at least one affected implementation component.
RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("backend/app/api/v2/products.py", ("products", "open_food_facts")),
    ("backend/app/api/v2/catalogue.py", ("products",)),
    ("backend/app/api/v2/prices.py", ("products",)),
    ("backend/app/api/v2/transfers.py", ("products", "database")),
    ("backend/app/api/v2/recipes.py", ("recipes",)),
    ("backend/app/api/v2/recipe_submissions.py", ("recipes",)),
    ("backend/app/api/v2/auth.py", ("accounts",)),
    ("backend/app/api/v2/account_data.py", ("accounts",)),
    ("backend/app/api/v2/moderation.py", ("products", "recipes", "accounts", "pwa")),
    ("backend/app/api/v2/setup.py", ("database",)),
    ("backend/app/api/v2/updates.py", ("deployment",)),
    ("backend/app/api/v2/sync.py", ("pwa", "products", "recipes", "basket")),
    ("backend/app/api/v2/off.py", ("open_food_facts",)),
    ("backend/app/core/*.py", ("database",)),
    ("backend/app/db/*.py", ("database",)),
    ("backend/app/services/off_*.py", ("open_food_facts",)),
    ("backend/app/services/openfoodfacts_client.py", ("open_food_facts",)),
    ("backend/app/services/v2_off_snapshot.py", ("open_food_facts",)),
    ("backend/app/services/v2_off_refresh_queue.py", ("open_food_facts",)),
    ("backend/app/services/v2_open_prices_sync.py", ("open_prices",)),
    ("backend/app/services/v2_price_history.py", ("products", "open_prices")),
    ("backend/app/services/v2_write_limits.py", ("accounts", "products", "recipes")),
    ("backend/app/services/v2_visibility.py", ("products", "recipes")),
    ("backend/app/services/v2_trusted_proxy.py", ("accounts", "deployment")),
    ("backend/app/services/v2_db_pool.py", ("database",)),
    ("backend/app/services/v2_private_retention.py", ("accounts", "database")),
    ("backend/app/services/quantity_parser.py", ("products", "recipes")),
    ("backend/app/schemas/off.py", ("open_food_facts",)),
    ("backend/app/schemas/openfoodfacts.py", ("open_food_facts",)),
    ("frontend/src/v2/V2ProductWorkspace.tsx", ("products", "open_food_facts")),
    ("frontend/src/v2/V2PriceHistory.tsx", ("products", "open_prices")),
    ("frontend/src/v2/V2CapturePage.tsx", ("products", "bookmarklet")),
    ("frontend/src/v2/bookmarklet-capture.js", ("products", "bookmarklet")),
    ("frontend/src/v2/v2-capture.css", ("products", "bookmarklet")),
    ("frontend/src/v2/V2CataloguePage.tsx", ("products", "open_prices")),
    ("frontend/src/v2/v2-catalogue.css", ("products",)),
    ("frontend/src/v2/V2ReportControl.tsx", ("products", "recipes")),
    ("frontend/src/v2/V2AccountDeletion.tsx", ("accounts", "pwa")),
    ("frontend/src/v2/V2ModerationPanel.tsx", ("products", "recipes")),
    ("frontend/src/v2/v2-moderation-api.ts", ("products", "recipes")),
    ("frontend/src/v2/v2-price-history.css", ("products",)),
    ("frontend/src/v2/V2BarcodeScanner.tsx", ("products",)),
    ("frontend/src/v2/V2BarcodeSearch.tsx", ("products", "open_food_facts")),
    ("frontend/src/v2/V2Off*.tsx", ("products", "open_food_facts")),
    ("frontend/src/v2/off-types.ts", ("open_food_facts",)),
    ("frontend/src/v2/off-browser-preview.ts", ("open_food_facts",)),
    ("frontend/src/v2/v2-products-api.ts", ("products", "open_food_facts")),
    ("frontend/src/v2/v2-product-workspace.css", ("products",)),
    ("frontend/src/v2/V2RecipesPage.tsx", ("recipes",)),
    ("frontend/src/v2/V2RecipeReviewPanel.tsx", ("recipes",)),
    ("frontend/src/v2/v2-recipes-*.ts", ("recipes",)),
    ("frontend/src/v2/v2-recipes.css", ("recipes",)),
    ("frontend/src/recipes/*.ts", ("recipes",)),
    ("frontend/src/v2/V2Basket*.tsx", ("basket",)),
    ("frontend/src/v2/v2-basket-*.ts", ("basket",)),
    ("frontend/src/v2/v2-basket.css", ("basket",)),
    ("frontend/src/v2/V2AuthPage.tsx", ("accounts",)),
    ("frontend/src/v2/v2-auth-*.ts", ("accounts",)),
    ("frontend/src/v2/v2-auth.css", ("accounts",)),
    ("frontend/src/v2/V2Gateway.tsx", ("application", "database", "accounts")),
    ("frontend/src/v2/v2-setup.css", ("database",)),
    ("frontend/src/pwa/data-sync.ts", ("pwa", "products", "recipes", "basket")),
    ("frontend/src/pwa/*", ("pwa",)),
    ("frontend/vite.config.ts", ("pwa",)),
    ("backend/Dockerfile", ("deployment",)),
    ("frontend/Dockerfile.v2", ("deployment",)),
    ("frontend/nginx.v2.conf", ("deployment",)),
    ("deployment/v2/*", ("deployment",)),
    ("backend/app/*.py", ("application",)),
    ("backend/app/api/*.py", ("application",)),
    ("backend/app/api/v2/__init__.py", ("application",)),
    ("backend/app/api/v2/legal.py", ("application",)),
    ("backend/app/services/__init__.py", ("application",)),
    ("backend/app/schemas/__init__.py", ("application",)),
    ("frontend/src/v2/V2App.tsx", ("application",)),
    ("frontend/src/v2/V2HomePage.tsx", ("application",)),
    ("frontend/src/v2/V2LegalPage.tsx", ("application",)),
    ("frontend/src/v2/V2SiteFooter.tsx", ("application",)),
    ("frontend/src/v2/v2-legal.css", ("application",)),
    ("frontend/src/v2/V2ServerUpdateSchedule.tsx", ("deployment",)),
    ("frontend/src/v2/V2TransferPanel.tsx", ("products", "database")),
    ("frontend/src/v2/V2MaintenanceOverlay.tsx", ("deployment",)),
    ("frontend/src/v2/v2-maintenance.css", ("deployment",)),
    ("frontend/src/v2/V2SettingsPage.tsx", ("application", "pwa")),
    ("frontend/src/v2/V2Theme*.tsx", ("application",)),
    ("frontend/src/v2/V2ThemeContext.ts", ("application",)),
    ("frontend/src/v2/v2-dark.css", ("application",)),
    ("frontend/src/v2/v2-settings.css", ("application",)),
    ("frontend/src/v2/V2VersionsPage.tsx", ("application",)),
    ("frontend/src/v2/v2-versions.css", ("application",)),
    ("frontend/src/v2/v2-home.css", ("application",)),
    ("frontend/src/v2/v2-base.css", ("application",)),
    ("frontend/src/main-v2.tsx", ("application",)),
    ("frontend/src/api/*.ts", ("application",)),
    ("frontend/v2.html", ("application",)),
    ("frontend/public-v2/*", ("application",)),
    ("frontend/eslint.config.js", ("application",)),
    ("frontend/tsconfig*.json", ("application",)),
    ("backend/requirements.txt", ("application",)),
    ("backend/pyproject.toml", ("application",)),
    ("frontend/package.json", ("application",)),
    ("frontend/package-lock.json", ("application",)),
)

RUNTIME_PREFIXES = ("backend/app/", "frontend/src/", "deployment/v2/", "frontend/public-v2/")
RUNTIME_FILES = {
    "backend/Dockerfile", "backend/requirements.txt", "backend/pyproject.toml",
    "frontend/Dockerfile.v2",
    "frontend/package.json", "frontend/package-lock.json", "frontend/nginx.v2.conf",
    "frontend/vite.config.ts", "frontend/v2.html", "frontend/eslint.config.js",
}
VERSION_FILES = {
    "frontend/src/v2/component-versions.json",
}


def _git(*args: str) -> list[str]:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True
    )
    return [name.decode() for name in result.stdout.split(b"\0") if name]


def classify(paths: list[str]) -> set[str]:
    affected: set[str] = set()
    unmapped: list[str] = []
    for path in paths:
        if path in VERSION_FILES or path.startswith(("backend/tests/", "scripts/", "docs/", ".github/")):
            continue
        matched: set[str] = set()
        for pattern, components in RULES:
            if PurePosixPath(path).match(pattern):
                matched.update(components)
        if not matched and (path.startswith(RUNTIME_PREFIXES) or path in RUNTIME_FILES or
                            re.fullmatch(r"frontend/tsconfig.*\.json", path)):
            unmapped.append(path)
        affected.update(matched)
    if unmapped:
        raise ValueError("Fichiers applicatifs sans règle de version : " + ", ".join(sorted(unmapped)))
    if affected:
        affected.add("application")
    return affected


def validate() -> dict:
    versions = json.loads(MANIFEST.read_text())
    expected = {
        "application", "products", "recipes", "basket", "database",
        "open_food_facts", "accounts", "pwa", "deployment", "open_prices", "bookmarklet",
    }
    if set(versions) != expected:
        raise ValueError("Composants du manifeste manquants ou inconnus")
    for key, item in versions.items():
        if item["status"] == "planned" and item["version"] is None:
            continue
        if item["status"] != "active" or not re.fullmatch(r"\d+\.\d+\.\d+", item["version"] or ""):
            raise ValueError(f"Version ou statut invalide pour {key}")
    app_version = versions["application"]["version"]
    if json.loads(FRONTEND_PACKAGE.read_text())["version"] != app_version:
        raise ValueError("frontend/package.json ne correspond pas à la version application")
    lock = json.loads(FRONTEND_LOCK.read_text())
    if lock["version"] != app_version or lock["packages"][""]["version"] != app_version:
        raise ValueError("frontend/package-lock.json ne correspond pas à la version application")
    if tomllib.loads(BACKEND_PACKAGE.read_text())["project"]["version"] != app_version:
        raise ValueError("backend/pyproject.toml ne correspond pas à la version application")
    classify(_git("ls-files", "-z"))
    return versions


def bump_patch(version: str) -> str:
    major, minor, patch = map(int, version.split("."))
    return f"{major}.{minor}.{patch + 1}"


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def stale_versions(versions: dict, previous: dict, affected: set[str]) -> list[str]:
    """Reject a changed active component whose version did not advance."""
    return [
        key for key in sorted(affected)
        if key in previous  # A newly registered component has no prior version.
        and versions[key]["status"] == "active"
        and previous[key]["version"] is not None
        and tuple(map(int, versions[key]["version"].split(".")))
        <= tuple(map(int, previous[key]["version"].split(".")))
    ]


def bump(versions: dict, affected: set[str]) -> None:
    for key in affected:
        item = versions[key]
        if item["status"] != "active" or item["version"] is None:
            raise ValueError(f"Composant non actif : {key}")
        item["version"] = bump_patch(item["version"])
    write_json(MANIFEST, versions)
    app_version = versions["application"]["version"]
    package = json.loads(FRONTEND_PACKAGE.read_text())
    package["version"] = app_version
    write_json(FRONTEND_PACKAGE, package)
    lock = json.loads(FRONTEND_LOCK.read_text())
    lock["version"] = app_version
    lock["packages"][""]["version"] = app_version
    write_json(FRONTEND_LOCK, lock)
    backend = BACKEND_PACKAGE.read_text()
    backend, count = re.subn(
        r'(?m)^(version = )"\d+\.\d+\.\d+"$', rf'\g<1>"{app_version}"', backend, count=1
    )
    if count != 1:
        raise ValueError("Version backend introuvable")
    BACKEND_PACKAGE.write_text(backend)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "bump", "preview", "verify"))
    parser.add_argument("--base", help="Git commit preceding the push")
    parser.add_argument("--head", help="Git commit at the end of the push")
    args = parser.parse_args()
    versions = validate()
    if args.action == "check":
        print("Manifeste, métadonnées et règles de couverture valides")
        return
    if not args.base or not args.head:
        parser.error("bump/preview/verify nécessitent --base et --head")
    paths = _git("diff", "--diff-filter=ACMRTUXB", "--name-only", "-z", args.base, args.head)
    affected = classify(paths)
    print("Composants concernés : " + (", ".join(sorted(affected)) if affected else "aucun"))
    if args.action == "verify":
        previous = json.loads(subprocess.run(
            ["git", "show", f"{args.base}:frontend/src/v2/component-versions.json"],
            cwd=ROOT, check=True, capture_output=True, text=True,
        ).stdout)
        stale = stale_versions(versions, previous, affected)
        if stale:
            raise ValueError("Versions non augmentées depuis la révision de base : " + ", ".join(sorted(stale)))
    if args.action == "bump" and affected:
        bump(versions, affected)


if __name__ == "__main__":
    main()
