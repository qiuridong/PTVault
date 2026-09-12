import type { QueryClient } from '@tanstack/react-query';
import type { Location, NavigateFunction } from 'react-router-dom';

export function currentReturnTo(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  return `${location.pathname}${location.search}${location.hash}` || '/';
}

function isInternalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\r\n]/.test(value)
  );
}

export function returnToFromState(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  return isInternalPath(returnTo) ? returnTo : undefined;
}

export function endBrowserSession(
  queryClient: QueryClient,
  navigate: NavigateFunction,
  returnTo?: string,
): void {
  queryClient.clear();
  if (returnTo) {
    void navigate('/login', { replace: true, state: { returnTo } });
  } else {
    void navigate('/login', { replace: true });
  }
}
