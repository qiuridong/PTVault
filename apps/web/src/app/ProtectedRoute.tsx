import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

import { ApiError } from '../api/client.js';
import { getSession, sessionQueryKey } from '../features/auth/authApi.js';
import { currentReturnTo, endBrowserSession } from '../features/auth/sessionLifecycle.js';

type ProtectedRouteProps = {
  children?: ReactNode;
};

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const returnTo = currentReturnTo(location);
  const [expiryRefreshing, setExpiryRefreshing] = useState(false);
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });

  const sessionExpired = session.data !== undefined && session.data.expiresAt <= Date.now();
  const unauthorized = session.error instanceof ApiError && session.error.status === 401;
  const expiredSessionEnded = sessionExpired && !session.isFetching && !session.isError;

  /**
   * Whether the server has confirmed this session during this mount.
   *
   * Cached session data must never gate protected content on its own, so the
   * first fetch of a mount still withholds children. But once the server has
   * answered, later background revalidations (window focus, reconnect) must not
   * tear the tree down: unmounting discards open dialogs, half-filled forms and
   * scroll position every time the operator alt-tabs away and back.
   */
  const revalidated = useRef(false);
  if (session.isSuccess && !session.isFetching) revalidated.current = true;
  if (session.isError) revalidated.current = false;

  useEffect(() => {
    if (unauthorized || expiredSessionEnded) {
      endBrowserSession(queryClient, navigate, returnTo);
    }
  }, [expiredSessionEnded, navigate, queryClient, returnTo, unauthorized]);

  useEffect(() => {
    const expiresAt = session.data?.expiresAt;
    if (expiresAt === undefined) return;

    setExpiryRefreshing(false);
    let timer: number | undefined;
    const schedule = (): void => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        setExpiryRefreshing(true);
        if (queryClient.isFetching({ queryKey: sessionQueryKey }) === 0) {
          void session.refetch();
        }
        return;
      }
      timer = window.setTimeout(schedule, Math.min(remaining, 2_147_000_000));
    };
    schedule();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [queryClient, session.data?.expiresAt, session.refetch]);

  // Nothing server-confirmed yet in this mount — including the case where cached
  // data is present but its revalidation is still in flight.
  //
  // `sessionExpired` blocks too, even after a successful revalidation: once the
  // clock passes `expiresAt` the cached principal is worthless however it was
  // obtained, so content must be withheld until a fresh answer arrives (which is
  // the in-flight-past-expiry case, not covered by `expiredSessionEnded`).
  if ((!revalidated.current || sessionExpired) && !session.isError) {
    return (
      <div className="route-status" role="status" aria-live="polite">
        Checking session
      </div>
    );
  }

  if (unauthorized || expiredSessionEnded) {
    return (
      <div className="route-status" role="status" aria-live="polite">
        Session ended
      </div>
    );
  }

  if (session.isError) {
    return (
      <main className="route-status route-status-error">
        <p role="alert">The session could not be checked.</p>
        <button type="button" onClick={() => void session.refetch()}>
          Try again
        </button>
      </main>
    );
  }

  if (expiryRefreshing) {
    return (
      <div className="route-status" role="status" aria-live="polite">
        Checking session
      </div>
    );
  }

  return <>{children ?? <Outlet />}</>;
}
