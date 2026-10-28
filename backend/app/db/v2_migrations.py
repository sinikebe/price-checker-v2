"""Versioned schema migrations for the V2 PostgreSQL database."""

from __future__ import annotations

import asyncio
import ssl

import asyncpg

MIGRATIONS = {
    "0001_accounts": """
        CREATE TABLE v2_users (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            username varchar(32) NOT NULL,
            username_key varchar(32) NOT NULL UNIQUE,
            password_hash text NOT NULL,
            role varchar(16) NOT NULL
                CHECK (role IN ('admin', 'confirmed', 'visitor')),
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE v2_installation (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            admin_user_id bigint UNIQUE REFERENCES v2_users(id),
            created_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO v2_installation (singleton) VALUES (true);
        CREATE TABLE v2_sessions (
            token_hash char(64) PRIMARY KEY,
            user_id bigint NOT NULL REFERENCES v2_users(id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL
        );
        CREATE INDEX v2_sessions_expires_at_idx ON v2_sessions (expires_at);
        CREATE TABLE v2_auth_limits (
            key char(64) PRIMARY KEY,
            attempts integer NOT NULL,
            window_started_at timestamptz NOT NULL DEFAULT now()
        );
    """,
    "0002_products": """
        CREATE TABLE v2_products (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            data jsonb NOT NULL,
            revision integer NOT NULL DEFAULT 1,
            predecessor_id bigint REFERENCES v2_products(id),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE v2_product_drafts (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            product_id bigint REFERENCES v2_products(id),
            author_id bigint NOT NULL REFERENCES v2_users(id),
            data jsonb NOT NULL,
            base_revision integer,
            revision integer NOT NULL DEFAULT 1,
            status varchar(16) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'approved')),
            change_kind varchar(16) NOT NULL DEFAULT 'correction'
                CHECK (change_kind IN ('correction', 'new_version')),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            approved_at timestamptz,
            approved_by bigint REFERENCES v2_users(id),
            result_product_id bigint REFERENCES v2_products(id),
            CONSTRAINT v2_draft_base CHECK (
                (product_id IS NULL AND base_revision IS NULL) OR
                (product_id IS NOT NULL AND base_revision IS NOT NULL)
            )
        );
        CREATE INDEX v2_product_drafts_author_idx
            ON v2_product_drafts (author_id, status, updated_at DESC);
        CREATE INDEX v2_product_drafts_status_idx
            ON v2_product_drafts (status, updated_at DESC);
        CREATE UNIQUE INDEX v2_one_open_draft_per_author_product
            ON v2_product_drafts(author_id, product_id)
            WHERE status='draft' AND product_id IS NOT NULL;
        CREATE TABLE v2_product_events (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            product_id bigint NOT NULL REFERENCES v2_products(id),
            draft_id bigint NOT NULL REFERENCES v2_product_drafts(id),
            actor_id bigint NOT NULL REFERENCES v2_users(id),
            event_type varchar(24) NOT NULL,
            before_data jsonb,
            after_data jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX v2_product_events_product_idx
            ON v2_product_events(product_id, created_at DESC);
    """,
    "0003_off_snapshots": """
        CREATE TABLE v2_product_off_snapshots (
            product_id bigint PRIMARY KEY REFERENCES v2_products(id) ON DELETE CASCADE,
            barcode varchar(14) NOT NULL,
            payload jsonb NOT NULL,
            fetched_at timestamptz NOT NULL DEFAULT now(),
            off_rev integer,
            off_last_modified_t bigint
        );
    """,
    "0004_recipes": """
        CREATE TABLE v2_recipes (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            author_id bigint NOT NULL REFERENCES v2_users(id),
            title varchar(200) NOT NULL CHECK (btrim(title) <> ''),
            description text NOT NULL DEFAULT '',
            base_servings numeric(12,3) NOT NULL CHECK (base_servings > 0),
            prep_minutes integer CHECK (prep_minutes >= 0),
            cook_minutes integer CHECK (cook_minutes >= 0),
            steps jsonb NOT NULL,
            revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX v2_recipes_title_idx ON v2_recipes (lower(title));
        CREATE TABLE v2_recipe_ingredients (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            recipe_id bigint NOT NULL REFERENCES v2_recipes(id) ON DELETE CASCADE,
            position integer NOT NULL CHECK (position >= 0),
            label varchar(200) NOT NULL CHECK (btrim(label) <> ''),
            amount numeric(12,3) CHECK (amount > 0),
            unit varchar(10),
            note varchar(1000) NOT NULL DEFAULT '',
            optional boolean NOT NULL DEFAULT false,
            product_id bigint REFERENCES v2_products(id),
            group_name varchar(100),
            CONSTRAINT v2_recipe_ingredient_target CHECK (
                (product_id IS NOT NULL) <> (group_name IS NOT NULL)
                AND (group_name IS NULL OR btrim(group_name) <> '')
            ),
            CONSTRAINT v2_recipe_ingredient_quantity CHECK (
                (amount IS NULL AND unit IS NULL) OR
                (amount IS NOT NULL AND unit IN ('g', 'kg', 'ml', 'cl', 'l', 'piece'))
            )
        );
        CREATE UNIQUE INDEX v2_recipe_ingredient_position_idx
            ON v2_recipe_ingredients (recipe_id, position);
        CREATE INDEX v2_recipe_ingredient_product_idx
            ON v2_recipe_ingredients (product_id) WHERE product_id IS NOT NULL;
    """,
    "0005_pwa_versions": """
        CREATE TABLE v2_pwa_versions (
            collection varchar(16) PRIMARY KEY,
            revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
        );
        INSERT INTO v2_pwa_versions(collection) VALUES ('products'), ('recipes');
        CREATE FUNCTION v2_bump_pwa_version() RETURNS trigger AS $$
        BEGIN
            UPDATE v2_pwa_versions SET revision=revision+1
            WHERE collection=CASE TG_TABLE_NAME
                WHEN 'v2_products' THEN 'products' ELSE 'recipes' END;
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER v2_products_pwa_version
            AFTER INSERT OR UPDATE OR DELETE ON v2_products
            FOR EACH STATEMENT EXECUTE FUNCTION v2_bump_pwa_version();
        CREATE TRIGGER v2_recipes_pwa_version
            AFTER INSERT OR UPDATE OR DELETE ON v2_recipes
            FOR EACH STATEMENT EXECUTE FUNCTION v2_bump_pwa_version();
    """,

    "0007_price_history": """
        -- Retailer identity and physical/online store identity are distinct.
        CREATE TABLE v2_retailers (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code varchar(50) NOT NULL UNIQUE,
            name varchar(200) NOT NULL,
            active boolean NOT NULL DEFAULT true,
            external_brand_aliases jsonb,
            import_key varchar(128) UNIQUE,
            CHECK (external_brand_aliases IS NULL OR
                   jsonb_typeof(external_brand_aliases) = 'array')
        );
        CREATE TABLE v2_stores (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            retailer_id bigint NOT NULL REFERENCES v2_retailers(id),
            external_store_id varchar(100),
            name varchar(300) NOT NULL,
            postal_code varchar(20),
            city varchar(200),
            latitude numeric,
            longitude numeric,
            supports_drive boolean NOT NULL DEFAULT false,
            supports_delivery boolean NOT NULL DEFAULT false,
            osm_type varchar(20),
            osm_id bigint,
            import_key varchar(128) UNIQUE,
            UNIQUE (retailer_id, id)
        );
        CREATE INDEX v2_stores_retailer_idx ON v2_stores(retailer_id);
        CREATE UNIQUE INDEX v2_stores_osm_idx
            ON v2_stores(osm_type, osm_id) WHERE osm_id IS NOT NULL;

        -- Personal price entries are private until an admin approves them.
        -- A capture draft stores the proposed reading, not a public offer.
        CREATE TABLE v2_price_drafts (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            author_id bigint NOT NULL REFERENCES v2_users(id),
            product_id bigint NOT NULL REFERENCES v2_products(id),
            retailer_id bigint NOT NULL REFERENCES v2_retailers(id),
            store_id bigint NOT NULL,
            entry_kind varchar(16) NOT NULL
                CHECK (entry_kind IN ('manual', 'capture')),
            captured_via varchar(16)
                CHECK (captured_via IN ('bookmarklet', 'paste')),
            source_url varchar(1000),
            price numeric(10,2) NOT NULL CHECK (price >= 0),
            quantity_text varchar(100),
            observed_at timestamptz NOT NULL,
            note varchar(1000),
            revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
            status varchar(16) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'approved', 'rejected')),
            reviewed_by bigint REFERENCES v2_users(id),
            reviewed_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            import_key varchar(128) UNIQUE,
            FOREIGN KEY (retailer_id, store_id)
                REFERENCES v2_stores(retailer_id, id),
            CHECK ((entry_kind = 'capture') = (captured_via IS NOT NULL)),
            CHECK ((status = 'draft' AND reviewed_by IS NULL
                    AND reviewed_at IS NULL) OR
                   (status IN ('approved', 'rejected')
                    AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
        );
        CREATE INDEX v2_price_drafts_author_idx
            ON v2_price_drafts(author_id, status, updated_at DESC);
        CREATE INDEX v2_price_drafts_review_idx
            ON v2_price_drafts(status, updated_at DESC);

        -- Each capture/connector fetch is retained, even when the price did
        -- not change. An offer is raw provenance, not the effective price.
        CREATE TABLE v2_offers (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            retailer_id bigint NOT NULL REFERENCES v2_retailers(id),
            store_id bigint NOT NULL,
            source_kind varchar(16) NOT NULL
                CHECK (source_kind IN ('connector', 'capture')),
            captured_via varchar(16)
                CHECK (captured_via IN ('bookmarklet', 'paste')),
            source_provider varchar(50),
            price_draft_id bigint REFERENCES v2_price_drafts(id),
            channel varchar(50) NOT NULL,
            external_product_id varchar(200),
            title varchar(500) NOT NULL,
            normalized_title varchar(500),
            brand varchar(200),
            quantity_text varchar(100),
            ean varchar(50),
            price_amount numeric(10,2) NOT NULL,
            unit_price_amount numeric(10,2),
            unit_price_unit varchar(20),
            promo_text varchar(500),
            available boolean NOT NULL DEFAULT true,
            image_url varchar(1000),
            product_url varchar(1000),
            collected_at timestamptz NOT NULL,
            raw_payload jsonb,
            import_key varchar(128) UNIQUE,
            UNIQUE (id, retailer_id, store_id),
            FOREIGN KEY (retailer_id, store_id)
                REFERENCES v2_stores(retailer_id, id),
            CHECK ((source_kind = 'capture') = (captured_via IS NOT NULL))
        );
        CREATE INDEX v2_offers_store_collected_idx
            ON v2_offers(store_id, collected_at DESC);
        CREATE TABLE v2_offer_product_links (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            offer_id bigint NOT NULL REFERENCES v2_offers(id),
            product_id bigint NOT NULL REFERENCES v2_products(id),
            link_type varchar(20) NOT NULL,
            confidence numeric(5,2),
            verified boolean NOT NULL DEFAULT false,
            note varchar(1000),
            created_at timestamptz NOT NULL DEFAULT now(),
            import_key varchar(128) UNIQUE,
            UNIQUE (offer_id, product_id)
        );
        CREATE INDEX v2_offer_product_links_product_idx
            ON v2_offer_product_links(product_id);

        -- One row per actual price change; corrections are manual observations
        -- with disputed value and resolution, not edits to historical prices.
        CREATE TABLE v2_price_observations (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            product_id bigint REFERENCES v2_products(id),
            retailer_id bigint NOT NULL REFERENCES v2_retailers(id),
            store_id bigint NOT NULL,
            offer_id bigint REFERENCES v2_offers(id),
            source varchar(20) NOT NULL
                CHECK (source IN ('manual', 'connector', 'third_party')),
            source_provider varchar(50),
            source_record_id varchar(128),
            contributor_id bigint REFERENCES v2_users(id),
            price_draft_id bigint REFERENCES v2_price_drafts(id),
            approved_by bigint REFERENCES v2_users(id),
            approved_at timestamptz,
            price numeric(10,2) NOT NULL CHECK (price >= 0),
            quantity_text varchar(100),
            unit_price_amount numeric(10,2),
            unit_price_unit varchar(20),
            available boolean NOT NULL DEFAULT true,
            observed_at timestamptz NOT NULL,
            note varchar(1000),
            created_at timestamptz NOT NULL DEFAULT now(),
            corrected_price numeric(10,2),
            correction_status varchar(20)
                CHECK (correction_status IN ('active', 'resolved')),
            resolved_by_observation_id bigint
                REFERENCES v2_price_observations(id),
            superseded boolean NOT NULL DEFAULT false,
            superseded_by_correction_id bigint
                REFERENCES v2_price_observations(id),
            import_key varchar(128) UNIQUE,
            FOREIGN KEY (retailer_id, store_id)
                REFERENCES v2_stores(retailer_id, id),
            FOREIGN KEY (offer_id, retailer_id, store_id)
                REFERENCES v2_offers(id, retailer_id, store_id),
            CHECK ((source = 'connector' AND offer_id IS NOT NULL) OR
                   (source IN ('manual', 'third_party') AND offer_id IS NULL)),
            CHECK (source <> 'third_party' OR
                   (source_provider IS NOT NULL AND btrim(source_provider) <> '')),
            CHECK (source = 'manual' OR
                   (corrected_price IS NULL AND correction_status IS NULL
                    AND resolved_by_observation_id IS NULL)),
            CHECK ((corrected_price IS NULL) = (correction_status IS NULL)),
            CHECK ((correction_status = 'resolved') =
                   (resolved_by_observation_id IS NOT NULL)
                   OR correction_status IS NULL),
            CHECK (NOT superseded OR source <> 'manual'),
            CHECK (superseded = (superseded_by_correction_id IS NOT NULL)),
            CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
            CHECK (price_draft_id IS NULL OR
                   (contributor_id IS NOT NULL AND approved_by IS NOT NULL))
        );
        CREATE INDEX v2_price_observations_product_store_idx
            ON v2_price_observations(product_id, store_id, observed_at DESC, id DESC);
        CREATE INDEX v2_price_observations_store_idx
            ON v2_price_observations(store_id, observed_at DESC);
        CREATE UNIQUE INDEX v2_price_observations_draft_idx
            ON v2_price_observations(price_draft_id)
            WHERE price_draft_id IS NOT NULL;
        CREATE UNIQUE INDEX v2_price_observations_connector_offer_idx
            ON v2_price_observations(offer_id) WHERE source = 'connector';
        CREATE UNIQUE INDEX v2_price_observations_manual_idx
            ON v2_price_observations(product_id, store_id, observed_at, price,
                coalesce(quantity_text, '')) WHERE source = 'manual';
    """,
    "0008_auth_limit_cleanup": """
        DELETE FROM v2_auth_limits
        WHERE window_started_at < now() - interval '1 hour';
        CREATE INDEX v2_auth_limits_window_idx
            ON v2_auth_limits(window_started_at);
    """,
    "0009_price_channels": """
        -- A physical store and its drive/delivery services are separate
        -- contexts for price comparison, even if they share store identity.
        ALTER TABLE v2_price_drafts ADD COLUMN sales_channel varchar(16)
            NOT NULL DEFAULT 'in_store'
            CHECK (sales_channel IN ('in_store', 'drive', 'delivery'));
        ALTER TABLE v2_price_observations ADD COLUMN sales_channel varchar(16)
            NOT NULL DEFAULT 'in_store'
            CHECK (sales_channel IN ('in_store', 'drive', 'delivery'));
        DROP INDEX v2_price_observations_manual_idx;
        CREATE UNIQUE INDEX v2_price_observations_manual_idx
            ON v2_price_observations(product_id, store_id, sales_channel,
                observed_at, price, coalesce(quantity_text, ''))
            WHERE source = 'manual';
        CREATE INDEX v2_price_observations_product_date_idx
            ON v2_price_observations(product_id, observed_at DESC, id DESC)
            WHERE NOT superseded;
    """,
    "0010_shared_off_quota": """
        -- A single admission ledger is shared by every backend process using
        -- this instance database. The advisory lock makes count + insert atomic.
        CREATE TABLE v2_off_rate_events (
            bucket varchar(16) NOT NULL CHECK (bucket IN ('product', 'search')),
            admitted_at timestamptz NOT NULL
        );
        CREATE INDEX v2_off_rate_events_window_idx
            ON v2_off_rate_events(bucket, admitted_at);
    """,
    "0011_instance_transfer": """
        -- Identity is stable for repeated point-in-time exports from an instance.
        CREATE TABLE v2_transfer_instance (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            instance_id uuid NOT NULL DEFAULT gen_random_uuid()
        );
        INSERT INTO v2_transfer_instance(singleton) VALUES(true);
        CREATE TABLE v2_transfer_product_map (
            source_instance uuid NOT NULL,
            source_id bigint NOT NULL CHECK(source_id > 0),
            target_id bigint NOT NULL REFERENCES v2_products(id),
            fingerprint char(64) NOT NULL,
            PRIMARY KEY(source_instance, source_id)
        );
    """,
    "0012_off_refresh_queue": """
        CREATE TABLE v2_off_refresh_queue (
            product_id bigint PRIMARY KEY REFERENCES v2_products(id) ON DELETE CASCADE,
            requested_at timestamptz NOT NULL DEFAULT now(),
            next_attempt_at timestamptz NOT NULL DEFAULT now(),
            attempts integer NOT NULL DEFAULT 0,
            last_error varchar(50)
        );
        CREATE INDEX v2_off_refresh_queue_due_idx
            ON v2_off_refresh_queue(next_attempt_at, requested_at);
    """,
    "0013_content_moderation": """
        CREATE TABLE v2_content_reports (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            kind varchar(16) NOT NULL CHECK (kind IN ('product', 'recipe')),
            content_id bigint NOT NULL CHECK (content_id > 0),
            reporter_id bigint NOT NULL REFERENCES v2_users(id),
            reason varchar(1000) NOT NULL CHECK (btrim(reason) <> ''),
            status varchar(16) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'dismissed', 'withdrawn')),
            created_at timestamptz NOT NULL DEFAULT now(),
            reviewed_at timestamptz,
            reviewed_by bigint REFERENCES v2_users(id)
        );
        CREATE UNIQUE INDEX v2_one_open_report_per_user_content
            ON v2_content_reports(kind, content_id, reporter_id)
            WHERE status='open';
        CREATE INDEX v2_content_reports_queue
            ON v2_content_reports(status, created_at, id);
        CREATE TABLE v2_content_withdrawals (
            kind varchar(16) NOT NULL CHECK (kind IN ('product', 'recipe')),
            content_id bigint NOT NULL CHECK (content_id > 0),
            reason varchar(1000) NOT NULL,
            withdrawn_at timestamptz NOT NULL DEFAULT now(),
            withdrawn_by bigint NOT NULL REFERENCES v2_users(id),
            PRIMARY KEY(kind, content_id)
        );
        ALTER TABLE v2_product_drafts
            DROP CONSTRAINT v2_product_drafts_status_check;
        ALTER TABLE v2_product_drafts
            ADD CONSTRAINT v2_product_drafts_status_check
            CHECK (status IN ('draft', 'approved', 'rejected'));
        ALTER TABLE v2_product_drafts
            ADD COLUMN rejected_at timestamptz,
            ADD COLUMN rejected_by bigint REFERENCES v2_users(id);
    """,
    "0014_account_erasure": """
        -- Published contributions outlive the account, but no stable author
        -- identifier may remain on them after the account is deleted.
        ALTER TABLE v2_recipes ALTER COLUMN author_id DROP NOT NULL;
        ALTER TABLE v2_product_events ALTER COLUMN actor_id DROP NOT NULL;
        ALTER TABLE v2_product_events ALTER COLUMN draft_id DROP NOT NULL;
    """,
    "0015_price_days": """
        -- The current dev schema stores readings as timestamptz. Normalize
        -- them to noon in Europe/Paris so the actual time of day is discarded.
        UPDATE v2_price_drafts SET observed_at =
            ((observed_at AT TIME ZONE 'Europe/Paris')::date + time '12:00')
            AT TIME ZONE 'Europe/Paris';
        UPDATE v2_price_observations SET observed_at =
            ((observed_at AT TIME ZONE 'Europe/Paris')::date + time '12:00')
            AT TIME ZONE 'Europe/Paris';
    """,
    "0016_recipe_review": """
        -- Existing recipes are already published. New creations and edits
        -- enter this private review queue before touching public rows.
        CREATE TABLE v2_recipe_submissions (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            author_id bigint NOT NULL REFERENCES v2_users(id) ON DELETE CASCADE,
            recipe_id bigint REFERENCES v2_recipes(id) ON DELETE CASCADE,
            payload jsonb NOT NULL,
            revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
            base_revision integer CHECK (base_revision > 0),
            status varchar(16) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
            created_at timestamptz NOT NULL DEFAULT now(),
            reviewed_at timestamptz,
            reviewer_id bigint REFERENCES v2_users(id) ON DELETE SET NULL,
            result_recipe_id bigint REFERENCES v2_recipes(id) ON DELETE SET NULL,
            CONSTRAINT v2_recipe_submission_target CHECK
                ((recipe_id IS NULL) = (base_revision IS NULL))
        );
        CREATE INDEX v2_recipe_review_queue
            ON v2_recipe_submissions(status, created_at, id);
        CREATE INDEX v2_recipe_submission_author
            ON v2_recipe_submissions(author_id, created_at DESC);
        CREATE UNIQUE INDEX v2_one_pending_recipe_edit
            ON v2_recipe_submissions(author_id, recipe_id)
            WHERE status='pending' AND recipe_id IS NOT NULL;
    """,
    "0017_local_basket_only": """
        -- Refuse to discard unexpected rows while removing obsolete storage.
        DO $$
        BEGIN
            IF to_regclass('v2_user_baskets') IS NOT NULL THEN
                IF EXISTS (SELECT 1 FROM v2_user_baskets) THEN
                    RAISE EXCEPTION 'Obsolete basket table is not empty';
                END IF;
                DROP TABLE v2_user_baskets;
            END IF;
        END
        $$;
    """,
    "0018_open_prices_sync": """
        -- Shared scheduler state prevents bursts across backend workers/restarts.
        CREATE TABLE v2_open_prices_sync_control (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            next_run_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO v2_open_prices_sync_control(singleton) VALUES(true);
        CREATE TABLE v2_open_prices_sync_state (
            product_id bigint PRIMARY KEY REFERENCES v2_products(id) ON DELETE CASCADE,
            checked_at timestamptz NOT NULL,
            imported_count integer NOT NULL DEFAULT 0
        );
        CREATE INDEX v2_open_prices_sync_checked_idx
            ON v2_open_prices_sync_state(checked_at);
    """,
    "0019_capture_draft_prices": """
        -- A captured price can wait privately for its product draft to be
        -- approved. Once published, the price is relinked to that product and
        -- still needs its own moderation decision.
        ALTER TABLE v2_price_drafts ALTER COLUMN product_id DROP NOT NULL;
        ALTER TABLE v2_price_drafts ADD COLUMN product_draft_id bigint
            REFERENCES v2_product_drafts(id) ON DELETE CASCADE;
        ALTER TABLE v2_price_drafts ADD COLUMN capture_ean varchar(14)
            CHECK (capture_ean ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$');
        ALTER TABLE v2_price_drafts ADD CONSTRAINT v2_price_draft_target
            CHECK ((product_id IS NOT NULL) <> (product_draft_id IS NOT NULL));
        CREATE INDEX v2_price_drafts_product_draft_idx
            ON v2_price_drafts(product_draft_id)
            WHERE product_draft_id IS NOT NULL;
    """,
    "0020_store_aliases": """
        ALTER TABLE v2_price_drafts ADD COLUMN captured_store_name varchar(300);
        -- An alternative name is not a store edit until separately approved.
        -- Source identifies the naming system, not a price source or location.
        CREATE TABLE v2_store_aliases (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            store_id bigint NOT NULL REFERENCES v2_stores(id) ON DELETE CASCADE,
            source varchar(24) NOT NULL CHECK
                (source IN ('retailer','open_food_facts','open_prices')),
            name varchar(300) NOT NULL,
            name_key varchar(300) NOT NULL,
            approved_by bigint REFERENCES v2_users(id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (store_id, source, name_key)
        );
        CREATE INDEX v2_store_aliases_lookup_idx
            ON v2_store_aliases(source, name_key);
        CREATE TABLE v2_store_alias_proposals (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            store_id bigint NOT NULL REFERENCES v2_stores(id) ON DELETE CASCADE,
            author_id bigint NOT NULL REFERENCES v2_users(id),
            source varchar(24) NOT NULL CHECK
                (source IN ('retailer','open_food_facts','open_prices')),
            name varchar(300) NOT NULL,
            name_key varchar(300) NOT NULL,
            status varchar(16) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
            reviewed_by bigint REFERENCES v2_users(id) ON DELETE SET NULL,
            reviewed_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
                OR (status<>'pending' AND reviewed_at IS NOT NULL))
        );
        CREATE UNIQUE INDEX v2_store_alias_proposals_pending_idx
            ON v2_store_alias_proposals(store_id, source, name_key)
            WHERE status='pending';
        CREATE INDEX v2_store_alias_proposals_review_idx
            ON v2_store_alias_proposals(status, created_at, id);
    """,
    "0021_bookmarklet_price_source": """
        -- Older approved captures were labelled manual. Keep their provenance
        -- on the public observation even after private draft retention expires.
        ALTER TABLE v2_price_observations
            ADD COLUMN source_url varchar(1000),
            ADD COLUMN capture_ean varchar(14)
                CHECK (capture_ean IS NULL OR capture_ean ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$');
        ALTER TABLE v2_price_observations
            DROP CONSTRAINT v2_price_observations_source_check;
        ALTER TABLE v2_price_observations
            ADD CONSTRAINT v2_price_observations_source_check
            CHECK (source IN ('manual','bookmarklet','connector','third_party'));
        ALTER TABLE v2_price_observations
            DROP CONSTRAINT v2_price_observations_check;
        ALTER TABLE v2_price_observations
            ADD CONSTRAINT v2_price_observations_check
            CHECK ((source='connector' AND offer_id IS NOT NULL)
                OR (source IN ('manual','bookmarklet','third_party')
                    AND offer_id IS NULL));
        ALTER TABLE v2_price_observations
            DROP CONSTRAINT v2_price_observations_check2;
        ALTER TABLE v2_price_observations
            ADD CONSTRAINT v2_price_observations_check2
            CHECK (source IN ('manual','bookmarklet') OR
                (corrected_price IS NULL AND correction_status IS NULL
                    AND resolved_by_observation_id IS NULL));
        UPDATE v2_price_observations o
        SET source='bookmarklet',source_url=d.source_url,capture_ean=d.capture_ean
        FROM v2_price_drafts d
        WHERE o.price_draft_id=d.id AND d.captured_via='bookmarklet'
            AND o.source='manual';
    """,

    "0022_duplicate_merges": """
        ALTER TABLE v2_content_reports ADD COLUMN report_type varchar(16) NOT NULL
            DEFAULT 'general' CHECK (report_type IN ('general','duplicate'));
        ALTER TABLE v2_content_reports ADD COLUMN duplicate_url varchar(1000);
        ALTER TABLE v2_content_reports ADD COLUMN duplicate_id bigint;
        ALTER TABLE v2_content_reports DROP CONSTRAINT v2_content_reports_kind_check;
        ALTER TABLE v2_content_reports ADD CONSTRAINT v2_content_reports_kind_check
            CHECK (kind IN ('product','recipe','store'));
        ALTER TABLE v2_content_reports DROP CONSTRAINT v2_content_reports_status_check;
        ALTER TABLE v2_content_reports ADD CONSTRAINT v2_content_reports_status_check
            CHECK (status IN ('open','dismissed','withdrawn','merged'));
        DROP INDEX v2_one_open_report_per_user_content;
        CREATE UNIQUE INDEX v2_one_open_report_per_user_content
            ON v2_content_reports(kind,content_id,reporter_id,report_type)
            WHERE status='open';
        CREATE TABLE v2_content_merges (
            kind varchar(16) NOT NULL CHECK(kind IN ('product','store')),
            from_id bigint NOT NULL CHECK(from_id > 0),
            to_id bigint NOT NULL CHECK(to_id > 0),
            report_id bigint REFERENCES v2_content_reports(id) ON DELETE SET NULL,
            from_snapshot jsonb NOT NULL,
            to_snapshot jsonb NOT NULL,
            result_snapshot jsonb NOT NULL,
            merged_by bigint REFERENCES v2_users(id) ON DELETE SET NULL,
            merged_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(kind,from_id),
            CHECK(from_id <> to_id)
        );
        CREATE INDEX v2_content_merges_to_idx ON v2_content_merges(kind,to_id);
        CREATE TABLE v2_store_osm_aliases (
            osm_type varchar(20) NOT NULL,
            osm_id bigint NOT NULL,
            store_id bigint NOT NULL REFERENCES v2_stores(id),
            PRIMARY KEY(osm_type,osm_id)
        );
        CREATE INDEX v2_store_osm_aliases_store_idx ON v2_store_osm_aliases(store_id);
        -- Offers and observations reference a compound store key; both must move
        -- in one transaction before that compound FK is checked.
        DO $$ DECLARE fk record; BEGIN
            FOR fk IN SELECT conname FROM pg_constraint
                WHERE conrelid='v2_price_observations'::regclass
                  AND confrelid='v2_offers'::regclass AND contype='f'
            LOOP
                EXECUTE format('ALTER TABLE v2_price_observations ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',fk.conname);
            END LOOP;
        END $$;
    """,

    "0023_merge_manual_observations": """
        -- Keep both approved readings when a duplicate-sheet merge makes their
        -- manual uniqueness keys equal. Ordinary new manual readings remain unique.
        ALTER TABLE v2_price_observations ADD COLUMN merge_duplicate_of_id bigint
            REFERENCES v2_price_observations(id);
        DROP INDEX v2_price_observations_manual_idx;
        CREATE UNIQUE INDEX v2_price_observations_manual_idx
            ON v2_price_observations(product_id, store_id, sales_channel,
                observed_at, price, coalesce(quantity_text, ''))
            WHERE source='manual' AND merge_duplicate_of_id IS NULL;
        CREATE INDEX v2_price_observations_merge_duplicate_idx
            ON v2_price_observations(merge_duplicate_of_id)
            WHERE merge_duplicate_of_id IS NOT NULL;
    """,
    "0024_retailer_groups": """
        -- Source retailer rows and their price references remain unchanged.
        CREATE TABLE v2_retailer_groups (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            name varchar(200) NOT NULL CHECK (btrim(name) <> ''),
            name_key varchar(200) NOT NULL UNIQUE
        );
        ALTER TABLE v2_retailers
            ADD COLUMN group_id bigint REFERENCES v2_retailer_groups(id);
        INSERT INTO v2_retailer_groups(name,name_key)
        SELECT DISTINCT ON (lower(btrim(name))) btrim(name),lower(btrim(name))
        FROM v2_retailers ORDER BY lower(btrim(name)),id;
        INSERT INTO v2_retailer_groups(name,name_key) VALUES
            ('Auchan','auchan'),('Carrefour','carrefour'),
            ('Intermarché','intermarché'),('E.Leclerc','e.leclerc')
        ON CONFLICT(name_key) DO NOTHING;
        UPDATE v2_retailers r SET group_id=g.id
        FROM v2_retailer_groups g WHERE g.name_key=lower(btrim(r.name));

        -- Explicitly verified families; other chains are never grouped by
        -- fuzzy similarity or corporate ownership.
        UPDATE v2_retailers r SET group_id=g.id
        FROM v2_retailer_groups g
        WHERE g.name_key='auchan'
          AND lower(btrim(r.name)) IN ('auchan','auchan supermarché');
        UPDATE v2_retailers r SET group_id=g.id
        FROM v2_retailer_groups g
        WHERE g.name_key='carrefour'
          AND lower(btrim(r.name)) IN (
            'carrefour','carrefour city','carrefour contact',
            'carrefour express','carrefour market');
        UPDATE v2_retailers r SET group_id=g.id
        FROM v2_retailer_groups g
        WHERE g.name_key='intermarché'
          AND lower(btrim(r.name)) IN (
            'intermarché','intermarché contact','intermarché hyper',
            'intermarché super');
        UPDATE v2_retailers r SET group_id=g.id
        FROM v2_retailer_groups g
        WHERE g.name_key='e.leclerc'
          AND lower(btrim(r.name)) IN (
            'e.leclerc','e. leclerc','e.leclerc drive',
            'e. leclerc drive','e.leclerc express',
            'centre commercial e.leclerc');
        DELETE FROM v2_retailer_groups g
        WHERE NOT EXISTS (SELECT 1 FROM v2_retailers r WHERE r.group_id=g.id);
        ALTER TABLE v2_retailers ALTER COLUMN group_id SET NOT NULL;
        CREATE INDEX v2_retailers_group_idx ON v2_retailers(group_id);
        -- A source-label mapping survives future imports of the same label,
        -- even after an administrator moves it to another group.
        CREATE TABLE v2_retailer_group_names (
            name_key varchar(200) PRIMARY KEY,
            group_id bigint NOT NULL REFERENCES v2_retailer_groups(id)
        );
        INSERT INTO v2_retailer_group_names(name_key,group_id)
        SELECT DISTINCT ON (lower(btrim(name))) lower(btrim(name)),group_id
        FROM v2_retailers ORDER BY lower(btrim(name)),id;
        CREATE FUNCTION v2_retailer_default_group() RETURNS trigger AS $$
        DECLARE source_key varchar(200);
        BEGIN
            IF NEW.group_id IS NULL THEN
                source_key := lower(btrim(NEW.name));
                SELECT group_id INTO NEW.group_id FROM v2_retailer_group_names
                WHERE name_key=source_key FOR UPDATE;
                IF NEW.group_id IS NULL THEN
                    INSERT INTO v2_retailer_groups(name,name_key)
                    VALUES (btrim(NEW.name),source_key)
                    ON CONFLICT (name_key) DO NOTHING;
                    SELECT id INTO NEW.group_id FROM v2_retailer_groups
                    WHERE name_key=source_key;
                    INSERT INTO v2_retailer_group_names(name_key,group_id)
                    VALUES (source_key,NEW.group_id) ON CONFLICT DO NOTHING;
                    SELECT group_id INTO NEW.group_id FROM v2_retailer_group_names
                    WHERE name_key=source_key;
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER v2_retailer_default_group_before_insert
            BEFORE INSERT ON v2_retailers FOR EACH ROW
            EXECUTE FUNCTION v2_retailer_default_group();
        CREATE TABLE v2_retailer_group_events (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            retailer_id bigint NOT NULL REFERENCES v2_retailers(id),
            from_group_id bigint NOT NULL REFERENCES v2_retailer_groups(id),
            to_group_id bigint NOT NULL REFERENCES v2_retailer_groups(id),
            actor_id bigint REFERENCES v2_users(id) ON DELETE SET NULL,
            changed_at timestamptz NOT NULL DEFAULT now(),
            CHECK (from_group_id <> to_group_id)
        );
    """,


}


def ssl_option(config: dict) -> bool | str | ssl.SSLContext:
    mode = config["tls_mode"]
    if mode == "disable":
        return False
    if mode == "require":
        return "require"
    if mode == "verify-full":
        if config.get("provider") == "supabase":
            return ssl.create_default_context(cafile="/certs/supabase-ca.crt")
        if config.get("host") == "db":
            return ssl.create_default_context(cafile="/certs/server.crt")
        return ssl.create_default_context()
    raise ValueError("Unsupported V2 TLS mode")


async def connect_v2(config: dict) -> asyncpg.Connection:
    return await asyncpg.connect(
        host=config["host"],
        port=config["port"],
        user=config["username"],
        password=config["password"],
        database=config["database"],
        ssl=ssl_option(config),
        timeout=8,
    )


async def migrate_v2(config: dict) -> list[str]:
    """Apply only missing migrations, serializing concurrent first-run attempts."""
    connection = await connect_v2(config)
    applied = []
    try:
        async with connection.transaction():
            await connection.execute("SELECT pg_advisory_xact_lock(6782732671)")
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS v2_schema_migrations (
                    version text PRIMARY KEY,
                    applied_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
            for version, ddl in MIGRATIONS.items():
                exists = await connection.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM v2_schema_migrations "
                    "WHERE version=$1)",
                    version,
                )
                if not exists:
                    await connection.execute(ddl)
                    await connection.execute(
                        "INSERT INTO v2_schema_migrations(version) VALUES($1)", version
                    )
                    applied.append(version)
    finally:
        await connection.close()
    return applied


if __name__ == "__main__":
    from app.api.v2.setup import _read_config

    async def main() -> None:
        config = _read_config()
        if config is None:
            raise SystemExit("V2 database is not configured")
        applied = await migrate_v2(config)
        print("V2 migrations applied: " + (", ".join(applied) or "none"))

    asyncio.run(main())
