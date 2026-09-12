import { z } from 'zod';

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const AgeRecipientSchema = z.string().regex(/^age1[0-9a-z]{20,100}$/);

export const RecoveryReadinessProblemSchema = z.enum([
  'NO_BASELINE',
  'RECIPIENT_CHANGED',
  'GENERATION_CHANGED',
  'ESCROW_UNAVAILABLE',
  'ESCROW_CHANGED',
  'MATERIAL_UPDATE_IN_PROGRESS',
  'MATERIAL_UNRESOLVED',
  'COMPUTER_NOT_CONFIRMED',
  'DRILL_NOT_CONFIRMED',
  'CLOUD_COPY_QUORUM',
  'STATE_CHANGED',
  'COMPATIBILITY_READ_ONLY',
]);

export const RecoveryStatusSchema = z.object({
  version: z.number().int().positive().nullable(),
  publicRecipientConfigured: z.boolean(),
  computerDownloadConfirmedAt: z.number().int().nullable(),
  escrowVerifiedAt: z.number().int().nullable(),
  cloudCopyAccountIds: z.array(z.string().uuid()),
  deletionUnlocked: z.boolean(),
  escrowConfigured: z.boolean().optional(),
  baselineRevision: z.number().int().nonnegative().optional(),
  materialRevision: z.number().int().nonnegative().optional(),
  latestSnapshotVersion: z.number().int().positive().nullable().optional(),
  readinessProblems: z.array(RecoveryReadinessProblemSchema).optional(),
});

export const RecoveryExportSchema = z.object({
  version: z.number().int().positive(),
  recipientGeneration: z.number().int().positive(),
  publicRecipient: AgeRecipientSchema,
  bundleSha256: Sha256Schema.nullable(),
  escrowSha256: Sha256Schema.nullable(),
  computerConfirmedAt: z.number().int().nullable(),
  computerConfirmedSha256: Sha256Schema.nullable(),
  passphraseVerifiedAt: z.number().int().nullable(),
  passphraseVerifiedSha256: Sha256Schema.nullable(),
  createdAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nullable(),
});

export const RecoveryCloudCopySchema = z.object({
  version: z.number().int().positive(),
  accountId: z.string().uuid(),
  bundleSha256: Sha256Schema,
  escrowSha256: Sha256Schema,
  bundleRemotePath: z.string().min(1),
  escrowRemotePath: z.string().min(1),
  verificationStatus: z.enum(['PENDING', 'VERIFIED', 'FAILED']),
  verifiedAt: z.number().int().nullable(),
  createdAt: z.number().int().nonnegative(),
});

export const ConfigureRecoveryRecipientSchema = z.object({
  publicRecipient: AgeRecipientSchema,
});

export const RecoveryComputerConfirmationSchema = z.object({
  version: z.number().int().positive(),
  bundleSha256: Sha256Schema,
});

export const RecoveryDrillAttestationSchema = z.object({
  version: z.number().int().positive(),
  escrowSha256: Sha256Schema,
});

export const DeletionPermitSchema = z.object({
  kind: z.literal('DELETION_PERMIT'),
  jobId: z.string().min(1),
  recoveryVersion: z.number().int().positive(),
  baselineRevision: z.number().int().nonnegative().optional(),
  materialRevision: z.number().int().nonnegative().optional(),
  issuedAt: z.number().int().nonnegative(),
});

/**
 * A six-digit TOTP code accompanying every recovery mutation.
 *
 * These endpoints decide whether local files may ever be deleted, so a live
 * session alone is not enough authority: a stolen cookie would otherwise be able
 * to point the recipient at a key the attacker holds, or attest a passphrase
 * drill that never happened. The server spends each code once, so replaying a
 * captured one inside its 30-second window fails too.
 */
export const MfaCodeSchema = z.string().regex(/^[0-9]{6}$/);

export const SelectRecoveryBaselineSchema = z.object({
  version: z.number().int().positive().safe(),
  bundleSha256: Sha256Schema,
  escrowSha256: Sha256Schema,
  expectedBaselineRevision: z.number().int().nonnegative().safe(),
  expectedMaterialRevision: z.number().int().nonnegative().safe(),
  mfaCode: MfaCodeSchema,
});

export const ConfigureRecoveryMaterialRecipientSchema = ConfigureRecoveryRecipientSchema.extend({
  expectedMaterialRevision: z.number().int().nonnegative().safe(),
  mfaCode: MfaCodeSchema,
});

/**
 * Base64 of an age file encrypted with a *passphrase*, never to a recipient.
 *
 * The 6 MB ceiling is far above a real escrow (a few hundred bytes) and exists
 * only to bound what a single request can push through base64 decoding.
 */
export const EncryptedEscrowUploadSchema = z.object({
  encryptedEscrowBase64: z.string().min(1).max(6_000_000),
  mfaCode: MfaCodeSchema,
});

export const EscrowUploadResultSchema = z.object({
  escrowSha256: Sha256Schema,
});

/**
 * At least two *distinct* destinations, matching what the deletion gate later
 * demands. One cloud copy is a single point of failure for the material that
 * exists precisely to survive failures.
 */
export const GenerateRecoveryBundleSchema = z.object({
  destinationAccountIds: z.array(z.string().uuid()).min(2),
  mfaCode: MfaCodeSchema,
});

export const RecoveryBundleResultSchema = z.object({
  version: z.number().int().positive(),
  bundleSha256: Sha256Schema,
  escrowSha256: Sha256Schema,
  accountIds: z.array(z.string().uuid()),
});

export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>;
export type RecoveryReadinessProblem = z.infer<typeof RecoveryReadinessProblemSchema>;
export type RecoveryExport = z.infer<typeof RecoveryExportSchema>;
export type RecoveryCloudCopy = z.infer<typeof RecoveryCloudCopySchema>;
export type ConfigureRecoveryRecipient = z.infer<typeof ConfigureRecoveryRecipientSchema>;
export type RecoveryComputerConfirmation = z.infer<typeof RecoveryComputerConfirmationSchema>;
export type RecoveryDrillAttestation = z.infer<typeof RecoveryDrillAttestationSchema>;
export type EncryptedEscrowUpload = z.infer<typeof EncryptedEscrowUploadSchema>;
export type EscrowUploadResult = z.infer<typeof EscrowUploadResultSchema>;
export type GenerateRecoveryBundle = z.infer<typeof GenerateRecoveryBundleSchema>;
export type RecoveryBundleResult = z.infer<typeof RecoveryBundleResultSchema>;
export type DeletionPermit = z.infer<typeof DeletionPermitSchema>;
