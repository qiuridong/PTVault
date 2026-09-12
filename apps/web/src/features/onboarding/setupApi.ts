import {
  SetupOverviewSchema,
  SetupPathCheckResultSchema,
  SetupSaveResultSchema,
  type SetupConfigPatch,
} from '@ptvault/contracts';
import { apiControlMutation, apiGet, apiMutation } from '../../api/client.js';

export const setupOverviewKey = ['setup', 'overview'] as const;
export const getSetupOverview = () => apiGet('/api/setup/overview', SetupOverviewSchema);
export const saveSetup = (body: SetupConfigPatch, idempotencyKey: string) =>
  apiControlMutation('/api/setup/configuration', body, SetupSaveResultSchema, {
    idempotencyKey,
    method: 'PATCH',
    allowedStatus: [202],
  });
export const applySetup = (revision: number, mfaCode: string) =>
  apiMutation('/api/setup/apply', { revision, mfaCode }, SetupSaveResultSchema);
export const checkSetupPath = (
  input: { kind: 'SPOOL' } | { kind: 'SOURCE'; path: string; pathMaps: string[] },
) => apiMutation('/api/setup/paths/check', input, SetupPathCheckResultSchema);
