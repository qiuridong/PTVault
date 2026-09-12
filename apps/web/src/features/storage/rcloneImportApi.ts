import {
  RcloneImportPendingSchema,
  RcloneImportPreviewRequestSchema,
  RcloneImportPreviewSchema,
  RcloneImportRequestSchema,
  RcloneImportResultSchema,
  type RcloneImportRequest,
} from '@ptvault/contracts';
import { apiControlMutation, apiGet, apiMutation } from '../../api/client.js';
const base = '/api/setup/rclone-import';
export const getPendingRcloneImports = () => apiGet(`${base}/pending`, RcloneImportPendingSchema);
export const previewRcloneImport = (path: string) =>
  apiMutation(
    `${base}/preview`,
    RcloneImportPreviewRequestSchema.parse({ path }),
    RcloneImportPreviewSchema,
  );
export const commitRcloneImport = (body: RcloneImportRequest, key: string) =>
  apiControlMutation(
    `${base}/commit`,
    RcloneImportRequestSchema.parse(body),
    RcloneImportResultSchema,
    { idempotencyKey: key },
  );
