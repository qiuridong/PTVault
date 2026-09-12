import type {
  CloudConnection,
  CloudConnectionCapability,
  CloudConnectionProvisionState,
  CloudProvider,
} from '@ptvault/contracts';

const SOURCE_CAPABILITIES = new Set<CloudConnectionCapability>([
  'SOURCE_BROWSE',
  'SOURCE_DOWNLOAD',
  'SHARE_TRANSFER',
  'SOURCE_DELETE',
]);

const DESTINATION_CAPABILITIES = new Set<CloudConnectionCapability>([
  'ARCHIVE_DESTINATION',
  'JELLYFIN_MOUNT',
  'RECOVERY_ELIGIBLE',
  'RECOVERY_ACTIVE',
]);

/** Validate provider evidence before it can be stored as server-side input. */
export function validateCloudCapabilityEvidence(input: {
  provider: CloudProvider;
  provisionState: CloudConnectionProvisionState;
  capabilities: readonly CloudConnectionCapability[];
}): void {
  const unique = new Set(input.capabilities);
  if (unique.size !== input.capabilities.length) throw matrixError();
  const allowed = input.provider === 'BAIDU' ? SOURCE_CAPABILITIES : DESTINATION_CAPABILITIES;
  if (input.capabilities.some((capability) => !allowed.has(capability))) throw matrixError();
  if (
    input.provider === 'ONEDRIVE' &&
    input.provisionState !== 'READY' &&
    input.capabilities.length > 0
  ) {
    throw matrixError();
  }
}

/**
 * Turn stored adapter evidence into the public server authority. In particular,
 * OneDrive OAuth evidence alone grants no role: the deployment runtime, READY
 * provisioning, verified escrow/crypt roundtrip and a healthy bound account are
 * all required. Mount and active-recovery roles require their own live evidence.
 */
export function deriveCloudConnectionCapabilities(input: {
  provider: CloudProvider;
  authState: CloudConnection['authState'];
  provisionState: CloudConnectionProvisionState;
  evidence: readonly CloudConnectionCapability[];
  oneDriveRuntimeConfigured: boolean;
  verifiedHealthyStorageBinding: boolean;
  healthyMountBinding: boolean;
  activeRecoveryCopy: boolean;
}): CloudConnectionCapability[] {
  validateCloudCapabilityEvidence({
    provider: input.provider,
    provisionState: input.provisionState,
    capabilities: input.evidence,
  });
  // Capability means the role is usable now, not merely that an adapter once
  // advertised it. Disabled, reauthorization-required and error connections
  // therefore expose no source or destination authority.
  if (input.authState !== 'CONNECTED') return [];
  if (input.provider === 'BAIDU') return [...input.evidence];
  if (
    !input.oneDriveRuntimeConfigured ||
    input.provisionState !== 'READY' ||
    !input.verifiedHealthyStorageBinding
  ) {
    return [];
  }
  return input.evidence.filter((capability) => {
    if (capability === 'JELLYFIN_MOUNT') return input.healthyMountBinding;
    if (capability === 'RECOVERY_ACTIVE') return input.activeRecoveryCopy;
    return capability === 'ARCHIVE_DESTINATION' || capability === 'RECOVERY_ELIGIBLE';
  });
}

function matrixError(): Error {
  return new Error('CLOUD_CAPABILITY_MATRIX_INVALID');
}
