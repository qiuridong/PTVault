import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ContractError } from '../api/client.js';

type ProvidersProps = {
  children: ReactNode;
};

/** TanStack's own default; restated because the callback replaces it. */
const MAX_QUERY_ATTEMPTS = 3;

/**
 * Retry transport failures, never contract failures.
 *
 * A body that fails its schema fails the same way every time, so the default
 * three attempts buy nothing and cost the whole backoff window — during which
 * `isPending` is still true and the page is indistinguishable from a slow load.
 * On a console whose job is to answer "is my data safe", "the API and this page
 * disagree about the shape of the answer" has to arrive as an error, promptly.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ContractError) return false;
  return failureCount < MAX_QUERY_ATTEMPTS;
}

export function Providers({ children }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: retryQuery },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
