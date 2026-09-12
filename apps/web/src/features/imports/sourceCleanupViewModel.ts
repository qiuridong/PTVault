import type { ImportSourceCleanup } from '@ptvault/contracts';

import { SOURCE_CLEANUP_OBJECT_STATUS_LABELS } from './importLabels.js';

/** A journal phase is not a provider receipt. No client intent key enters this projection. */
export function sourceCleanupObjectViewModel(object: ImportSourceCleanup['objects'][number]) {
  const attempted = ['PROVIDER_REQUESTED', 'COMPLETED', 'FOLLOW_UP_REQUIRED'].includes(
    object.status,
  );
  const unverified =
    object.errorCode === 'SOURCE_CLEANUP_OUTCOME_UNKNOWN' ||
    (attempted && (object.providerRequestId === null || object.providerSemantics === null));
  return {
    statusLabel: unverified ? '结果待核实' : SOURCE_CLEANUP_OBJECT_STATUS_LABELS[object.status],
    receiptLabel:
      object.providerRequestId === null
        ? '尚无服务商回执'
        : `服务商回执：${object.providerRequestId}`,
    semanticsLabel: !unverified && object.providerSemantics === 'RECYCLE_BIN' ? '移入回收站' : null,
    errorCode: object.errorCode ?? null,
  };
}

export function sourceCleanupSemanticsLabel(cleanup: ImportSourceCleanup): string {
  return cleanup.providerSemantics === null
    ? '结果待核实（尚无服务商回执）'
    : '已确认对象：移入回收站；其余以逐对象回执为准';
}
