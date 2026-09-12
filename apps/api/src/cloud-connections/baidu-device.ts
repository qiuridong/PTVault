import { randomUUID } from 'node:crypto';
import {
  BaiduDeviceFlowSchema,
  type BaiduDeviceFlow,
  type BaiduDeviceInfo,
} from '@ptvault/contracts';
import {
  fingerprintCloudConnectionOperation,
  type CloudConnectionOperationScope,
} from './idempotency.js';
import {
  CloudConnectionError,
  saveOAuthConnection,
  type OAuthTokenExchangeResult,
} from './oauth.js';
import {
  BaiduDeviceError,
  type BaiduDeviceTransport,
  type BaiduDeviceGrant,
  type BaiduDeviceToken,
} from './baidu-device-transport.js';
import type { CloudConnectionServices } from './services.js';
import { CloudProviderRateLimitError, parseProviderRetryAfter } from './rate-limit.js';

type Actor = { adminId: string; sessionHash: string };
type Target = { id: string; revision: number } | null;
type Flow = {
  actor: Actor;
  dto: BaiduDeviceFlow;
  target: Target;
  grant: BaiduDeviceGrant | null;
  token: BaiduDeviceToken | null;
  inFlight: Promise<BaiduDeviceFlow> | null;
};
type StartIntent = {
  fingerprint: string;
  expiresAt: number;
  flow: Flow | null;
  inFlight: Promise<BaiduDeviceFlow> | null;
};
export class DeviceFlowError extends Error {
  constructor(readonly code: 'DEVICE_FLOW_RESTARTED' | 'DEVICE_BUSY' | 'IDEMPOTENCY_KEY_CONFLICT') {
    super(code);
    this.name = 'DeviceFlowError';
  }
}
/** Short-lived grants stay in memory. Only a safe completed result is durable, atomically with the connection. */
export class BaiduDeviceService {
  private readonly instanceId = randomUUID();
  private readonly now: () => number;
  private readonly flows = new Map<string, Flow>();
  private readonly starts = new Map<string, StartIntent>();
  constructor(
    private readonly options: {
      cloud: Pick<CloudConnectionServices, 'repository' | 'secrets' | 'receipts' | 'refresh'>;
      transport: Pick<BaiduDeviceTransport, 'begin' | 'poll'>;
      inspect: (token: BaiduDeviceToken) => Promise<OAuthTokenExchangeResult>;
      clientId: string;
      profile?: { id: string; fingerprint: string };
      clientLabel: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }
  info(): BaiduDeviceInfo {
    return {
      instanceId: this.instanceId,
      clientLabel: this.options.clientLabel,
      profileId: this.options.profile?.id ?? null,
    };
  }
  async start(
    input: Actor & { key: string; instanceId: string; target: Target },
    approve: () => void,
  ): Promise<BaiduDeviceFlow> {
    if (input.instanceId !== this.instanceId) throw new DeviceFlowError('DEVICE_FLOW_RESTARTED');
    this.reap();
    const key = fingerprintCloudConnectionOperation({
      adminId: input.adminId,
      sessionHash: input.sessionHash,
      key: input.key,
    });
    const fingerprint = fingerprintCloudConnectionOperation(input.target);
    let intent = this.starts.get(key);
    if (intent) {
      if (intent.fingerprint !== fingerprint) throw new DeviceFlowError('IDEMPOTENCY_KEY_CONFLICT');
      if (intent.flow) return this.view(intent.flow);
      if (intent.inFlight) return intent.inFlight;
    } else {
      if (this.starts.size >= 32) throw new DeviceFlowError('DEVICE_BUSY');
      if (input.target) {
        const target = this.options.cloud.repository.get(input.target.id);
        if (
          target.provider !== 'BAIDU' ||
          target.readOnly ||
          !target.supportedActions.includes('REAUTHORIZE')
        )
          throw new CloudConnectionError('CONNECTION_AUTH_STATE_INVALID', 409);
        if (target.revision !== input.target.revision)
          throw new CloudConnectionError('CONNECTION_REVISION_CONFLICT', 409);
      }
      approve();
      intent = { fingerprint, expiresAt: this.now() + 1800000, flow: null, inFlight: null };
      this.starts.set(key, intent);
    }
    const current = intent;
    current.inFlight = this.options.transport
      .begin()
      .then((grant) => {
        const flow: Flow = {
          actor: { adminId: input.adminId, sessionHash: input.sessionHash },
          target: input.target,
          grant,
          token: null,
          inFlight: null,
          dto: {
            flowId: randomUUID(),
            status: 'PENDING',
            userCode: grant.userCode,
            verificationUrl: 'https://openapi.baidu.com/device',
            expiresAt: Math.min(grant.expiresAt, current.expiresAt),
            nextPollAt: this.now() + grant.intervalMs,
            completedConnectionId: null,
            failureCode: null,
          },
        };
        current.flow = flow;
        this.flows.set(flow.dto.flowId, flow);
        return this.view(flow);
      })
      .finally(() => {
        current.inFlight = null;
      });
    return current.inFlight;
  }
  async poll(
    id: string,
    actor: Actor,
    sessionAlive: () => boolean,
    onCommit?: (connectionId: string) => void,
  ): Promise<BaiduDeviceFlow> {
    const flow = this.owned(id, actor);
    if (!flow) return this.completedOrExpired(id, actor);
    const view = this.view(flow);
    if (view.status !== 'PENDING') return view;
    if (flow.inFlight) return flow.inFlight;
    if (this.now() < view.nextPollAt) return view;
    flow.inFlight = this.advance(flow, sessionAlive, onCommit).finally(() => {
      flow.inFlight = null;
    });
    return flow.inFlight;
  }
  cancel(id: string, actor: Actor): BaiduDeviceFlow {
    const flow = this.owned(id, actor);
    if (!flow) return this.completedOrExpired(id, actor);
    if (this.view(flow).status === 'PENDING') this.finish(flow, 'CANCELLED');
    return this.view(flow);
  }
  private async advance(
    flow: Flow,
    sessionAlive: () => boolean,
    onCommit?: (connectionId: string) => void,
  ): Promise<BaiduDeviceFlow> {
    let saving = false;
    try {
      if (!sessionAlive()) {
        this.finish(flow, 'FAILED', 'SESSION_EXPIRED');
        return this.view(flow);
      }
      if (!flow.token) {
        const answer = await this.options.transport.poll(flow.grant!.deviceCode);
        if (this.view(flow).status !== 'PENDING') return this.view(flow);
        if (answer.status === 'EXPIRED') this.finish(flow, 'EXPIRED');
        else if (answer.status === 'DENIED') this.finish(flow, 'FAILED', 'AUTHORIZATION_DENIED');
        else if (answer.status === 'AUTHORIZED') flow.token = answer.token;
        else {
          if (answer.status === 'SLOW_DOWN') flow.grant!.intervalMs += 5000;
          flow.dto.nextPollAt = this.now() + flow.grant!.intervalMs;
          flow.dto.failureCode = null;
          return this.view(flow);
        }
      }
      if (this.view(flow).status !== 'PENDING') return this.view(flow);
      const exchanged = await this.options.inspect(flow.token!);
      if (this.view(flow).status !== 'PENDING') return this.view(flow);
      if (!sessionAlive()) {
        this.finish(flow, 'FAILED', 'SESSION_EXPIRED');
        return this.view(flow);
      }
      if (exchanged.provider !== 'BAIDU' || exchanged.clientId !== this.options.clientId)
        throw new CloudConnectionError('IDENTITY_MISMATCH', 409);
      // Device login validates basic source access only, never deletion or share authority.
      const safeExchange = {
        ...exchanged,
        capabilities: [
          'SOURCE_BROWSE',
          'SOURCE_DOWNLOAD',
        ] as OAuthTokenExchangeResult['capabilities'],
        provisionState: 'NOT_REQUESTED' as const,
      };
      saving = true;
      const result = this.options.cloud.receipts.executeSync(
        this.completionScope(flow.dto.flowId, flow.actor),
        () => {
          const connectionId = saveOAuthConnection({
            connections: this.options.cloud.repository,
            secrets: this.options.cloud.secrets,
            exchanged: safeExchange,
            target: flow.target,
            ...(this.options.profile ? { baiduClientProfile: this.options.profile } : {}),
            now: this.now,
          });
          onCommit?.(connectionId);
          return {
            statusCode: 200,
            body: BaiduDeviceFlowSchema.parse({
              ...flow.dto,
              status: 'COMPLETED',
              userCode: null,
              verificationUrl: null,
              completedConnectionId: connectionId,
              failureCode: null,
              nextPollAt: 0,
            }),
          };
        },
      );
      flow.dto = BaiduDeviceFlowSchema.parse(result.response.body);
      flow.grant = null;
      flow.token = null;
      this.options.cloud.refresh.invalidate(flow.dto.completedConnectionId!);
    } catch (error) {
      if (this.view(flow).status !== 'PENDING') return this.view(flow);
      if (error instanceof CloudConnectionError) this.finish(flow, 'FAILED', 'IDENTITY_MISMATCH');
      else if (error instanceof BaiduDeviceError && error.code !== 'DEVICE_NETWORK_RETRYABLE')
        this.finish(flow, 'FAILED', 'PROVIDER_REJECTED');
      else if (
        error instanceof Error &&
        /^(?:AUTH_LEGACY_TOKEN_EXPIRED|BAIDU_(?:AUTH_EXPIRED|IDENTITY_MISMATCH|BROWSE_CAPABILITY_UNAVAILABLE|BROWSE_RESPONSE_INVALID|IDENTITY_RESPONSE_INVALID|PROVIDER_RESPONSE_INVALID|PROVIDER_RESPONSE_TOO_LARGE|PROVIDER_URL_REJECTED))$/.test(
          error.message,
        )
      )
        this.finish(flow, 'FAILED', 'PROVIDER_REJECTED');
      else {
        flow.dto.failureCode = saving ? 'SAVE_RETRYABLE' : 'NETWORK_RETRYABLE';
        flow.dto.nextPollAt = Math.max(
          this.now() + Math.max(5000, flow.grant!.intervalMs),
          error instanceof CloudProviderRateLimitError
            ? (parseProviderRetryAfter(error.retryAfter, this.now()) ?? this.now() + 30000)
            : 0,
        );
      }
    }
    return this.view(flow);
  }
  private completionScope(id: string, actor: Actor): CloudConnectionOperationScope {
    return {
      adminId: actor.adminId,
      operation: 'START_OAUTH',
      resourceId: `baidu-device-complete:${id}`,
      idempotencyKey: id,
      requestFingerprint: fingerprintCloudConnectionOperation({ id, ...actor }),
    };
  }
  private completedOrExpired(id: string, actor: Actor): BaiduDeviceFlow {
    const result = this.options.cloud.receipts.lookupCompleted(this.completionScope(id, actor));
    if (result) return BaiduDeviceFlowSchema.parse(result.body);
    return {
      flowId: id,
      status: 'EXPIRED',
      userCode: null,
      verificationUrl: null,
      expiresAt: this.now(),
      nextPollAt: 0,
      completedConnectionId: null,
      failureCode: 'DEVICE_FLOW_RESTARTED',
    };
  }
  private owned(id: string, actor: Actor): Flow | undefined {
    const flow = this.flows.get(id);
    if (
      flow &&
      (flow.actor.adminId !== actor.adminId || flow.actor.sessionHash !== actor.sessionHash)
    )
      throw new CloudConnectionError('SESSION_MISMATCH', 403);
    return flow;
  }
  private view(flow: Flow): BaiduDeviceFlow {
    if (flow.dto.status === 'PENDING' && this.now() >= flow.dto.expiresAt)
      this.finish(flow, 'EXPIRED');
    return BaiduDeviceFlowSchema.parse(flow.dto);
  }
  private finish(
    flow: Flow,
    status: BaiduDeviceFlow['status'],
    failureCode: BaiduDeviceFlow['failureCode'] = null,
  ): void {
    flow.dto = {
      ...flow.dto,
      status,
      failureCode,
      userCode: null,
      verificationUrl: null,
      nextPollAt: 0,
    };
    flow.grant = null;
    flow.token = null;
  }
  private reap(): void {
    for (const [key, intent] of this.starts)
      if (!intent.inFlight && intent.expiresAt <= this.now()) {
        if (intent.flow?.inFlight) continue;
        if (intent.flow) {
          this.finish(
            intent.flow,
            intent.flow.dto.status === 'PENDING' ? 'EXPIRED' : intent.flow.dto.status,
            intent.flow.dto.failureCode,
          );
          this.flows.delete(intent.flow.dto.flowId);
        }
        this.starts.delete(key);
      }
  }
}
