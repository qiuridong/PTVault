/**
 * The API and Web parse the same Zod objects. Keeping this module as a narrow
 * re-export preserves the imports used by the server while making a second,
 * drifting request-schema mirror impossible.
 */
export {
  CreateImportRequestSchema,
  ImportCredentialsRequestSchema,
  ImportPlanRequestSchema,
  ImportPublicationRequestSchema,
  ImportSourceCleanupExecuteRequestSchema,
  ImportSourceCleanupPreviewRequestSchema,
  ImportShareCredentialSchema as ImportShareCredentialRequestSchema,
  MediaPublicationRequestSchema,
} from '@ptvault/contracts';

export type {
  CreateImportRequest,
  ImportCredentialsRequest,
  ImportPlanRequest,
  ImportSourceCleanupExecuteRequest,
  ImportSourceCleanupPreviewRequest,
  MediaPublicationRequest,
} from '@ptvault/contracts';
