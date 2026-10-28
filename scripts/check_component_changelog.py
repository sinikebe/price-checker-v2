#!/usr/bin/env python3
"""Check public, per-component release notes against the version manifest."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = "frontend/src/v2/component-versions.json"
CHANGELOG_PATH = "frontend/src/v2/component-changelog.json"
OMISSIONS_PATH = "scripts/changelog-omissions.json"
SEMVER = re.compile(r"\d+\.\d+\.\d+\Z")
MAX_NOTE_LENGTH = 160
MAX_NOTES_PER_ENTRY = 3


def version_number(value: str) -> tuple[int, int, int]:
    if not isinstance(value, str) or not SEMVER.fullmatch(value):
        raise ValueError(f"Version de changelog invalide : {value!r}")
    return tuple(map(int, value.split(".")))


def notes(value: object, place: str) -> None:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_NOTES_PER_ENTRY:
        raise ValueError(f"{place} : 1 à {MAX_NOTES_PER_ENTRY} notes requises")
    for note in value:
        if (not isinstance(note, str) or not note.strip() or note != note.strip()
                or "\n" in note or len(note) > MAX_NOTE_LENGTH):
            raise ValueError(f"{place} : note vide, multiligne ou trop longue (max {MAX_NOTE_LENGTH} caractères)")


def validate(manifest: dict, changelog: dict, previous: dict | None = None,
             previous_changelog: dict | None = None, omissions: dict | None = None) -> None:
    """Require a public note or an explicit non-public editorial decision per bump."""
    if not isinstance(changelog, dict) or set(changelog) != {"start_versions", "baseline", "releases"}:
        raise ValueError("Le changelog doit contenir start_versions, baseline et releases")
    components = set(manifest)
    start_versions = changelog["start_versions"]
    if previous_changelog is not None and start_versions != previous_changelog["start_versions"]:
        raise ValueError("Le point de départ du journal ne peut pas être modifié")
    if not isinstance(start_versions, dict) or set(start_versions) != components:
        raise ValueError("Versions de départ incomplètes")
    for component, starting_version in start_versions.items():
        if version_number(starting_version) > version_number(manifest[component]["version"]):
            raise ValueError(f"{component} : version antérieure au point de départ")
    omissions = omissions if omissions is not None else {"omissions": []}
    if not isinstance(omissions, dict) or set(omissions) != {"omissions"} or not isinstance(omissions["omissions"], list):
        raise ValueError("Format des omissions invalide")
    omitted_versions: dict[str, set[str]] = {component: set() for component in components}
    for omission in omissions["omissions"]:
        if not isinstance(omission, dict) or set(omission) != {"component", "version", "reason"}:
            raise ValueError("Omission de changelog invalide")
        component = omission["component"]
        if component not in components:
            raise ValueError(f"Omission pour un composant inconnu : {component}")
        version = omission["version"]
        if not version_number(start_versions[component]) < version_number(version) <= version_number(manifest[component]["version"]):
            raise ValueError(f"{component} : version d’omission hors du journal")
        reason = omission["reason"]
        if (not isinstance(reason, str) or not reason.strip() or reason != reason.strip()
                or "\n" in reason or len(reason) > MAX_NOTE_LENGTH):
            raise ValueError(f"{component} v{version} : justification d’omission invalide")
        if version in omitted_versions[component]:
            raise ValueError(f"{component} v{version} : omission en double")
        omitted_versions[component].add(version)
    baseline = changelog["baseline"]
    if not isinstance(baseline, dict) or set(baseline) != components:
        raise ValueError("Résumé initial absent ou composant inconnu")
    for component, summary in baseline.items():
        notes(summary, f"Résumé initial {component}")
    releases = changelog["releases"]
    if not isinstance(releases, list):
        raise ValueError("releases doit être une liste")
    seen_versions: set[str] = set()
    previous_group_version = (0, 0, 0)
    noted_versions: dict[str, set[str]] = {component: set() for component in components}
    for release in releases:
        if not isinstance(release, dict) or set(release) != {"application_version", "components"}:
            raise ValueError("Groupe de changelog invalide")
        group_version = release["application_version"]
        parsed = version_number(group_version)
        if group_version in seen_versions or parsed <= previous_group_version:
            raise ValueError("Les versions globales doivent être uniques et croissantes")
        if parsed > version_number(manifest["application"]["version"]):
            raise ValueError("Groupe de changelog plus récent que l’application")
        seen_versions.add(group_version)
        previous_group_version = parsed
        if parsed <= version_number(start_versions["application"]):
            raise ValueError("Une mise à jour ne peut pas précéder le début du journal")
        entries = release["components"]
        if not isinstance(entries, dict) or not entries or set(entries) - components:
            raise ValueError(f"{group_version} : composants absents ou inconnus")
        for component, entry in entries.items():
            if not isinstance(entry, dict) or set(entry) != {"version", "notes"}:
                raise ValueError(f"{group_version}/{component} : entrée invalide")
            current_version = manifest[component]["version"]
            if version_number(entry["version"]) > version_number(current_version):
                raise ValueError(f"{group_version}/{component} : version future")
            notes(entry["notes"], f"{group_version}/{component}")
            if version_number(entry["version"]) <= version_number(start_versions[component]):
                raise ValueError(f"{group_version}/{component} : note attribuée à une ancienne version")
            if entry["version"] in omitted_versions[component]:
                raise ValueError(f"{component} v{entry['version']} : note publique et omission contradictoires")
            if entry["version"] in noted_versions[component]:
                raise ValueError(f"{component} v{entry['version']} : note en double")
            noted_versions[component].add(entry["version"])
        if "application" in entries and entries["application"]["version"] != group_version:
            raise ValueError(f"{group_version} : version application incohérente")

    if previous is not None:
        previous_app = previous["application"]["version"]
        current_app = manifest["application"]["version"]
        bumped = {
            component for component in components
            if component in previous and manifest[component]["version"] != previous[component]["version"]
        }
        for component in bumped:
            if version_number(manifest[component]["version"]) <= version_number(previous[component]["version"]):
                raise ValueError(f"{component} : version non augmentée")
        if bumped and current_app == previous_app:
            raise ValueError("La version application doit changer pour chaque mise à jour d’un composant")
        if bumped and previous_changelog is not None:
            old_groups = {group["application_version"] for group in previous_changelog["releases"]}
            for component in sorted(bumped):
                if version_number(manifest[component]["version"]) <= version_number(start_versions[component]):
                    continue  # A PR may span the pre-journal period.
                if manifest[component]["version"] in omitted_versions[component]:
                    continue
                if not any(
                    release["application_version"] not in old_groups
                    and release["components"].get(component, {}).get("version") == manifest[component]["version"]
                    for release in releases
                ):
                    raise ValueError(f"{component} : note à placer dans une nouvelle mise à jour")

    for component in sorted(components):
        starting = version_number(start_versions[component])
        current = version_number(manifest[component]["version"])
        if current == starting:
            continue
        required = ([f"{current[0]}.{current[1]}.{patch}" for patch in range(starting[2] + 1, current[2] + 1)]
                    if starting[:2] == current[:2] else [manifest[component]["version"]])
        for version in required:
            if version not in noted_versions[component] and version not in omitted_versions[component]:
                raise ValueError(f"Note ou omission manquante pour {component} v{version}")



def git_json(ref: str, path: str, *, missing_ok: bool = False) -> dict | None:
    result = subprocess.run(
        ["git", "show", f"{ref}:{path}"], cwd=ROOT,
        check=False, capture_output=True, text=True,
    )
    if result.returncode:
        if missing_ok:
            return None
        raise ValueError(f"Impossible de lire {path} à {ref}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="Révision de base pour vérifier les versions incrémentées")
    args = parser.parse_args()
    manifest = json.loads((ROOT / MANIFEST_PATH).read_text())
    changelog = json.loads((ROOT / CHANGELOG_PATH).read_text())
    omissions = json.loads((ROOT / OMISSIONS_PATH).read_text())
    previous = git_json(args.base, MANIFEST_PATH) if args.base else None
    previous_changelog = git_json(args.base, CHANGELOG_PATH, missing_ok=True) if args.base else None
    validate(manifest, changelog, previous, previous_changelog, omissions)
    print("Journal public valide ; chaque version a une note ou une omission explicite")


if __name__ == "__main__":
    main()
