# dsh-credential-manager.ps1 - Windows Credential Manager storage for DSH secrets.
#
# P2 (2026-08-18): store API keys in the system Credential Manager (the platform
# answer the upstream project itself calls the "eventual answer"; generic
# credentials are protected by the same per-user DPAPI master key as our own
# `DP1:` scheme, but the ciphertext lives in the OS vault instead of a config
# file - visible/manageable in 控制面板 -> 凭据管理器, and audit-friendly.
#
# The client keeps writing the legacy `DP1:` fields into client-config.json for
# backward compatibility, and mirrors the plaintext into the Credential Manager
# whenever it is written. Reads prefer the Credential Manager first, then fall
# back to the legacy DP1 value (auto-migrating it once).
#
# Dot-source this file. Self-loads its P/Invoke shim on first use.

$script:CredManagerInited = $false

function Initialize-CredentialManagerShim {
    # compile the tiny wincred P/Invoke facade once per process.
    if ($script:CredManagerInited) { return $true }
    $script:CredManagerInited = $true
    try {
        $src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, uint flags, out IntPtr cred);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, int type, uint flags);
    [DllImport("advapi32.dll")]
    public static extern bool CredFree(IntPtr cred);

    public static bool Write(string target, string user, string secret) {
        var raw = Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(raw.Length);
        Marshal.Copy(raw, 0, blob, raw.Length);
        try {
            var c = new CREDENTIAL {
                Type = 1, TargetName = target, UserName = user, Persist = 2,
                CredentialBlobSize = (uint)raw.Length, CredentialBlob = blob
            };
            return CredWrite(ref c, 0);
        } finally { Marshal.FreeHGlobal(blob); }
    }
    public static string Read(string target) {
        IntPtr p;
        if (!CredRead(target, 1, 0, out p)) return null;
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlobSize == 0 || c.CredentialBlob == IntPtr.Zero) return null;
            var data = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, data, 0, (int)c.CredentialBlobSize);
            return Encoding.Unicode.GetString(data).TrimEnd('\0');
        } finally { CredFree(p); }
    }
    public static bool Delete(string target) {
        return CredDelete(target, 1, 0);
    }
}
"@
        Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
        # verify the type is resolvable via the type literal (GetType() can miss
        # Add-Type dynamic assemblies on PowerShell 7; [DshWinCred] resolves reliably)
        $null = [DshWinCred]
        return $true
    } catch {
        try { Write-Host ('CRED-INIT-ERR: ' + $_.Exception.Message) -ForegroundColor Red } catch {}
        return $false
    }
}

function Set-DshCredCM([string]$Target, [string]$Value, [string]$User = 'dsh') {
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    if (-not (Initialize-CredentialManagerShim)) { return }
    try { [void][DshWinCred]::Write($Target, $User, $Value) } catch {}
}

function Get-DshCredCM([string]$Target) {
    if (-not (Initialize-CredentialManagerShim)) { return '' }
    try {
        $v = [DshWinCred]::Read($Target)
        if ($null -eq $v) { return '' }
        return [string]$v
    } catch { return '' }
}

function Remove-DshCredCM([string]$Target) {
    if (-not (Initialize-CredentialManagerShim)) { return }
    try { [void][DshWinCred]::Delete($Target) } catch {}
}
