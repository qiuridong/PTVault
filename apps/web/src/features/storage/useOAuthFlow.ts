import type {
  CloudOAuthFailureCode,
  CloudOAuthFlow,
  CloudOAuthReturnTo,
  CloudProvider,
} from '@ptvault/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { OAUTH_FAILURE_LABELS } from './connectionLabels.js';
import { pollOAuthFlow, reauthorizeConnection, startOAuth } from './connectionApi.js';
import { presentConnectionError } from './cloudConnectionViewModel.js';

export type OAuthUiState =
  | { kind: 'IDLE' }
  | { kind: 'STARTING' }
  | { kind: 'AWAITING_AUTHORIZATION'; authorizationUrl: string }
  | { kind: 'PROCESSING'; authorizationUrl: string }
  | { kind: 'POPUP_BLOCKED'; authorizationUrl: string }
  | { kind: 'POPUP_CLOSED' }
  | { kind: 'CANCELLED' }
  | { kind: 'COMPLETED'; connectionId: string | null }
  | { kind: 'PROVISION_FAILED'; connectionId: string | null }
  | { kind: 'EXPIRED' }
  | { kind: 'USED' }
  | { kind: 'ROUTE_ABSENT' }
  | { kind: 'NOT_ENABLED'; status: number }
  | { kind: 'FAILED'; message: string };

export type OAuthCompletion =
  | { kind: 'COMPLETED'; connectionId: string | null }
  | { kind: 'PROVISION_FAILED'; connectionId: string | null };

export type OAuthFlowIntent = {
  provider: CloudProvider;
  returnTo: CloudOAuthReturnTo;
  reauthorize?: { connectionId: string; revision: number } | undefined;
  onCompleted?: ((completion: OAuthCompletion) => void) | undefined;
};

export type OAuthFlowController = {
  state: OAuthUiState;
  begin: (mfaCode: string) => void;
  reset: () => void;
};

const POLL_INTERVAL_MS = 700;
const ACTIVE_STATES: ReadonlySet<OAuthUiState['kind']> = new Set([
  'AWAITING_AUTHORIZATION',
  'PROCESSING',
  'POPUP_BLOCKED',
]);

function failureState(failure: CloudOAuthFailureCode | null): OAuthUiState {
  switch (failure) {
    case 'USER_CANCELLED':
      return { kind: 'CANCELLED' };
    case 'NOT_PROVISIONED':
      // The caller fills the canonical completed connection id.
      return { kind: 'PROVISION_FAILED', connectionId: null };
    case 'FLOW_EXPIRED':
      return { kind: 'EXPIRED' };
    case 'FLOW_ALREADY_USED':
      return { kind: 'USED' };
    case null:
      return { kind: 'FAILED', message: '授权没有完成，请发起新流程。' };
    default:
      return { kind: 'FAILED', message: OAUTH_FAILURE_LABELS[failure] };
  }
}

/**
 * Drives the canonical one-shot flow. Only `flowId` and the provider URL live in
 * component memory; callback messages are same-origin wakeups and never trusted
 * as results—the next server poll remains authoritative.
 */
export function useOAuthFlow(input: OAuthFlowIntent): OAuthFlowController {
  const { provider, returnTo, reauthorize, onCompleted } = input;
  const [state, setState] = useState<OAuthUiState>({ kind: 'IDLE' });
  const [wakeRevision, setWakeRevision] = useState(0);
  const flowId = useRef<string | null>(null);
  const authorizationUrl = useRef<string | null>(null);
  const popup = useRef<Window | null>(null);
  const startKey = useRef<string | null>(null);
  const notified = useRef(false);
  const polling = useRef(false);
  const mounted = useRef(true);
  const completedRef = useRef(onCompleted);
  const intentFingerprint = `${provider}|${returnTo}|${
    reauthorize?.connectionId ?? 'new'
  }|${reauthorize?.revision ?? '-'}`;
  const previousIntent = useRef(intentFingerprint);

  useEffect(() => {
    if (previousIntent.current === intentFingerprint) return;
    previousIntent.current = intentFingerprint;
    startKey.current = null;
  }, [intentFingerprint]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      popup.current?.close();
      popup.current = null;
    };
  }, []);

  useEffect(() => {
    completedRef.current = onCompleted;
  }, [onCompleted]);

  const reset = useCallback(() => {
    popup.current?.close();
    popup.current = null;
    flowId.current = null;
    authorizationUrl.current = null;
    startKey.current = null;
    notified.current = false;
    polling.current = false;
    setState({ kind: 'IDLE' });
  }, []);

  const begin = useCallback(
    (mfaCode: string) => {
      if (!/^\d{6}$/.test(mfaCode)) {
        setState({ kind: 'FAILED', message: '请输入 6 位动态验证码。' });
        return;
      }

      // Synchronous pre-open preserves the user gesture. The callback message is
      // accepted only from this origin and is only a poll wakeup, never a result.
      const opened = window.open('about:blank', 'ptvault-oauth', 'popup=yes,width=560,height=720');
      popup.current = opened;
      flowId.current = null;
      authorizationUrl.current = null;
      notified.current = false;
      setState({ kind: 'STARTING' });

      void (async () => {
        try {
          const idempotencyKey = (startKey.current ??= newIdempotencyKey());
          const started =
            reauthorize === undefined
              ? await startOAuth({ provider, returnTo, mfaCode, idempotencyKey })
              : await reauthorizeConnection({
                  id: reauthorize.connectionId,
                  revision: reauthorize.revision,
                  returnTo,
                  mfaCode,
                  idempotencyKey,
                });

          if (!mounted.current) {
            opened?.close();
            return;
          }

          if (!started.supported) {
            opened?.close();
            popup.current = null;
            setState(
              started.reason === 'ROUTE_ABSENT'
                ? { kind: 'ROUTE_ABSENT' }
                : { kind: 'NOT_ENABLED', status: started.status },
            );
            return;
          }

          // A canonical start response is the durable receipt for this intent.
          // A later fresh flow must therefore receive a fresh key.
          startKey.current = null;
          flowId.current = started.data.flowId;
          authorizationUrl.current = started.data.authorizationUrl;
          if (opened === null) {
            setState({ kind: 'POPUP_BLOCKED', authorizationUrl: started.data.authorizationUrl });
            return;
          }
          try {
            opened.location.assign(started.data.authorizationUrl);
          } catch {
            // Cross-origin navigation can throw in restrictive test/browser
            // environments. The visible fallback link and polling remain valid.
            opened.close();
            popup.current = null;
            setState({ kind: 'POPUP_BLOCKED', authorizationUrl: started.data.authorizationUrl });
            return;
          }
          setState({
            kind: 'AWAITING_AUTHORIZATION',
            authorizationUrl: started.data.authorizationUrl,
          });
        } catch (error) {
          opened?.close();
          popup.current = null;
          if (!mounted.current) return;
          const presented = presentConnectionError(error);
          if (presented.idempotencyConflict) startKey.current = null;
          setState({ kind: 'FAILED', message: presented.message });
        }
      })();
    },
    [provider, reauthorize, returnTo],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin) return;
      if (popup.current !== null && event.source !== popup.current) return;
      const value = event.data;
      if (typeof value !== 'object' || value === null) return;
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || record.type !== 'ptvault:oauth-callback') return;
      setWakeRevision((current) => current + 1);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ACTIVE_STATES.has(state.kind)) return;
    const id = flowId.current;
    if (id === null) return;
    let cancelled = false;

    const apply = (flow: CloudOAuthFlow): void => {
      switch (flow.status) {
        case 'PENDING':
          if (popup.current?.closed === true) {
            popup.current = null;
            setState({ kind: 'POPUP_CLOSED' });
          }
          return;
        case 'PROCESSING':
          setState({
            kind: 'PROCESSING',
            authorizationUrl: authorizationUrl.current ?? '',
          });
          return;
        case 'COMPLETED':
          popup.current?.close();
          popup.current = null;
          setState({ kind: 'COMPLETED', connectionId: flow.completedConnectionId });
          return;
        case 'EXPIRED':
          popup.current?.close();
          popup.current = null;
          setState({ kind: 'EXPIRED' });
          return;
        case 'FAILED': {
          popup.current?.close();
          popup.current = null;
          const failed = failureState(flow.failure);
          setState(
            failed.kind === 'PROVISION_FAILED'
              ? { ...failed, connectionId: flow.completedConnectionId }
              : failed,
          );
        }
      }
    };

    const tick = async (): Promise<void> => {
      if (cancelled || polling.current) return;
      polling.current = true;
      try {
        const result = await pollOAuthFlow(id);
        if (cancelled) return;
        if (!result.supported) {
          setState(
            result.reason === 'ROUTE_ABSENT'
              ? { kind: 'ROUTE_ABSENT' }
              : { kind: 'NOT_ENABLED', status: result.status },
          );
          return;
        }
        apply(result.data);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 410) {
          setState(error.code === 'FLOW_ALREADY_USED' ? { kind: 'USED' } : { kind: 'EXPIRED' });
          return;
        }
        // A dropped poll is not a failed OAuth transaction. Keep the outstanding
        // flow alive and let the next interval—or callback wakeup—ask again.
        if (!(error instanceof TypeError)) {
          setState({ kind: 'FAILED', message: presentConnectionError(error).message });
        }
      } finally {
        polling.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state.kind, wakeRevision]);

  useEffect(() => {
    if (notified.current) return;
    if (state.kind !== 'COMPLETED' && state.kind !== 'PROVISION_FAILED') return;
    notified.current = true;
    completedRef.current?.({ kind: state.kind, connectionId: state.connectionId });
  }, [state]);

  return { state, begin, reset };
}
