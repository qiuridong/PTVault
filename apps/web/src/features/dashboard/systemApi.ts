import { SystemMetricsSchema, type SystemMetrics } from '@ptvault/contracts';

import { apiGet } from '../../api/client.js';

export const systemMetricsQueryKey = ['system', 'metrics'] as const;

export async function getSystemMetrics(): Promise<SystemMetrics> {
  return apiGet('/api/system/metrics', SystemMetricsSchema);
}
