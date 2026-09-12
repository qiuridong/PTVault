import { QbClient } from './client.js';
import type { QbCredentialStore } from './credentials.js';
import type { QbRepository } from './repository.js';
import type { QbControl, QbControlRegistry } from './types.js';

export type DbQbControlRegistryOptions = {
  repository: Pick<QbRepository, 'listInstances' | 'getInstance'>;
  credentials: Pick<QbCredentialStore, 'get' | 'open'>;
  /** Injectable for tests; defaults to constructing a real QbClient. */
  clientFactory?: (options: {
    instanceId: string;
    baseUrl: string;
    username: string;
    password: string;
  }) => QbControl;
};

export class QbRegistryError extends Error {
  constructor(readonly code: 'INSTANCE_NOT_FOUND' | 'CREDENTIAL_NOT_FOUND') {
    super(code);
    this.name = 'QbRegistryError';
  }
}

/**
 * Builds qB clients from database state: `qb_instances` supplies identity/enabled,
 * `qb_instance_secrets` (via secret_ref) supplies the URL and credentials.
 *
 * Clients are constructed per call rather than cached. A cached client would keep
 * serving the old host/password after the user edits credentials in the web UI —
 * the next sync must pick up the change without a service restart. Construction is
 * cheap (no I/O; the session cookie is fetched lazily on first request).
 */
export class DbQbControlRegistry implements QbControlRegistry {
  private readonly repository: DbQbControlRegistryOptions['repository'];
  private readonly credentials: DbQbControlRegistryOptions['credentials'];
  private readonly clientFactory: NonNullable<DbQbControlRegistryOptions['clientFactory']>;

  constructor(options: DbQbControlRegistryOptions) {
    this.repository = options.repository;
    this.credentials = options.credentials;
    this.clientFactory =
      options.clientFactory ??
      ((clientOptions) => new QbClient({ ...clientOptions, environment: 'production' }));
  }

  /** Only enabled instances are listed: a disabled instance must never be polled. */
  listInstanceIds(): readonly string[] {
    return this.repository.listInstances({ enabledOnly: true }).map((instance) => instance.id);
  }

  get(instanceId: string): QbControl {
    const instance = this.repository.getInstance(instanceId);
    if (!instance) throw new QbRegistryError('INSTANCE_NOT_FOUND');

    const credential = this.credentials.get(instance.secretRef);
    if (!credential) throw new QbRegistryError('CREDENTIAL_NOT_FOUND');

    return this.clientFactory({
      instanceId: instance.id,
      baseUrl: credential.baseUrl,
      username: credential.username,
      password: this.credentials.open(credential.encryptedPassword),
    });
  }
}
