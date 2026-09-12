import {
  NetdiskSettingsPatchSchema,
  NetdiskSettingsStatusSchema,
  type NetdiskSettingsPatch,
  type NetdiskSettingsStatus,
} from '@ptvault/contracts';

import { apiControlMutation } from '../../api/client.js';
import { probeGet, type Probe } from '../../api/probe.js';

export const netdiskSettingsQueryKey = ['settings', 'netdisk'] as const;

/** Read the independently versioned netdisk settings projection. */
export function getNetdiskSettings(): Promise<Probe<NetdiskSettingsStatus>> {
  return probeGet('/api/netdisk/settings', NetdiskSettingsStatusSchema);
}

/**
 * Save one CAS-protected settings intent.
 *
 * The input is parsed before transport so no partial or extra field can escape
 * the frozen contract. The idempotency key is a header rather than request data;
 * callers reuse it only while the exact patch body is unchanged.
 */
export function updateNetdiskSettings(input: {
  patch: NetdiskSettingsPatch;
  idempotencyKey: string;
}): Promise<NetdiskSettingsStatus> {
  const patch = NetdiskSettingsPatchSchema.parse(input.patch);
  return apiControlMutation('/api/netdisk/settings', patch, NetdiskSettingsStatusSchema, {
    idempotencyKey: input.idempotencyKey,
    method: 'PATCH',
  });
}
