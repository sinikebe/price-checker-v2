import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from component_versions import bump_patch, classify, validate


class ComponentVersionsTests(unittest.TestCase):
    def test_domain_files_bump_only_their_components_and_application(self):
        self.assertEqual(
            classify(["backend/app/api/v2/recipes.py", "frontend/src/v2/V2RecipesPage.tsx"]),
            {"recipes", "application"},
        )
        self.assertEqual(
            classify(["backend/app/services/openfoodfacts_client.py"]),
            {"open_food_facts", "application"},
        )
        self.assertEqual(
            classify(["backend/app/api/v2/setup.py"]),
            {"database", "application"},
        )

    def test_product_files_shared_with_off_bump_both(self):
        self.assertEqual(
            classify(["backend/app/api/v2/products.py"]),
            {"application", "products", "open_food_facts"},
        )

    def test_shared_sync_changes_bump_each_affected_component_once(self):
        self.assertEqual(
            classify(["frontend/src/pwa/data-sync.ts", "backend/app/api/v2/basket.py"]),
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
            "README.md", "backend/tests/test_v2_off.py",
            ".github/workflows/ci.yml", "scripts/component_versions.py",
            "frontend/src/v2/component-versions.json",
        ]), set())

    def test_unmapped_runtime_file_fails_instead_of_silently_skipping(self):
        with self.assertRaisesRegex(ValueError, "future_connector.py"):
            classify(["backend/app/services/future_connector.py"])

    def test_planned_open_prices_has_no_automatic_bump(self):
        self.assertNotIn("open_prices", classify(["backend/app/services/off_rate_limit.py"]))
        self.assertEqual(bump_patch("0.1.9"), "0.1.10")

    def test_manifest_and_existing_source_paths_are_consistent(self):
        versions = validate()
        self.assertIsNone(versions["open_prices"]["version"])
        self.assertEqual(versions["open_prices"]["status"], "planned")


if __name__ == "__main__":
    unittest.main()
