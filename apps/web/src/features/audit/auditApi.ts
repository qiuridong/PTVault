import { AuditResponseSchema, type AuditEvent } from '@ptvault/contracts';

import { apiGet } from '../../api/client.js';

export function auditQueryKey(limit: number) {
  return ['audit', limit] as const;
}

export async function getAuditEvents(limit: number): Promise<AuditEvent[]> {
  const response = await apiGet(`/api/audit?limit=${limit}`, AuditResponseSchema);
  return response.events;
}
