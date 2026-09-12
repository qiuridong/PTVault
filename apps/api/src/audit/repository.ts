import { randomUUID } from 'node:crypto';

import type { Clock } from '../core/clock.js';
import type { AppDatabase } from '../db/database.js';

export type AuditInput = {
  actorAdminId: string | null;
  sourceIp: string;
  action:
    | 'AUTH_LOGIN'
    | 'AUTH_INITIALIZED'
    | 'SETUP_SETTINGS_UPDATE'
    | 'SETUP_RCLONE_IMPORT'
    | 'AUTH_MFA'
    | 'AUTH_LOGOUT'
    | 'SESSION_REVOKE'
    | 'RECOVERY_RECIPIENT_SET'
    | 'RECOVERY_BASELINE_SELECTED'
    | 'RECOVERY_ESCROW_UPLOADED'
    | 'RECOVERY_BUNDLE_GENERATED'
    | 'RECOVERY_COMPUTER_CONFIRMED'
    | 'RECOVERY_DRILL_ATTESTED'
    | 'OFFLOAD_TRIGGER'
    | 'OFFLOAD_CANCELLED'
    | 'OFFLOAD_RETRIED'
    | 'OFFLOAD_PAUSE'
    | 'OFFLOAD_RESUME'
    | 'OFFLOAD_PAUSE_ALL'
    | 'OFFLOAD_RESUME_ALL'
    | 'OFFLOAD_CLEANUP'
    | 'TRANSFER_SETTINGS_UPDATE'
    | 'NETDISK_SETTINGS_UPDATE'
    | 'CLOUD_OAUTH_START'
    | 'CLOUD_OAUTH_CALLBACK'
    | 'CLOUD_CONNECTION_REAUTHORIZE'
    | 'CLOUD_CONNECTION_TEST'
    | 'CLOUD_CONNECTION_LABEL_UPDATE'
    | 'CLOUD_CONNECTION_ENABLE'
    | 'CLOUD_CONNECTION_DISABLE'
    | 'CLOUD_CONNECTION_DISCONNECT'
    | 'CLOUD_CONNECTION_PROVISION'
    | 'CLOUD_CONNECTION_TAKEOVER'
    // A restore writes hundreds of gigabytes to the hot disk and then tells a
    // tracker to start announcing, so it belongs in the same trail as an offload.
    | 'MEDIA_PIN_SET'
    | 'MEDIA_REHYDRATE_STARTED'
    | 'MEDIA_REHYDRATE_RETRIED'
    | 'MEDIA_REHYDRATE_CANCELLED'
    | 'IMPORT_PLAN_CREATED'
    | 'IMPORT_CREATED'
    | 'IMPORT_PIPELINE_CREATED'
    | 'IMPORT_PIPELINE_PAUSED'
    | 'IMPORT_PIPELINE_RESUMED'
    | 'IMPORT_PIPELINE_CANCELLED'
    | 'IMPORT_PIPELINE_RETRIED'
    | 'IMPORT_PIPELINE_SETTINGS_UPDATED'
    | 'IMPORT_PAUSED'
    | 'IMPORT_RESUMED'
    | 'IMPORT_CANCELLED'
    | 'IMPORT_RETRIED'
    | 'IMPORT_CREDENTIALS_PROVIDED'
    | 'IMPORT_LEGACY_SOURCE_BOUND'
    | 'IMPORT_SOURCE_CLEANUP_PREVIEWED'
    | 'IMPORT_SOURCE_CLEANUP_EXECUTED'
    | 'MEDIA_PUBLICATION_REQUESTED'
    | 'MEDIA_PUBLICATION_RETRIED'
    | 'MEDIA_PUBLICATION_UNPUBLISHED';
  subject: string;
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
  correlationId: string;
  detail: Record<string, string | number | boolean | null>;
};

export type AuditEvent = Omit<AuditInput, 'detail'> & {
  id: string;
  createdAt: number;
  detail: Record<string, unknown>;
};

type AuditRow = {
  id: string;
  actorAdminId: string | null;
  sourceIp: string;
  action: AuditInput['action'];
  subject: string;
  outcome: AuditInput['outcome'];
  correlationId: string;
  detailJson: string;
  createdAt: number;
};

const SENSITIVE_DETAIL_KEY = /password|secret|token|code/i;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_DETAIL_KEY.test(key))
        .map(([key, item]) => [key, sanitizeValue(item)]),
    );
  }

  return value;
}

function sanitizeDetail(detail: AuditInput['detail']): Record<string, unknown> {
  return sanitizeValue(detail) as Record<string, unknown>;
}

export class AuditRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: Clock = () => new Date(),
  ) {}

  append(input: AuditInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(
           id, actor_admin_id, source_ip, action, subject, outcome,
           correlation_id, detail_json, created_at
         ) VALUES (
           @id, @actorAdminId, @sourceIp, @action, @subject, @outcome,
           @correlationId, @detailJson, @createdAt
         )`,
      )
      .run({
        ...input,
        id: randomUUID(),
        detailJson: JSON.stringify(sanitizeDetail(input.detail)),
        createdAt: this.now().getTime(),
      });
  }

  listRecent(limit = 100): AuditEvent[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `SELECT id, actor_admin_id AS actorAdminId, source_ip AS sourceIp,
                action, subject, outcome, correlation_id AS correlationId,
                detail_json AS detailJson, created_at AS createdAt
         FROM audit_events
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(boundedLimit) as AuditRow[];

    return rows.map(({ detailJson, ...row }) => ({
      ...row,
      detail: JSON.parse(detailJson) as Record<string, unknown>,
    }));
  }
}
