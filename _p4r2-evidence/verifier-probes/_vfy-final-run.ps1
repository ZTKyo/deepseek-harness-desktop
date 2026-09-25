# Final verdict driver (ASCII only). Run ONLY after freeze conditions hold.
# Read-only w.r.t. the repo: all work happens on a temp copy; test stateDirs live in os.tmpdir().
$repo = 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2'
$work = "$env:TEMP\_vfy-FINAL"
$mut  = "$env:TEMP\_vfy-FINAL-mut"
$probe = "$env:TEMP\_vfy-probes"
$log  = "$env:TEMP\_vfy-FINAL-verdict.txt"

$head  = (git -C $repo log -1 --format=%H).Trim()
$dirty = @(git -C $repo status --porcelain | Where-Object { $_ -ne '' }).Count
$out = New-Object System.Collections.Generic.List[string]
$say = { param($s) $out.Add($s); Write-Output $s }

& $say "##### VERIFIED COMMIT $head  (dirty=$dirty)  frozen_at=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
& $say "##### per-file SHA256 (git-tracked files)"
git -C $repo ls-files | ForEach-Object {
  $p = Join-Path $repo $_
  if (Test-Path $p -PathType Leaf) { & $say ("{0}  {1}" -f $_, (Get-FileHash $p -Algorithm SHA256).Hash) }
}

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null
Copy-Item "$repo\*" $work -Recurse -Force -Exclude '.git'
& $say "##### temp frozen copy made: $work"

# 1) full suite on final bytes
Set-Location $work
& $say "##### [1] FULL SUITE (final bytes)"
$suite = (node "$work\tests\learn\run-learn-all-tests.mjs" 2>&1)
$suite | Set-Content "$env:TEMP\_vfy-FINAL-suite.txt" -Encoding UTF8
$suite | Select-String 'FAIL|套件：|门槛断言|失败套件' | ForEach-Object { & $say $_.Line }

# 2) my independent probes on final bytes (shell path)
$env:VFY_FROZEN = $work
Set-Location $probe
& $say "##### [2] SECTION 8 A-F (shell path, honest-host seam)"
$env:VFY_STATE = "$env:TEMP\_vfy-FINAL-state"
if (Test-Path $env:VFY_STATE) { Remove-Item $env:VFY_STATE -Recurse -Force }
(node p8-lifecycle.mjs 1 2>&1) | Select-String 'approve:|persisted|canPublish_BEFORE' | ForEach-Object { & $say $_.Line }
(node p8-lifecycle.mjs 2 2>&1) | Select-String 'A_|B_|D_|E_|F_|shell_applied' | ForEach-Object { & $say $_.Line }

& $say "##### [3] SECTION 6 TAMPER MATRIX (final bytes)"
$tamper = node p6-tamper.mjs setup 2>&1
$tamper | ForEach-Object { & $say $_ }
foreach ($c in @('replay_drop_consume','insert_dup_grant','edit_digest_ledger_only','edit_digest_both','edit_approvedAt','delete_grant_keep_consume','delete_file','ref_swap','forge_full')) {
  (node p6-tamper.mjs apply $c 2>&1) | Select-String 'applied:' | ForEach-Object { & $say $_.Line }
  (node p6-tamper.mjs judge $c 2>&1) | Select-String 'validHumanApproval|canPublish=|VERDICT' | ForEach-Object { & $say $_.Line }
}

& $say "##### [4] F2 THREE VALUES (final bytes)"
(node p-f2-bounds.mjs 2>&1) | ForEach-Object { & $say $_ }

& $say "##### [5] MY OWN F1 ASSERTION SENSITIVITY (independent mutation on temp copy)"
if (Test-Path $mut) { Remove-Item $mut -Recurse -Force }
Copy-Item $work $mut -Recurse
node _vfy-mutate.mjs "$mut\plugins\learn-core.mjs" 'export function validHumanApproval(exp, ledger) {' "export function validHumanApproval(exp, ledger) { return { ok: true, reason: 'ok' };" | ForEach-Object { & $say $_ }
$env:VFY_FROZEN = $mut
(node p6-trust.mjs memory-ledger 2>&1) | Select-String 'ATTACK_RESULT|canPublish' | ForEach-Object { & $say ("MUTATED: " + $_.Line) }
$env:VFY_FROZEN = $work
(node p6-trust.mjs memory-ledger 2>&1) | Select-String 'ATTACK_RESULT|canPublish' | ForEach-Object { & $say ("ORIGINAL: " + $_.Line) }

& $say "##### [6] SHELL-PATH SINGLE-CONSUME / REPLAY (p9, tool layer)"
$env:VFY_FROZEN = $work
(node p9-shell-consume-replay.mjs base 2>&1) | Select-String 'T1_shell_publish_1|T1_ledger_after_publish|T2_shell_publish_2_REPLAY|T2_ledger_after_replay|T3_shell_canPublishFor_after_consume|T3_shell_validHumanApprovalFor|T4_shell_canPublishFor_CLONE' | ForEach-Object { & $say $_.Line }
foreach ($c in @('dupgrant','dupconsume','dropconsume','forge')) {
  (node p9-shell-consume-replay.mjs $c 2>&1) | Select-String 'host_fact_seeded|tamper_ledger|SHELL_VERDICTS' | ForEach-Object { & $say $_.Line }
}
& $say "##### [6b] WHICH LAYER DECIDES (probe harness must let host-fact PASS, else the deny is not isolateable)"
& $say "  baseline: dupconsume -> approval_ledger_grant_consumed_twice ; dropconsume -> approval_ledger_grant_not_consumed"

& $say "##### repo dirty after run: $(@(git -C $repo status --porcelain | Where-Object { $_ -ne '' }).Count)"
$out | Set-Content $log -Encoding UTF8
& $say "##### log written: $log"
