/** Only the separately frozen schema40 rollback artifact sets this to true. */
export const recoveryPreparationCompatibilityReadOnly: boolean = false;

export function preparationCompatibilityAllows(method: string, route: string): boolean {
  if (method === 'POST' && ['/api/auth/login', '/api/auth/mfa', '/api/auth/logout'].includes(route))
    return true;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return false;
  return (
    route !== '/api/storage/connections/oauth/callback/:provider' &&
    route !== '/api/storage/connections/:id/browse' &&
    route !== '/api/storage/connections/:id/search' &&
    route !== '/api/storage/connections/oauth/flows/:flowId'
  );
}
