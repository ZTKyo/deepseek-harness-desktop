# RH2 DEPLOYMENT PREFLIGHT MANIFEST

Status: `READY FOR EXTERNAL REVIEW`; `NOT A DEPLOYMENT AUTHORIZATION`.

This manifest is a read-only mapping produced from the RH2 isolated worktree,
`origin/main`, the dirty `_release-staging` snapshot, the DSH-Client deployed
root, the active `web` profile, the loaded-release manifest, and sanitized
current process metadata. No target was modified.

## Candidate and environment identity

- Repository: `ZTKyo/deepseek-harness-desktop`
- PR: `#85`, branch `hotfix/reliability-rh2-freeze-p1`
- Reviewed source candidate commit:
  `18802858b4b58d61a25d98bf6cc273e30663e018`
- `origin/main`:
  `563ce43d59c5a46a7e663cee804f6e4609d1f70d`
- `_release-staging` observed HEAD:
  `b6feb72229436d9684235a71420e84d830074d31`; dirty and not modified.
- Loaded manifest:
  `C:\Users\Administrator\AppData\Local\DSHHarness\state\loaded-release.json`
  SHA256 `4bedf5a945ac533cde95a5cc54d566651a86246014d4bc88e048351e4ca63c71`.
- Loaded metadata: `serverGeneration=boot:2824_1788613920268`,
  `loadedAt=09/05/2026 20:22:32`, metadata PID `11968`, capacity source
  `hint`, wired `false`.

`active web profile` is plugin-scoped for this mapping. Root PowerShell and
launcher files are deployed from `DSH-Client`, so their active-profile cells
are `N/A` by design.

## SHA256 drift matrix

`source` is the isolated RH2 worktree. `main` is the byte hash of the same path
read from `origin/main`. `staging` is `_release-staging`. `deployed` is the
DSH-Client root. `profile` is `~/.dsh/profiles/web`. `loaded` is the hash in the
loaded-release plugin map; `N/A` means the manifest does not attest that root
file.

| Path | source | main | staging | deployed | profile | loaded | Difference classification |
|---|---|---|---|---|---|---|---|
| `plugins/execution-continuity.mjs` | `9ad91db289aacacd7a0892c39ca9f6309256d1101f0dcda4aebdbbe12a7f12ba` | `86892f384b618875f3eb6a34092914cfaf23984bc2505d94f14f70e5ab5c8a49` | `f9df283da70ddb42c94865c12b9094f2e8c34bf86a338414895e9747903d7bc0` | `ABSENT (profile-scoped)` | `36a7a0a308021f31916a8fcbdfa45cdf5f3bf261f741373003fca09b5a77285` | `36a7a0a308021f31916a8fcbdfa45cdf5f3bf261f741373003fca09b5a77285` | source→main `REVIEWED_HOTFIX`; source→profile/loaded `STALE_DEPLOYMENT`; root placement `EXPECTED_PROFILE_COPY` |
| `plugins/execution-continuity-core.mjs` | `acbc4381c7e8be0436203dac05de7fda31b766b4bedd5ea7743ebe318f1c28f7` | `86d7e1ab9c265f86194afeb93b648df6d1e1928309e9366cfbdd2de9444aa07f` | `e595ab7b3aab4e3f5de2e065a8c5f235be4eb8077d964315d731e412e2b40b43` | `ABSENT (profile-scoped)` | `acbc4381c7e8be0436203dac05de7fda31b766b4bedd5ea7743ebe318f1c28f7` | `N/A (not listed)` | source→main `REVIEWED_HOTFIX`; profile copy `EXPECTED_PROFILE_COPY`; loaded attestation `UNKNOWN_DRIFT` |
| `dsh-readiness.ps1` | `a8698d93658523dee45c6f39643e2ed925289442004cd81f0d9d1ce1def27d19` | `fc2b2beb973521b8d84600fd4d3f8fb833a76489badc6edd30a62176b79198ca` | `c0982a3866a0a33a694664d9d3eb97c1696bce2dacff841c405c631a4b7de404` | `b0b5b78c5897354ea94ff1fd99ea86057edb909a08fc3da881f648467a423238` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `STALE_DEPLOYMENT` |
| `dsh-health.ps1` | `5eece4e20af0c6c422136a5072ff9be4df2109a095cba2108ce28c36e1654c6b` | `05914ad85916d0a865256fef356ed0138868333f43118041d56bf99d2f084b05` | `ABSENT` | `26935c932f22a4d680ccf4e6c0363afad12f88fe6c1614d6eeb9856e66c7fbad` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `STALE_DEPLOYMENT`; staging absence `UNKNOWN_DRIFT` |
| `dsh-healthcheck.ps1` | `7caf3deb23f170e382d668664977b558efac49711478151edc00bd9d6d9a4d47` | `ecc62db36a5c7096086617163ae3452f07bce2ffae95764f407c80453fc341cc` | `e9e520bd2bb78c694aab0370a8a23027734f9f9743a0a0a2f006be56c76cf958` | `e9e520bd2bb78c694aab0370a8a23027734f9f9743a0a0a2f006be56c76cf958` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `STALE_DEPLOYMENT` |
| `dsh-guardian.ps1` | `1cf3a49ca593ad5749e76289b43c3910cae1735db1fb93e4983ce2928221da33` | `ba3dd337920208ec6a9ec8fb2c9c5322cc0e8e94b67bb92b7efa0fcd93e2a9c0` | `ae735e7f813d731f6b0272d6719e328dc279361d0d8c0eaba2b8d207e4c01dc` | `1cf3a49ca593ad5749e76289b43c3910cae1735db1fb93e4983ce2928221da33` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `EXPECTED_PROFILE_COPY` |
| `dsh-guardian-watchdog.ps1` | `50a2615ff4656defaaaa174066e7a81bcdf42535093eb184863a46d9236dd7b3` | `cafef5f6768058637c1314737680db19e3e708e318f8b75a6a09054c66098f84` | `cafef5f6768058637c1314737680db19e3e708e318f8b75a6a09054c66098f84` | `cafef5f6768058637c1314737680db19e3e708e318f8b75a6a09054c66098f84` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `STALE_DEPLOYMENT` |
| `dsh-reconnect.ps1` | `82b929a50c71c5e9948c0d49d786d6682eb98b57b7657b44b30c0619aef796b0` | `a37d23aef1817e3bf6b2a4a5bf76332c9ea8a117a4ab896f0103891ea6954ecf` | `ABSENT` | `f29f1971c2db20c52946d19a9768da1fbbbd8271d5cab02fc1f6be8a49be239a` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `STALE_DEPLOYMENT`; staging absence `UNKNOWN_DRIFT` |
| `DSH-Harness-PS.ps1` | `130a04ac5efe2b6c8fb1fbbfa03abf2676d15aa3abe1b99bd654559fbd943412` | `bf0c85a0c9aa83519f2cbb2ce2ba9a14e606dd57a35485bc0eef5e630cf3066a` | `8c88d00fd51ee8ac0abb4cc9412c65775821272b4181e8a145c6639f134d72d7` | `24bcacaa1b08c3c2fb8fd9eef2c96c976e45f77a31cc16c9290506a58658a371` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; source→deployed `STALE_DEPLOYMENT` |
| `dsh-launcher.js` | `17446ae801a8a1b8a95bc1ace7fd8060d522247f6f2c789c7aa147adfad05fde` | `d00626a10f7eff66a7584c3395aa82ba40ffa3c10950385e772991c62ced05b9` | `17446ae801a8a1b8a95bc1ace7fd8060d522247f6f2c789c7aa147adfad05fde` | `100e70820112f5885416a88222fe29812eaa199c9b1e9da7e506b97cfd4b5f14` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; deployed override `KNOWN_RUNTIME_DIAGNOSTIC_OVERRIDE` |
| `start-dsh-server.ps1` | `c6d11d1efb8b6e85c480a7af5b9d5b6160fb4e69f7cc323a96d955e2697e4d9b` | `d8fd854c57fd89307a45d5a3a643a59ae043b261f8e540770fea6013006ab7bc` | `c6d11d1efb8b6e85c480a7af5b9d5b6160fb4e69f7cc323a96d955e2697e4d9b` | `c6d11d1efb8b6e85c480a7af5b9d5b6160fb4e69f7cc323a96d955e2697e4d9b` | `N/A` | `N/A` | source→main `REVIEWED_HOTFIX`; root copy `EXPECTED_PROFILE_COPY` |

For the `UNKNOWN_DRIFT` cells above, the label applies only to the absent or
unattested edge; it is not permission to overwrite the target. All source-to-
deployed mismatches remain `STALE_DEPLOYMENT` until an approved transaction.

## Reviewed RH2 files to deploy (only after external approval)

These are the candidate files that the reviewer should evaluate as one
transaction from the PR source, with hashes taken from the `source` column:

- `plugins/execution-continuity.mjs`
- `plugins/execution-continuity-core.mjs`
- `dsh-readiness.ps1`
- `dsh-health.ps1`
- `dsh-healthcheck.ps1`
- `dsh-guardian.ps1`
- `dsh-guardian-watchdog.ps1`
- `dsh-reconnect.ps1`
- `DSH-Harness-PS.ps1`
- `start-dsh-server.ps1`

The workflow and deterministic tests in the source commit are review/CI
artifacts, not production deployment files.

## Files explicitly NOT to touch tonight

- `C:\Users\Administrator\.dsh\profiles\web\` and its production intent,
  session, Supervisor, and loaded state.
- `C:\Users\Administrator\Desktop\sdeepseek harness\DSH-Client\` files
  outside the explicitly reviewed RH2 set.
- `dsh-launcher.js`'s deployed V8 diagnostic override until external review
  decides whether it is retained or removed.
- `_release-staging`, `origin/main`, PR merge state, P2.75/P2.8, P3, and P4.
- Any credential source, especially `.credentials.yaml` and `NOTION_TOKEN`.

## Current deployed runtime observation

Read-only port/process inspection found loopback Harness server PID `2824`
using `DSH-Client\node-runtime\node.exe`, the DSH entrypoint, and port `3080`.
Sanitized flags were `--max-old-space-size=4096` and `--trace-gc`.

The deployed DSH-Client launcher has the 2026-09-02 GC diagnostic comment and
`V8_FLAGS` at lines 80-88; the canonical reviewed launcher starts the child at
line 78 without those V8 flags. Therefore:

`LAUNCHER_OVERRIDE_DECISION_REQUIRED=YES`

The origin and purpose are mapped as a known runtime diagnostic override. This
manifest intentionally does not choose keep/delete.

## Future deployment transaction requirements

1. Before any approved deployment, hash and back up the current DSH-Client
   root and active profile set, including a manifest of paths and hashes.
2. Copy only the externally approved RH2 files from the reviewed source commit;
   do not promote `_release-staging` as a substitute source.
3. The approved operator must perform the separately authorized load/restart
   transaction. This step was **not** performed tonight.
4. After load, verify owner identity, `host.describe`, `session.list`,
   `events.mux`, `events.host`, renderer, source/deployed/loaded hashes, and a
   stable window. A source candidate CI pass is not a loaded-runtime proof.
5. If any check fails, restore the pre-deployment backup transactionally and
   verify the restored hash set before retrying.

Rollback source for this candidate is the Git commit
`18802858b4b58d61a25d98bf6cc273e30663e018` (or its explicit review-approved
revert). No production rollback exists or is needed because no deployment was
performed.

`PRODUCTION_MUTATED=NO`
