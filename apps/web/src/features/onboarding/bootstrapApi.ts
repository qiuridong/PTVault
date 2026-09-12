import {
  BootstrapBeginSchema,
  BootstrapCompleteSchema,
  BootstrapCompleteResultSchema,
  BootstrapEnrollmentSchema,
  BootstrapStatusSchema,
} from '@ptvault/contracts';

import { apiGet, apiMutation } from '../../api/client.js';

export const bootstrapQueryKey = ['setup', 'bootstrap'] as const;

export function getBootstrapStatus() {
  return apiGet('/api/setup/bootstrap', BootstrapStatusSchema);
}

export function beginBootstrap(input: { setupToken: string; username: string }) {
  return apiMutation('/api/setup/bootstrap/begin', BootstrapBeginSchema.parse(input), BootstrapEnrollmentSchema);
}

export function completeBootstrap(input: {
  setupToken: string;
  enrollmentId: string;
  password: string;
  code: string;
}) {
  return apiMutation(
    '/api/setup/bootstrap/complete',
    BootstrapCompleteSchema.parse(input),
    BootstrapCompleteResultSchema,
  );
}
