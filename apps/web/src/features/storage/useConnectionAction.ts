import type { CloudConnection } from '@ptvault/contracts';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { newIdempotencyKey } from '../../api/client.js';
import {
  disableConnection,
  disconnectConnection,
  enableConnection,
  testConnection,
  updateConnection,
  type Answer,
} from './connectionApi.js';
import {
  presentConnectionError,
  type ConnectionErrorPresentation,
  type ConnectionMutationAction,
} from './cloudConnectionViewModel.js';

export type ConnectionActionController = {
  label: string;
  setLabel: (value: string) => void;
  mfaCode: string;
  setMfaCode: (value: string) => void;
  submit: () => void;
  pending: boolean;
  error: ConnectionErrorPresentation | null;
  revisionRefreshed: boolean;
};

export function useConnectionAction(input: {
  action: ConnectionMutationAction;
  connection: CloudConnection;
  onReload: () => void;
  onCompleted: (connection: CloudConnection) => void;
}): ConnectionActionController {
  const { action, connection, onReload, onCompleted } = input;
  const [label, setLabelState] = useState(connection.label);
  const [mfaCode, setMfaCodeState] = useState('');
  const [baseRevision, setBaseRevision] = useState(connection.revision);
  const [error, setError] = useState<ConnectionErrorPresentation | null>(null);
  const [revisionRefreshed, setRevisionRefreshed] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const currentConnectionId = useRef(connection.id);

  // A new dialog intent starts clean. Revision-only refreshes are handled below
  // so an edit draft survives the CAS conflict that caused the reload.
  useEffect(() => {
    if (currentConnectionId.current === connection.id) return;
    currentConnectionId.current = connection.id;
    setLabelState(connection.label);
    setMfaCodeState('');
    setBaseRevision(connection.revision);
    setError(null);
    setRevisionRefreshed(false);
    idempotencyKey.current = null;
  }, [connection.id, connection.label, connection.revision]);

  useEffect(() => {
    if (connection.revision === baseRevision) return;
    setBaseRevision(connection.revision);
    setRevisionRefreshed(true);
    idempotencyKey.current = null;
  }, [baseRevision, connection.revision]);

  const mutation = useMutation({
    mutationFn: async (): Promise<Answer<CloudConnection>> => {
      const operationKey = (idempotencyKey.current ??= newIdempotencyKey());
      const common = {
        id: connection.id,
        revision: baseRevision,
        mfaCode,
        idempotencyKey: operationKey,
      };
      switch (action) {
        case 'TEST':
          return testConnection(common);
        case 'EDIT':
          return updateConnection({ ...common, label: label.trim() });
        case 'ENABLE':
          return enableConnection(common);
        case 'DISABLE':
          return disableConnection(common);
        case 'DISCONNECT':
          return disconnectConnection(common);
      }
    },
    onSuccess: (answer) => {
      setMfaCodeState('');
      if (!answer.supported) {
        setError(
          answer.reason === 'ROUTE_ABSENT'
            ? {
                message: '这台服务端还没有云盘连接操作路由；操作没有发生。',
                references: [],
                revisionConflict: false,
                idempotencyConflict: false,
                retrySameIntent: false,
              }
            : {
                message: `这台服务端尚未启用云盘连接操作（HTTP ${answer.status}）。`,
                references: [],
                revisionConflict: false,
                idempotencyConflict: false,
                retrySameIntent: false,
              },
        );
        return;
      }
      idempotencyKey.current = null;
      setError(null);
      onCompleted(answer.data);
    },
    onError: (caught) => {
      const presentation = presentConnectionError(caught);
      setMfaCodeState('');
      setError(presentation);
      if (presentation.idempotencyConflict || presentation.revisionConflict) {
        idempotencyKey.current = null;
      }
      if (presentation.revisionConflict) onReload();
    },
  });

  const setLabel = useCallback((value: string) => {
    setLabelState(value);
    setError(null);
    // Label is part of the server fingerprint. A changed draft is a new intent.
    idempotencyKey.current = null;
  }, []);

  const setMfaCode = useCallback((value: string) => {
    setMfaCodeState(value.replace(/\D/g, '').slice(0, 6));
    setError(null);
    // MFA is deliberately excluded from the server fingerprint, so correcting a
    // code retains the same key and therefore the same business intent.
  }, []);

  const submit = useCallback(() => {
    if (!/^\d{6}$/.test(mfaCode)) {
      setError({
        message: '请输入 6 位动态验证码。',
        references: [],
        revisionConflict: false,
        idempotencyConflict: false,
        retrySameIntent: false,
      });
      return;
    }
    if (action === 'EDIT' && (label.trim().length < 1 || label.trim().length > 64)) {
      setError({
        message: '连接名称应为 1–64 个字符。',
        references: [],
        revisionConflict: false,
        idempotencyConflict: false,
        retrySameIntent: false,
      });
      return;
    }
    setError(null);
    mutation.mutate();
  }, [action, label, mfaCode, mutation]);

  return {
    label,
    setLabel,
    mfaCode,
    setMfaCode,
    submit,
    pending: mutation.isPending,
    error,
    revisionRefreshed,
  };
}
