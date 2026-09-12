/** Additive metadata only: historical exports, attestations and copies stay intact. */
export const recoveryPreparationMigration = {
  version: 40,
  sql: `
    CREATE TABLE recovery_preparation_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      baseline_export_version INTEGER REFERENCES recovery_exports(version) ON DELETE RESTRICT,
      baseline_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(baseline_revision) = 'integer' AND baseline_revision >= 0),
      baseline_selected_at INTEGER,
      baseline_selected_by_admin_id TEXT,
      baseline_selection_source TEXT NOT NULL DEFAULT 'NONE' CHECK(baseline_selection_source IN ('NONE', 'MIGRATION_APPROVED', 'USER')),
      baseline_bootstrap_pending INTEGER NOT NULL DEFAULT 0 CHECK(baseline_bootstrap_pending IN (0, 1)),
      material_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(material_revision) = 'integer' AND material_revision >= 0),
      active_escrow_sha256 TEXT CHECK(active_escrow_sha256 IS NULL OR (length(active_escrow_sha256) = 64 AND active_escrow_sha256 NOT GLOB '*[^0-9a-f]*')),
      escrow_update_state TEXT NOT NULL DEFAULT 'UNINITIALIZED' CHECK(escrow_update_state IN ('UNINITIALIZED', 'STABLE', 'UPDATING', 'UNRESOLVED')),
      pending_escrow_sha256 TEXT CHECK(pending_escrow_sha256 IS NULL OR (length(pending_escrow_sha256) = 64 AND pending_escrow_sha256 NOT GLOB '*[^0-9a-f]*')),
      pending_operation_id TEXT,
      updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0),
      CHECK((baseline_export_version IS NULL AND baseline_revision = 0 AND baseline_selected_at IS NULL
        AND baseline_selected_by_admin_id IS NULL AND baseline_selection_source = 'NONE')
        OR (baseline_export_version IS NOT NULL AND baseline_revision > 0 AND baseline_selected_at IS NOT NULL
        AND baseline_selected_by_admin_id IS NOT NULL AND length(baseline_selected_by_admin_id) BETWEEN 1 AND 128
        AND baseline_selection_source != 'NONE' AND baseline_bootstrap_pending = 0)),
      CHECK((escrow_update_state = 'UNINITIALIZED' AND active_escrow_sha256 IS NULL AND pending_escrow_sha256 IS NULL AND pending_operation_id IS NULL)
        OR (escrow_update_state = 'STABLE' AND active_escrow_sha256 IS NOT NULL AND pending_escrow_sha256 IS NULL AND pending_operation_id IS NULL)
        OR (escrow_update_state = 'UPDATING' AND pending_escrow_sha256 IS NOT NULL AND pending_operation_id IS NOT NULL AND length(pending_operation_id) BETWEEN 1 AND 128)
        OR (escrow_update_state = 'UNRESOLVED' AND ((pending_escrow_sha256 IS NULL AND pending_operation_id IS NULL)
          OR (pending_escrow_sha256 IS NOT NULL AND pending_operation_id IS NOT NULL AND length(pending_operation_id) BETWEEN 1 AND 128))))
    );
    INSERT INTO recovery_preparation_state(id, baseline_bootstrap_pending, updated_at)
    SELECT 1, EXISTS(SELECT 1 FROM recovery_exports
      WHERE completed_at IS NOT NULL AND bundle_sha256 IS NOT NULL AND escrow_sha256 IS NOT NULL
      AND computer_confirmed_at IS NOT NULL AND computer_confirmed_sha256 = bundle_sha256
      AND passphrase_verified_at IS NOT NULL AND passphrase_verified_sha256 = escrow_sha256), 0;

    CREATE TABLE recovery_preparation_requests (
      admin_id TEXT NOT NULL CHECK(length(admin_id) BETWEEN 1 AND 128),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
      operation TEXT NOT NULL CHECK(operation IN ('BASELINE_SELECT', 'RECIPIENT_SET', 'ESCROW_REPLACE')),
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
      operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) BETWEEN 1 AND 128),
      state TEXT NOT NULL CHECK(state IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNRESOLVED')),
      result_json TEXT CHECK(result_json IS NULL OR (length(result_json) <= 16384 AND json_valid(result_json))),
      created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= 0),
      updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at >= created_at),
      PRIMARY KEY(admin_id, idempotency_key),
      CHECK(state != 'SUCCEEDED' OR result_json IS NOT NULL)
    );
  `,
};
