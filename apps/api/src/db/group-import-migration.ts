export const groupImportMigration = {
  version: 42,
  sql: `
    CREATE TABLE import_pipelines (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1),
      plan_id TEXT NOT NULL REFERENCES import_plans(id) ON DELETE RESTRICT,
      source_manifest_digest TEXT NOT NULL CHECK(length(source_manifest_digest)=64 AND source_manifest_digest NOT GLOB '*[^a-f0-9]*'),
      options_json TEXT NOT NULL CHECK(json_valid(options_json)),
      source_policy TEXT NOT NULL CHECK(source_policy='KEEP'),
      idempotency_key TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE import_pipeline_groups (
      pipeline_id TEXT NOT NULL REFERENCES import_pipelines(id) ON DELETE RESTRICT,
      group_key TEXT NOT NULL CHECK(length(group_key)=64 AND group_key NOT GLOB '*[^a-f0-9]*'),
      ordinal INTEGER NOT NULL CHECK(ordinal>=0), group_json TEXT NOT NULL CHECK(json_valid(group_json)),
      input_bytes TEXT NOT NULL, required_spool_bytes TEXT NOT NULL,
      issue TEXT, job_id TEXT UNIQUE REFERENCES import_jobs(id) ON DELETE RESTRICT,
      admission TEXT NOT NULL DEFAULT 'WAITING' CHECK(admission IN ('WAITING','ADMITTED','CACHED','EVICTING','COMPLETE')),
      resident_bytes TEXT NOT NULL DEFAULT '0', resident_sampled_at INTEGER,
      wait_kind TEXT CHECK(wait_kind IS NULL OR wait_kind IN ('CAPACITY','DISK','PRESSURE','DOWNLOAD','EXTRACTION','UPLOAD','FAIRNESS')),
      wait_since INTEGER, bypass_count INTEGER NOT NULL DEFAULT 0,
      needs_redownload INTEGER NOT NULL DEFAULT 0 CHECK(needs_redownload IN (0,1)),
      eviction_generation INTEGER NOT NULL DEFAULT 0, eviction_proof_json TEXT CHECK(eviction_proof_json IS NULL OR json_valid(eviction_proof_json)),
      cache_probe_after INTEGER NOT NULL DEFAULT 0,
      parent_paused INTEGER NOT NULL DEFAULT 0 CHECK(parent_paused IN (0,1)),
      last_error_code TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY(pipeline_id,group_key),UNIQUE(pipeline_id,ordinal)
    );
    CREATE INDEX import_pipeline_group_admission ON import_pipeline_groups(admission,wait_since,ordinal);
    CREATE TABLE import_pipeline_operations (
      pipeline_id TEXT NOT NULL REFERENCES import_pipelines(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(pipeline_id,idempotency_key)
    );
    CREATE TABLE import_pipeline_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
      values_json TEXT NOT NULL CHECK(json_valid(values_json)),
      updated_at INTEGER NOT NULL,
      updated_by_admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL
    );
    CREATE TABLE import_pipeline_settings_requests (
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK(json_valid(response_json)),
      expires_at INTEGER NOT NULL,PRIMARY KEY(admin_id,idempotency_key)
    );
    CREATE INDEX import_pipeline_settings_request_expiry ON import_pipeline_settings_requests(expires_at);
    CREATE TRIGGER import_pipeline_scope_immutable BEFORE UPDATE OF version,plan_id,source_manifest_digest,options_json,source_policy,request_fingerprint,idempotency_key ON import_pipelines
      BEGIN SELECT RAISE(ABORT,'GROUP_PIPELINE_SCOPE_IMMUTABLE'); END;
    CREATE TRIGGER import_pipeline_group_scope_immutable BEFORE UPDATE OF pipeline_id,group_key,ordinal,group_json,input_bytes,required_spool_bytes,job_id ON import_pipeline_groups
      BEGIN SELECT RAISE(ABORT,'GROUP_IDENTITY_IMMUTABLE'); END;
  `,
};
