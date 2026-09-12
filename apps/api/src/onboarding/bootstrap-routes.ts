import {
  BootstrapBeginSchema,
  BootstrapCompleteSchema,
  BootstrapCompleteResultSchema,
  BootstrapEnrollmentSchema,
} from '@ptvault/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';

import { AuthRepository } from '../auth/repository.js';
import { AuthError } from '../auth/service.js';
import type { AppDatabase } from '../db/database.js';
import type { AuditRepository } from '../audit/repository.js';
import { BootstrapError, type BootstrapService } from './bootstrap.js';

const MESSAGES = {
  SETUP_CLOSED: '管理员已经创建，请正常登录。',
  SETUP_LINK_INVALID: '初始化链接无效，请使用安装器提供的完整链接。',
  SETUP_LINK_EXPIRED: '初始化链接已过期，请在服务器运行 ptvault setup-link 获取新链接。',
  SETUP_ENROLLMENT_EXPIRED: '这次验证已失效，请重新添加验证器后再试。',
  SETUP_BUSY: '正在创建管理员，请稍候，不需要重复提交。',
} as const;

function rejectKnown(error: unknown, reply: FastifyReply) {
  if (error instanceof BootstrapError) {
    return reply.code(error.code === 'SETUP_BUSY' || error.code === 'SETUP_CLOSED' ? 409 : 403).send({
      code: error.code,
      error: MESSAGES[error.code],
    });
  }
  if (error instanceof AuthError && error.code === 'MFA_CODE_INVALID') {
    return reply.code(400).send({ code: error.code, error: '验证码不正确，请检查验证器和设备时间。' });
  }
  throw error;
}

export function registerBootstrapRoutes(
  app: FastifyInstance,
  deps: {
    db: AppDatabase;
    audit: AuditRepository;
    port: number;
    bootstrap?: BootstrapService;
    protectCsrf: onRequestHookHandler;
  },
): void {
  const admins = new AuthRepository(deps.db);
  app.get('/api/setup/bootstrap', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return deps.bootstrap?.status() ?? { required: !admins.hasAdmin(), available: false };
  });

  // The initialization URL is intended for localhost over an SSH tunnel, not a
  // public "first visitor becomes owner" page. Never trust forwarded IPs here.
  const requireLocal = async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header('cache-control', 'no-store');
    if (!deps.bootstrap) {
      return reply.code(404).send({ code: 'SETUP_UNAVAILABLE', error: '此安装由服务器管理员初始化。' });
    }
    const remote = request.raw.socket.remoteAddress;
    const origin = `http://localhost:${deps.port}`;
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
      request.headers.origin !== origin ||
      request.headers.host !== `localhost:${deps.port}` ||
      request.headers['x-forwarded-for'] !== undefined ||
      request.headers.forwarded !== undefined
    ) {
      return reply.code(403).send({
        code: 'SETUP_LOCAL_ACCESS_REQUIRED',
        error: '请通过安装器给出的 SSH 转发和 localhost 链接完成首次设置。',
      });
    }
  };
  const guarded = {
    onRequest: deps.protectCsrf,
    preHandler: requireLocal,
    config: { rateLimit: { max: 5, timeWindow: '1 minute', hook: 'preHandler' as const } },
  };

  app.post('/api/setup/bootstrap/begin', guarded, (request, reply) => {
    const parsed = BootstrapBeginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写有效的用户名和初始化链接。' });
    try {
      return BootstrapEnrollmentSchema.parse(
        deps.bootstrap!.begin(parsed.data.setupToken, parsed.data.username),
      );
    } catch (error) {
      return rejectKnown(error, reply);
    }
  });

  app.post('/api/setup/bootstrap/complete', guarded, async (request, reply) => {
    const parsed = BootstrapCompleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '密码至少12个字符，验证码为6位数字。' });
    try {
      const result = await deps.bootstrap!.complete(parsed.data.setupToken, parsed.data);
      deps.audit.append({
        actorAdminId: null,
        sourceIp: request.ip,
        action: 'AUTH_INITIALIZED',
        correlationId: request.id,
        subject: 'initial-administrator',
        outcome: 'SUCCESS',
        detail: { authenticatorVerified: true },
      });
      return BootstrapCompleteResultSchema.parse(result);
    } catch (error) {
      return rejectKnown(error, reply);
    }
  });
}
