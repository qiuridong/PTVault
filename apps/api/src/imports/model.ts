import type {
  DecimalBytes,
  ImportDestination,
  ImportPlan,
  ImportPlanConflict,
  ImportPlanLimitIssue,
} from '@ptvault/contracts';
import type { ImportSourceManifest } from './source-manifest.js';

export type {
  CloudConnectionRateLimitCode,
  ImportAction,
  ImportCurrentCondition as ImportCondition,
  ImportDestination,
  ImportDetail,
  ImportEvent,
  ImportJobState,
  ImportJobSummary,
  ImportPlan,
  ImportPlanConflict,
  ImportPlanLimitIssue,
  ImportProgressSnapshot,
  ImportPublication,
  ImportPublicationError,
  ImportPublicationRequest,
  ImportReceipt,
  ImportSourceCleanup,
  ImportSourceCleanupGate,
  ImportSourceCleanupPolicy,
  ImportSourceCleanupPreview,
  ImportShareCredential,
  ImportSourceKind,
  ImportStep,
  JellyfinImportLibrary,
  PublicationPolicy,
  PublicationState,
} from '@ptvault/contracts';

export type DecimalString = DecimalBytes;
export type ImportDestinationKind = ImportDestination['kind'];

/**
 * Private planner output. It intentionally is not part of the browser contract:
 * object discovery and source metadata stay on the server side, while the
 * public plan is parsed with ImportPlanSchema before it leaves the API.
 */
export type PlannerResult = {
  sourceManifest?: ImportSourceManifest;
  sourceAuthState: ImportPlan['sourceAuthState'];
  sourceRequiresPasscode: boolean;
  objectCount: number;
  totalBytes: DecimalBytes;
  largestObjectBytes: DecimalBytes;
  requiredSpoolBytes: DecimalBytes;
  pathConflicts: ImportPlanConflict[];
  destinationLimitIssues: ImportPlanLimitIssue[];
};
