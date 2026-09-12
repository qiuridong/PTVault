import {
  NetdiskSettingsIdempotencyKeySchema,
  RcloneImportPreviewRequestSchema,
  RcloneImportPreviewSchema,
  RcloneImportPendingSchema,
  RcloneImportRequestSchema,
  SetupApplyRequestSchema,
  SetupConfigPatchSchema,
  SetupPathCheckRequestSchema,
  SetupPathCheckResultSchema,
  SetupSaveResultSchema,
  SetupUseCaseSchema,
  type SetupSaveResult,
} from '@ptvault/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';

import type { AuditRepository } from '../audit/repository.js';
import type { AuthService } from '../auth/service.js';
import type { AppConfig } from '../config/env.js';
import type { AppDatabase } from '../db/database.js';
import type { ImportControlService } from '../imports/service.js';
import type { NetdiskSettingsService } from '../settings/netdisk-settings.js';
import type { QbServices } from '../qb/services.js';
import type { RecoveryPreparationContext } from '../recovery/preparation-context.js';
import { CloudConnectionRepository } from '../cloud-connections/repository.js';
import { StorageAccountRepository } from '../storage/accounts.js';
import { buildSetupOverview } from './overview.js';
import { SetupConfigError, type SetupConfigStore } from './config-store.js';
import { SetupPathProbe } from './path-check.js';
import type { RcloneImportService } from './rclone-import.js';
import { RcloneImportError } from './rclone-import-source.js';

export type ManagedSetup = {
  store: SetupConfigStore;
  applying: () => boolean;
  requestActivation: (revision: number) => SetupSaveResult['activation'];
  installAdmission?: (app: FastifyInstance) => void;
};

const ERROR_MESSAGES: Record<string, string> = {
  SETUP_REVISION_CONFLICT: '设置已有更新。先刷新当前配置，再合并你的修改。',
  SETUP_IDEMPOTENCY_CONFLICT: '这次保存请求与先前内容不同，请刷新后重新保存。',
  SETUP_PATH_INVALID: '请填写绝对目录；路径映射要包含来源位置和服务器位置。',
  SETUP_PATH_OVERLAP: '来源目录不能与临时目录或 PTVault 私密数据目录重叠。',
  SETUP_JELLYFIN_URL_INVALID: 'Jellyfin 应填写这台服务器上的本机 HTTP 地址，不包含账号或路径。',
  SETUP_CALLBACK_ORIGIN_INVALID: 'OAuth 回调应填写完整 HTTPS 站点地址，不包含路径或查询参数。',
  SETUP_CONFIG_INVALID: '设置内容超出支持范围，原配置没有被替换。',
};

function knownError(error: unknown, reply: FastifyReply) {
  if (error instanceof SetupConfigError) {
    return reply.code(error.code.includes('CONFLICT') ? 409 : 400).send({ code: error.code, error: ERROR_MESSAGES[error.code] ?? '设置尚未保存，请检查配置内容。' });
  }
  throw error;
}

export function registerSetupRoutes(app: FastifyInstance, deps: {
  config: AppConfig;
  db: AppDatabase;
  auth: AuthService;
  audit: AuditRepository;
  imports: Pick<ImportControlService, 'capabilities'>;
  netdisk: NetdiskSettingsService;
  qb: QbServices;
  preparation: RecoveryPreparationContext;
  offloadConfigured: boolean;
  managed?: ManagedSetup;
  rcloneImport?: RcloneImportService;
  requireSession: preHandlerAsyncHookHandler;
  protectCsrf: onRequestHookHandler;
}) {
  const readGuard = { preHandler: deps.requireSession };
  const writeGuard = { onRequest: deps.protectCsrf, preHandler: deps.requireSession };
  const connections = new CloudConnectionRepository(deps.db);
  const accounts = new StorageAccountRepository(deps.db);

  if (deps.managed && deps.rcloneImport) {
    const importer = deps.rcloneImport;
    const handleImportError = (error: unknown, reply: FastifyReply) => {
      if (error instanceof RcloneImportError) return reply.code(error.code.endsWith('FAILED') ? 502 : 409).send({ code: error.code, error: '尚未完成导入。原配置和已保存账户不会被覆盖，请按提示重试。' });
      throw error;
    };
    app.get('/api/setup/rclone-import/pending', readGuard, (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return RcloneImportPendingSchema.parse(importer.pending(request.authenticatedAdmin!.adminId));
    });
    app.post('/api/setup/rclone-import/preview', writeGuard, (request, reply) => {
      void reply.header('cache-control', 'no-store');
      const parsed = RcloneImportPreviewRequestSchema.safeParse(request.body);
      if (!parsed.success || !request.authenticatedAdmin) return reply.code(400).send({ error: '请填写服务器上的配置文件绝对路径。' });
      try { return RcloneImportPreviewSchema.parse(importer.preview(request.authenticatedAdmin.adminId, parsed.data.path)); }
      catch (error) { return handleImportError(error, reply); }
    });
    app.post('/api/setup/rclone-import/commit', writeGuard, async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      const parsed = RcloneImportRequestSchema.safeParse(request.body);
      const key = NetdiskSettingsIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!parsed.success || !key.success || !request.authenticatedAdmin) return reply.code(400).send({ error: '请选择一至两个账户，并填写验证码。' });
      const adminId = request.authenticatedAdmin.adminId;
      try {
        return await importer.import({ adminId, idempotencyKey: key.data, previewId: parsed.data.previewId, pairIds: parsed.data.pairIds }, () => {
          if (!verifyMfa(request, reply, parsed.data.mfaCode ?? '')) throw new Error('SETUP_MFA_REJECTED');
        }, (result) => deps.audit.append({ actorAdminId: adminId, sourceIp: request.ip, action: 'SETUP_RCLONE_IMPORT', subject: 'storage-accounts', outcome: 'SUCCESS', correlationId: request.id, detail: { accountIds: result.accountIds.join(',') } }));
      } catch (error) { if (reply.sent) return reply; return handleImportError(error, reply); }
    });
  }

  app.get('/api/setup/overview', readGuard, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const query = z.object({ useCases: z.string().max(100).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '用途选择无效。' });
    const selected = query.data.useCases === undefined ? undefined : z.array(SetupUseCaseSchema).max(3).safeParse(query.data.useCases === '' ? [] : query.data.useCases.split(','));
    if (selected !== undefined && !selected.success) return reply.code(400).send({ error: '用途选择无效。' });
    const recovery = await deps.preparation.readiness.currentStatus();
    const configuration = deps.managed?.store.view();
    return buildSetupOverview({
      config: deps.config,
      netdisk: deps.netdisk.status(),
      ...(selected?.success ? { useCases: selected.data } : {}),
      ...(configuration === undefined ? {} : { configuration }),
      applying: deps.managed?.applying() ?? false,
      offloadConfigured: deps.offloadConfigured,
      publicationEnabled: deps.imports.capabilities().capabilities.publishToJellyfinEnabled,
      connections: connections.list(),
      accounts: accounts.list(),
      qbInstances: deps.qb.repository.listInstances().map((instance) => ({
        enabled: instance.enabled,
        hasCredential: deps.qb.credentials.get(instance.secretRef) !== null,
        lastSyncAt: instance.lastSyncAt ?? null,
        lastSyncError: instance.lastSyncError ?? null,
      })),
      recoveryReady: recovery.deletionUnlocked,
    });
  });

  app.post('/api/setup/paths/check', writeGuard, async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = SetupPathCheckRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写有效的文件位置。' });
    const draft = deps.managed?.store.view().values;
    const probe = new SetupPathProbe({
      allowedRoots: draft?.sourceRoots ?? deps.config.qbAllowedRoots,
      spoolRoot: draft?.spoolRoot ?? deps.config.importSpoolRoot,
      protectedRoots: [deps.config.stateDir, ...(deps.config.importSecretRoot === null ? [] : [deps.config.importSecretRoot])],
    });
    return SetupPathCheckResultSchema.parse(parsed.data.kind === 'SPOOL' ? await probe.spool() : await probe.source(parsed.data));
  });

  function verifyMfa(request: FastifyRequest, reply: FastifyReply, code: string): boolean {
    if (!request.authenticatedAdmin) { void reply.code(401).send({ error: 'Unauthorized' }); return false; }
    try { deps.auth.verifyStepUp(request.authenticatedAdmin.adminId, code); return true; } catch {
      void reply.code(403).send({ code: 'SETUP_MFA_REQUIRED', error: '请填写验证器中当前的6位验证码。' });
      return false;
    }
  }

  app.patch('/api/setup/configuration', writeGuard, (request, reply) => {
    void reply.header('cache-control', 'no-store');
    if (!deps.managed) return reply.code(409).send({ code: 'SETUP_MANAGED_EXTERNALLY', error: '此安装由服务器配置管理，网页不会覆盖它。' });
    const parsed = SetupConfigPatchSchema.safeParse(request.body);
    const key = NetdiskSettingsIdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!parsed.success || !key.success || !request.authenticatedAdmin) return reply.code(400).send({ error: '设置或保存标识无效。' });
    const stage = {
      adminId: request.authenticatedAdmin.adminId, idempotencyKey: key.data, expectedRevision: parsed.data.revision,
      values: parsed.data.values, ...(parsed.data.secrets === undefined ? {} : { secrets: parsed.data.secrets }),
    };
    try {
      const replayed = deps.managed.store.replay(stage);
      if (replayed !== null) return SetupSaveResultSchema.parse({ configuration: replayed, activation: deps.managed.applying() ? 'APPLYING' : replayed.pendingChanges ? 'SAVED' : 'ALREADY_APPLIED' });
      if (!verifyMfa(request, reply, parsed.data.mfaCode)) return reply;
      const configuration = deps.managed.store.stage(stage);
      deps.audit.append({ actorAdminId: stage.adminId, sourceIp: request.ip, action: 'SETUP_SETTINGS_UPDATE', subject: 'installation-settings', outcome: 'SUCCESS', correlationId: request.id, detail: { revision: configuration.revision, pendingChanges: configuration.pendingChanges } });
      const activation = parsed.data.apply ? deps.managed.requestActivation(configuration.revision) : 'SAVED';
      return reply.code(activation === 'APPLYING' ? 202 : 200).send(SetupSaveResultSchema.parse({ configuration, activation }));
    } catch (error) { return knownError(error, reply); }
  });

  app.post('/api/setup/apply', writeGuard, (request, reply) => {
    void reply.header('cache-control', 'no-store');
    if (!deps.managed) return reply.code(409).send({ code: 'SETUP_MANAGED_EXTERNALLY', error: '此安装由服务器配置管理。' });
    const parsed = SetupApplyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写当前配置版本和验证码。' });
    const configuration = deps.managed.store.view();
    if (configuration.revision !== parsed.data.revision) return reply.code(409).send({ code: 'SETUP_REVISION_CONFLICT', error: ERROR_MESSAGES.SETUP_REVISION_CONFLICT });
    if (!configuration.pendingChanges) return { configuration, activation: 'ALREADY_APPLIED' };
    if (!verifyMfa(request, reply, parsed.data.mfaCode)) return reply;
    const activation = deps.managed.requestActivation(configuration.revision);
    return reply.code(activation === 'APPLYING' ? 202 : 200).send(SetupSaveResultSchema.parse({ configuration, activation }));
  });
}
