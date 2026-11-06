import sys
import tomllib
import unittest
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from component_versions import ROOT, RULES, _git, bump_patch, classify, stale_versions, validate


class ComponentVersionsTests(unittest.TestCase):
    def test_domain_files_bump_only_their_components_and_application(self):
        self.assertEqual(
            classify(["backend/app/api/v2/recipes.py", "frontend/src/v2/V2RecipesPage.tsx"]),
            {"recipes", "application"},
        )
        self.assertEqual(
            classify(["frontend/src/v2/v2-off-browser.ts"]),
            {"open_food_facts", "application"},
        )
        self.assertEqual(
            classify(["backend/app/api/v2/setup.py"]),
            {"database", "application"},
        )

    def test_bookmarklet_files_require_their_own_version(self):
        self.assertEqual(classify([
            "frontend/src/v2/bookmarklet-capture.js",
            "frontend/src/v2/V2CapturePage.tsx",
            "frontend/src/v2/v2-capture.css",
        ]), {"application", "products", "bookmarklet"})
        previous = {"bookmarklet": {"status": "active", "version": "0.1.0"}}
        current = {"bookmarklet": {"status": "active", "version": "0.1.0"}}
        self.assertEqual(stale_versions(current, previous, {"bookmarklet"}), ["bookmarklet"])
        current["bookmarklet"]["version"] = "0.1.1"
        self.assertEqual(stale_versions(current, previous, {"bookmarklet"}), [])
        self.assertEqual(stale_versions(current, {}, {"bookmarklet"}), [])

    def test_price_history_files_bump_products_and_open_prices(self):
        self.assertEqual(classify([
            "backend/app/api/v2/prices.py", "frontend/src/v2/V2PriceHistory.tsx",
        ]), {"application", "products", "open_prices"})

    def test_product_files_shared_with_off_bump_both(self):
        self.assertEqual(
            classify(["backend/app/api/v2/products.py"]),
            {"application", "products", "open_food_facts"},
        )

    def test_shared_sync_changes_bump_each_affected_component_once(self):
        self.assertEqual(
            classify(["frontend/src/pwa/data-sync.ts", "frontend/src/v2/V2BasketContext.tsx"]),
            {"application", "pwa", "products", "recipes", "basket"},
        )

    def test_preferences_and_updater_paths_are_classified(self):
        self.assertEqual(classify([
            "frontend/src/v2/V2SettingsPage.tsx", "frontend/src/v2/v2-dark.css",
            "frontend/src/pwa/PwaUpdateContext.tsx",
        ]), {"application", "pwa"})

    def test_maintenance_and_schedule_bump_deployment(self):
        self.assertEqual(classify([
            "backend/app/api/v2/updates.py",
            "frontend/src/v2/V2ServerUpdateSchedule.tsx",
            "deployment/v2/scheduled_update.py",
        ]), {"application", "deployment"})

    def test_docs_tests_ci_and_generated_versions_do_not_bump(self):
        self.assertEqual(classify([
            "README.md", "backend/tests/test_v2_off_in_browser.py",
            ".github/workflows/ci.yml", "scripts/component_versions.py",
            "frontend/src/v2/component-versions.json",
            "frontend/src/v2/component-changelog.json",
        ]), set())

    def test_unmapped_runtime_file_fails_instead_of_silently_skipping(self):
        with self.assertRaisesRegex(ValueError, "future_connector.py"):
            classify(["backend/app/services/future_connector.py"])

    def test_open_prices_connector_is_classified(self):
        self.assertEqual(
            classify(["backend/app/services/v2_open_prices_sync.py"]),
            {"application", "open_prices"},
        )
        self.assertEqual(bump_patch("0.1.9"), "0.1.10")

    def test_changelog_view_paths_bump_application(self):
        self.assertEqual(classify([
            "frontend/src/v2/V2ChangelogPage.tsx",
            "frontend/src/v2/v2-changelog.css",
        ]), {"application"})

    def test_extension_and_image_context_files_are_versioned(self):
        # The settings page hands the extension out from the web bundle.
        self.assertEqual(classify(["frontend/browser-extension/carrefour-parse.js"]), {"application"})
        self.assertEqual(classify(["backend/.dockerignore"]), {"deployment", "application"})
        with self.assertRaisesRegex(ValueError, "future.js"):
            classify(["frontend/browser-extension/adapters/future.js"])  # no rule reaches a subfolder yet

    def test_every_rule_matches_a_tracked_file(self):
        # A rule left behind by a deleted file would silently cover the next file of that name.
        files = [PurePosixPath(path) for path in _git("ls-files", "-z")]
        dead = [pattern for pattern, _ in RULES if not any(path.match(pattern) for path in files)]
        self.assertEqual(dead, [])

    def test_backend_requirements_and_package_metadata_pin_the_same_dependencies(self):
        # The image installs requirements.txt, then the package with --no-deps:
        # its own dependency list is never resolved, so the two lists must agree.
        declared = tomllib.loads((ROOT / "backend/pyproject.toml").read_text())["project"]["dependencies"]
        pinned = [
            line.strip() for line in (ROOT / "backend/requirements.txt").read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(declared, pinned)

    def test_manifest_and_existing_source_paths_are_consistent(self):
        versions = validate()
        self.assertRegex(versions["open_prices"]["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(versions["open_prices"]["status"], "active")
        self.assertRegex(versions["bookmarklet"]["version"], r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
