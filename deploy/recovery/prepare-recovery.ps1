<#
.SYNOPSIS
  PT Cloud Vault — operator-side recovery-key preparation (Windows / PowerShell 7+).

.DESCRIPTION
  Run this on YOUR OWN computer, never on the VPS. It:
    1. generates an age keypair locally,
    2. writes ONLY the public recipient (age1...) for you to enroll on the VPS,
    3. wraps the private key in a passphrase-encrypted escrow (age scrypt),
    4. verifies the escrow decrypts back to the SAME recipient,
    5. removes temporary plaintext keys (physical erasure is not guaranteed).

  The plaintext private key and your passphrase never leave this machine and
  never appear in argv or logs. Keys temporarily exist in a private directory.
  Real age reads the passphrase itself from the interactive console.

.PARAMETER OutputDirectory
  Where recovery-recipient.txt and recovery-key.age are written.
  Defaults to .\ptvault-recovery

.NOTES
  After it finishes, upload TWO things to your VPS enrollment step:
    - recovery-recipient.txt  (safe to share; this is the public key)
    - recovery-key.age        (the passphrase-encrypted private key escrow)
  Keep recovery-key.age AND your passphrase somewhere safe and separate. Losing
  both means the cloud copies can never be decrypted.
#>

[CmdletBinding()]
param(
  [string] $OutputDirectory = (Join-Path (Get-Location) 'ptvault-recovery')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ageKeygenBin = if ($env:PTVAULT_AGE_KEYGEN_BIN) { $env:PTVAULT_AGE_KEYGEN_BIN } else { 'age-keygen' }
$ageBin       = if ($env:PTVAULT_AGE_BIN)        { $env:PTVAULT_AGE_BIN }        else { 'age' }

$recipientFile = Join-Path $OutputDirectory 'recovery-recipient.txt'
$escrowFile    = Join-Path $OutputDirectory 'recovery-key.age'

if (Test-Path -LiteralPath $OutputDirectory) { throw 'recovery: output directory already exists; choose a new directory' }
if ([Console]::IsInputRedirected) { throw 'recovery: an interactive terminal is required (do not pipe a passphrase)' }

# Everything sensitive lives in a private temp dir wiped on every exit path.
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ptvault-recovery-" + [System.Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tmpDir -Force
if ($IsWindows) {
  $acl = Get-Acl -LiteralPath $tmpDir
  $acl.SetAccessRuleProtection($true, $false)
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $tmpDir -AclObject $acl
} else { & chmod 700 $tmpDir }
$keyFile       = Join-Path $tmpDir 'identity.age.key'
$roundtripFile = Join-Path $tmpDir 'roundtrip.key'
# Stage the escrow inside the private temp dir; only publish it into
# $OutputDirectory once it has been verified to decrypt correctly.
$escrowTmp     = Join-Path $tmpDir 'recovery-key.age'

function Remove-Secret([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  try {
    $len = (Get-Item -LiteralPath $path).Length
    if ($len -gt 0) {
      $zeros = New-Object byte[] ([int]$len)
      [System.IO.File]::WriteAllBytes($path, $zeros)
    }
  } catch { }
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

function Invoke-Cleanup {
  Remove-Secret $keyFile
  Remove-Secret $roundtripFile
  $resolved = [IO.Path]::GetFullPath($tmpDir)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notmatch '^ptvault-recovery-[a-f0-9]{32}$') { throw 'recovery: cleanup path invalid' }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}

try {
  # 1. generate the keypair locally.
  & $ageKeygenBin -o $keyFile 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'recovery: age-keygen failed' }

  # 2. derive the public recipient.
  $recipient = (& $ageKeygenBin -y $keyFile).Trim()
  if ($recipient -notmatch '^age1') { throw 'recovery: could not derive a public recipient' }

  # 3. age owns console prompting; the script never receives the passphrase.
  & $ageBin -p -o $escrowTmp $keyFile
  if ($LASTEXITCODE -ne 0) { throw 'recovery: escrow encryption failed' }

  # 4. verify the escrow round-trips back to the SAME recipient.
  & $ageBin -d -o $roundtripFile $escrowTmp
  if ($LASTEXITCODE -ne 0) { throw 'recovery: escrow failed to decrypt with the supplied passphrase' }
  $roundtripRecipient = (& $ageKeygenBin -y $roundtripFile).Trim()
  if ($roundtripRecipient -ne $recipient) {
    throw 'recovery: escrow verification mismatch — refusing to write output'
  }

  # 5. escrow proven good → publish outputs.
  $null = New-Item -ItemType Directory -Path $OutputDirectory
  $recipientStream = [IO.File]::Open($recipientFile, [IO.FileMode]::CreateNew)
  try { $recipientBytes = [Text.Encoding]::ASCII.GetBytes($recipient + [Environment]::NewLine); $recipientStream.Write($recipientBytes) }
  finally { $recipientStream.Dispose() }
  Move-Item -LiteralPath $escrowTmp -Destination $escrowFile

  $escrowSha = (Get-FileHash -LiteralPath $escrowFile -Algorithm SHA256).Hash.ToLower()

  Write-Output ""
  Write-Output "Recovery material prepared."
  Write-Output ""
  Write-Output "  Public recipient : $recipient"
  Write-Output "  Recipient file   : $recipientFile"
  Write-Output "  Escrow file      : $escrowFile"
  Write-Output "  Escrow SHA-256   : $escrowSha"
  Write-Output ""
  Write-Output "Next steps:"
  Write-Output "  1. Enroll the PUBLIC recipient on the VPS (paste it into the recovery-recipient"
  Write-Output "     setup, or upload recovery-recipient.txt). This is safe to share."
  Write-Output "  2. Store recovery-key.age AND your passphrase somewhere safe and SEPARATE from"
  Write-Output "     the VPS. You need both to decrypt cloud copies on a clean machine."
  Write-Output "  3. Never upload plaintext keys. Temporary keys were removed; physical erasure is not guaranteed."
}
finally {
  Invoke-Cleanup
}

