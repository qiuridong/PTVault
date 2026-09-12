export const archiveImportMigration = {
  version: 41,
  sql: `
    ALTER TABLE import_objects ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'SOURCE'
      CHECK(origin_kind IN ('SOURCE','EXTRACTED'));
    ALTER TABLE import_objects ADD COLUMN origin_digest TEXT;
    CREATE TABLE archive_imports (
      job_id TEXT PRIMARY KEY REFERENCES import_jobs(id) ON DELETE RESTRICT,
      phase TEXT NOT NULL CHECK(phase IN ('PENDING','DOWNLOADING_INPUTS','EXTRACTING','WAITING_PASSWORD','PREPARING_VIDEOS','READY','CLEANED')),
      options_json TEXT NOT NULL CHECK(json_valid(options_json)),
      secret_ref TEXT,
      candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 32),
      input_count INTEGER NOT NULL CHECK(input_count>0),
      input_bytes TEXT NOT NULL CHECK(input_bytes NOT GLOB '*[^0-9]*' AND length(input_bytes)>0),
      input_bytes_done TEXT NOT NULL DEFAULT '0',
      expanded_bytes TEXT NOT NULL DEFAULT '0',
      video_count INTEGER NOT NULL DEFAULT 0,
      video_bytes TEXT NOT NULL DEFAULT '0',
      depth INTEGER NOT NULL DEFAULT 0,
      archive_count INTEGER NOT NULL DEFAULT 0,
      candidate_index INTEGER,
      prepared_json TEXT CHECK(prepared_json IS NULL OR json_valid(prepared_json)),
      prepared_digest TEXT,
      last_error_code TEXT,
      cleanup_started INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_started IN (0,1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE archive_inputs (
      job_id TEXT NOT NULL REFERENCES archive_imports(job_id) ON DELETE RESTRICT,
      source_fsid TEXT NOT NULL, object_id TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL, source_size TEXT NOT NULL, source_mtime TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DOWNLOADING','READY','CLEANED')),
      completed_bytes TEXT NOT NULL DEFAULT '0',
      partial_device TEXT, partial_inode TEXT,
      ready_device TEXT, ready_inode TEXT, local_sha256 TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(job_id,source_fsid), UNIQUE(job_id,relative_path)
    );
    CREATE TABLE archive_credential_operations (
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES archive_imports(job_id) ON DELETE RESTRICT,
      request_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(admin_id,idempotency_key)
    );
    CREATE TRIGGER archive_input_identity_immutable BEFORE UPDATE OF job_id,source_fsid,object_id,relative_path,source_size,source_mtime ON archive_inputs
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_INPUT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER archive_input_scope_immutable BEFORE UPDATE OF job_id,options_json,input_count,input_bytes ON archive_imports
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_SCOPE_IMMUTABLE'); END;
    CREATE TRIGGER archive_prepared_immutable BEFORE UPDATE OF prepared_json,prepared_digest ON archive_imports
      WHEN OLD.prepared_json IS NOT NULL AND (NEW.prepared_json IS NOT OLD.prepared_json OR NEW.prepared_digest IS NOT OLD.prepared_digest)
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_OUTPUT_MANIFEST_IMMUTABLE'); END;
    CREATE TRIGGER archive_source_keep_insert BEFORE INSERT ON archive_imports
      WHEN NOT EXISTS(SELECT 1 FROM import_jobs WHERE id=NEW.job_id AND source_kind='BAIDU_APP_DIR' AND source_cleanup_policy='KEEP')
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_KEEP_REQUIRED'); END;
    CREATE TRIGGER archive_source_keep_update BEFORE UPDATE OF source_cleanup_policy ON import_jobs
      WHEN NEW.source_cleanup_policy<>'KEEP' AND EXISTS(SELECT 1 FROM archive_imports WHERE job_id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_KEEP_REQUIRED'); END;
    CREATE TRIGGER archive_no_source_upload BEFORE INSERT ON import_objects
      WHEN NEW.origin_kind='SOURCE' AND EXISTS(SELECT 1 FROM archive_imports WHERE job_id=NEW.job_id)
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_INPUT_UPLOAD_FORBIDDEN'); END;
    CREATE TRIGGER archive_output_proof_insert BEFORE INSERT ON import_objects
      WHEN NEW.origin_kind='EXTRACTED' AND NOT EXISTS(
        SELECT 1 FROM archive_imports AS a, json_each(a.prepared_json,'$.outputs') AS p
        WHERE a.job_id=NEW.job_id AND a.phase='PREPARING_VIDEOS' AND a.prepared_digest=NEW.origin_digest
          AND json_extract(p.value,'$.objectId')=NEW.id
          AND json_extract(p.value,'$.localId')=NEW.source_fsid
          AND json_extract(p.value,'$.relativePath')=NEW.relative_path
          AND json_extract(p.value,'$.size')=NEW.source_size
          AND json_extract(p.value,'$.sha256')=NEW.local_sha256
      )
      BEGIN SELECT RAISE(ABORT,'ARCHIVE_OUTPUT_PROOF_REQUIRED'); END;
  `,
};
