"""Regression tests for the public component-changelog CI gate."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_component_changelog import validate


class ComponentChangelogTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            "application": {"version": "0.1.54"},
            "products": {"version": "0.1.32"},
            "basket": {"version": "0.1.6"},
        }
        self.current = copy.deepcopy(self.previous)
        self.current["application"]["version"] = "0.1.55"
        self.current["products"]["version"] = "0.1.33"
        self.changelog = {
            "start_versions": {key: item["version"] for key, item in self.previous.items()},
            "baseline": {"products": ["Les prix se suivent magasin par magasin."]},
            "releases": [{"application_version": "0.1.55", "components": {
                "application": {"version": "0.1.55", "notes": ["Des nouveautés à retrouver sur le site."]},
                "products": {"version": "0.1.33", "notes": ["La recherche est plus claire."]},
            }}],
        }

    def test_bumped_components_have_notes_at_their_exact_versions(self):
        validate(self.current, self.changelog, self.previous)
        entry = self.changelog["releases"][0]["components"]
        del entry["products"]
        with self.assertRaisesRegex(ValueError, "Note manquante pour products"):
            validate(self.current, self.changelog, self.previous)
        entry["products"] = {"version": "0.1.32", "notes": ["Ancienne note."]}
        with self.assertRaisesRegex(ValueError, "ancienne version"):
            validate(self.current, self.changelog, self.previous)

    def test_global_version_changes_with_any_component(self):
        self.current["application"]["version"] = "0.1.54"
        self.changelog["releases"] = []
        with self.assertRaisesRegex(ValueError, "version application doit changer"):
            validate(self.current, self.changelog, self.previous)

    def test_bootstrap_does_not_need_historical_version_notes(self):
        validate(self.previous, {"start_versions": self.changelog["start_versions"], "baseline": self.changelog["baseline"], "releases": []}, self.previous)

    def test_pr_against_older_main_does_not_backfill_prejournal_versions(self):
        older_main = copy.deepcopy(self.previous)
        older_main["application"]["version"] = "0.1.44"
        older_main["products"]["version"] = "0.1.28"
        self.current["products"]["version"] = "0.1.32"
        del self.changelog["releases"][0]["components"]["products"]
        validate(self.current, self.changelog, older_main)

    def test_every_post_bootstrap_patch_needs_its_own_note(self):
        self.current["application"]["version"] = "0.1.56"
        self.changelog["releases"][0]["application_version"] = "0.1.56"
        self.changelog["releases"][0]["components"]["application"]["version"] = "0.1.56"
        with self.assertRaisesRegex(ValueError, "application v0.1.55"):
            validate(self.current, self.changelog, self.previous)

    def test_new_note_must_belong_to_a_new_update_group(self):
        prior_journal = copy.deepcopy(self.changelog)
        prior_journal["releases"][0]["components"].pop("products")
        self.previous["application"]["version"] = "0.1.55"
        self.current["application"]["version"] = "0.1.56"
        self.changelog["releases"][0]["components"].pop("products")
        self.changelog["releases"].append({"application_version": "0.1.56", "components": {
            "application": {"version": "0.1.56", "notes": ["Une mise à jour."]},
        }})
        self.changelog["releases"][0]["components"]["products"] = {
            "version": "0.1.33", "notes": ["Une ancienne section modifiée."]}
        with self.assertRaisesRegex(ValueError, "nouvelle mise à jour"):
            validate(self.current, self.changelog, self.previous, prior_journal)
        self.changelog["releases"][1]["components"]["products"] = self.changelog["releases"][0]["components"].pop("products")
        validate(self.current, self.changelog, self.previous, prior_journal)

    def test_short_single_line_public_notes(self):
        entry = self.changelog["releases"][0]["components"]["products"]
        entry["notes"] = ["x" * 161]
        with self.assertRaisesRegex(ValueError, "trop longue"):
            validate(self.current, self.changelog, self.previous)
        entry["notes"] = []
        with self.assertRaisesRegex(ValueError, "notes requises"):
            validate(self.current, self.changelog, self.previous)

    def test_release_group_requires_application_note(self):
        del self.changelog["releases"][0]["components"]["application"]
        with self.assertRaisesRegex(ValueError, "application manquant"):
            validate(self.current, self.changelog, self.previous)


if __name__ == "__main__":
    unittest.main()
