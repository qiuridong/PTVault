import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import type { ImportDetail } from '@ptvault/contracts';

import { newIdempotencyKey } from '../../api/client.js';
import { cloudConnectionsQueryKey, getCloudConnections } from '../storage/connectionApi.js';
import {
  bindLegacyImportSource,
  getLegacyImportSourceBinding,
  importDetailQueryKey,
  importsQueryKey,
  legacyImportSourceQueryKey,
  type LegacyImportSourceBindRequest,
} from './importApi.js';
import type { ReadOnlyReason } from './ImportCreatePanel.js';
import {
  legacyBindingMode,
  legacyEnvironmentConnections,
  presentLegacySourceError,
  type LegacySourceError,
} from './legacyImportSourceViewModel.js';

type BindingIntent = {
  key: string;
  // MFA never enters an intent, query cache, mutation cache or persistent storage.
  request: Omit<LegacyImportSourceBindRequest, 'stepUpCode'>;
};

export function useLegacyImportSource(detail: ImportDetail, readOnlyReason: ReadOnlyReason) {
  const client = useQueryClient();
  const bindingQuery = useQuery({
    queryKey: legacyImportSourceQueryKey(detail.jobId),
    queryFn: () => getLegacyImportSourceBinding(detail.jobId),
  });
  const binding = bindingQuery.data?.supported === true ? bindingQuery.data.data : null;
  const [error, setError] = useState<LegacySourceError | null>(null);
  const [mutationUnsupported, setMutationUnsupported] = useState(false);
  const mode = error?.replan ? 'REPLAN' : binding === null ? null : legacyBindingMode(binding);
  const connectionsQuery = useQuery({
    queryKey: cloudConnectionsQueryKey,
    queryFn: getCloudConnections,
    enabled: mode === 'SELECT',
  });
  const connections = legacyEnvironmentConnections(
    connectionsQuery.data?.supported === true ? connectionsQuery.data.data : undefined,
  );
  const [selectedId, setSelectedId] = useState('');
  const selected = connections.find((connection) => connection.id === selectedId) ?? null;
  const [confirmedIdentity, setConfirmedIdentity] = useState<string | null>(null);
  const [stepUpCode, setStepUpCode] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [intent, setIntent] = useState<BindingIntent | null>(null);
  const intentRef = useRef<BindingIntent | null>(null);
  const identity =
    selected === null
      ? null
      : JSON.stringify([
          detail.jobId,
          detail.progress.revision,
          selected.id,
          selected.revision,
          selected.principalMasked,
        ]);
  const confirmed = identity !== null && identity === confirmedIdentity;
  const replaying = intent !== null && error?.uncertain === true;
  const canSubmit =
    mode === 'SELECT' &&
    !mutationUnsupported &&
    readOnlyReason === null &&
    !pending &&
    !bindingQuery.isFetching &&
    !bindingQuery.isError &&
    !connectionsQuery.isFetching &&
    !connectionsQuery.isError &&
    selected !== null &&
    (replaying || confirmed) &&
    /^\d{6}$/.test(stepUpCode);

  const refreshProjection = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: legacyImportSourceQueryKey(detail.jobId), exact: true }),
      client.invalidateQueries({ queryKey: importDetailQueryKey(detail.jobId), exact: true }),
      client.invalidateQueries({ queryKey: importsQueryKey, exact: true }),
      client.invalidateQueries({ queryKey: cloudConnectionsQueryKey, exact: true }),
    ]);
  };

  const refresh = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setStepUpCode('');
    try {
      await refreshProjection();
      const answer = await client.fetchQuery({
        queryKey: legacyImportSourceQueryKey(detail.jobId),
        queryFn: () => getLegacyImportSourceBinding(detail.jobId),
        staleTime: 1_000,
      });
      if (answer.supported && ['VERIFIED', 'NONE'].includes(legacyBindingMode(answer.data))) {
        setError(null);
        intentRef.current = null;
        setIntent(null);
      }
    } catch (cause) {
      // A GET failure does not erase an unresolved POST's exact replay intent.
      if (intentRef.current === null) setError(presentLegacySourceError(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const submit = async () => {
    if (!canSubmit || pendingRef.current || selected === null) return;
    pendingRef.current = true;
    setPending(true);
    const currentIntent =
      replaying && intentRef.current !== null
        ? intentRef.current
        : {
            key: newIdempotencyKey(),
            request: {
              sourceConnectionId: selected.id,
              expectedRevision: detail.progress.revision,
              confirmSameSourceIdentity: true as const,
            },
          };
    intentRef.current = currentIntent;
    setIntent(currentIntent);
    setError(null);
    const proof = stepUpCode;
    setStepUpCode('');
    try {
      const answer = await bindLegacyImportSource(
        detail.jobId,
        { ...currentIntent.request, stepUpCode: proof },
        currentIntent.key,
      );
      intentRef.current = null;
      setIntent(null);
      setConfirmedIdentity(null);
      if (!answer.supported) {
        setMutationUnsupported(true);
        return;
      }
      client.setQueryData(legacyImportSourceQueryKey(detail.jobId), answer);
      await refreshProjection();
    } catch (cause) {
      const presentation = presentLegacySourceError(cause);
      setError(presentation);
      if (!presentation.uncertain) {
        intentRef.current = null;
        setIntent(null);
        setConfirmedIdentity(null);
      }
      if (presentation.refresh) await refreshProjection();
    } finally {
      setStepUpCode('');
      pendingRef.current = false;
      setPending(false);
    }
  };

  return {
    binding,
    bindingQuery,
    connectionsQuery,
    connections,
    selectedId,
    selected,
    mode,
    error,
    pending,
    replaying,
    confirmed,
    stepUpCode,
    canSubmit,
    mutationUnsupported,
    expectedRevision: replaying ? intent.request.expectedRevision : detail.progress.revision,
    selectConnection: (id: string) => {
      if (pendingRef.current || replaying) return;
      setSelectedId(id);
      setConfirmedIdentity(null);
      setStepUpCode('');
    },
    confirm: (value: boolean) => {
      if (!pendingRef.current && !replaying) setConfirmedIdentity(value ? identity : null);
    },
    setStepUpCode,
    submit,
    refresh,
  };
}
