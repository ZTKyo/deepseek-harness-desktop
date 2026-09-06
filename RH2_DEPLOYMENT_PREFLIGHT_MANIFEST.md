# RH2 R1.3 DEPLOYMENT PREFLIGHT MANIFEST

Status: `RH2 R1.3 AWAITING EXTERNAL REVIEW`; `NOT A DEPLOYMENT AUTHORIZATION`.

This manifest records the R1.3 Guardian loopback bind-conflict source
correction and separates canonical PR change truth from production drift. No
production profile, deployment, process, credential, merge, P3, or P4 change
is included.

## Required truth fields

```text
REVIEWED_PR_HEAD=eed21b35c4211b0cdd62af8e4fdc80bafda51d80
PREVIOUS_REVIEWED_PR_HEAD=eed21b35c4211b0cdd62af8e4fdc80bafda51d80
SOURCE_AUTHORITY=GIT_REVIEWED_TREE
STAGING_AUTHORITY=NO
DIRTY_WORKTREE_AUTHORITY=NO
RH2_DEPLOY_SET=6 exact production files
LAUNCHER=KEEP_TEMPORARILY_FOR_INITIAL_SOAK
PRODUCTION=UNCHANGED
```

Repository: `ZTKyo/deepseek-harness-desktop`

PR: `#85`

Branch: `hotfix/reliability-rh2-freeze-p1`

Base: `main`

`origin/main=563ce43d59c5a46a7e663cee804f6e4609d1f70d`

The previous reviewed head above is the exact PR head before the R1.3 source
correction. The final R1.3 source head is reported by the closure output.

## Canonical Git change truth

`CHANGED_IN_PR` is derived only from `git diff --name-status origin/main...HEAD`
and base/head Git blob identity. `BASE_BLOB` and `HEAD_BLOB` are Git object
IDs. The canonical SHA256 values are calculated from the exact bytes returned
by `git show <reviewed-head>:<path>`, not from a Windows checkout.

| Path | BASE_BLOB | HEAD_BLOB | CHANGED_IN_PR | HEAD_CANONICAL_SHA256 |
|---|---|---|---|---|
| `plugins/execution-continuity.mjs` | `c221323d9c0ec8b26f19aef539482fde663fe1c6` | `6d8a1746a4e5e9082d1139f79f1eeb8f1ae1c24f` | `YES` | `041aad8d4510c33dc3e3671a3ae2b407d18cf9a25db1f75bef7604255ab9c848` |
| `plugins/execution-continuity-core.mjs` | `c125be63fb751f3eb7517d4752330b8478d4c1d4` | `c125be63fb751f3eb7517d4752330b8478d4c1d4` | `NO` | `86d7e1ab9c265f86194afeb93b648df6d1e1928309e9366cfbdd2de9444aa07f` |
| `dsh-readiness.ps1` | `0ca188ff8a5531d4041452d6669e52694b2877e7` | `60880cd5bd3d93b4f711b24a09963d3c94d41e70` | `YES` | `f093593d820a08292bd49820204f4bba4d737526d349047d34b534d5a41cc59e` |
| `dsh-process-identity.ps1` | `524373a5c277158a53d9e10913df8331cac7b094` | `c3cf43c5caac647e1e5a70517cb47eb10d279177` | `YES` | `f8c3f0dc5bad833866ae1d2569fedaf25c0ada9d31abddeb049aeb7de8c089ca` |
| `dsh-health.ps1` | `9945981f2d9bb44244ae10320035a6b6e80d43c2` | `64cbe4a08c202db983e8f5732fb728c960648001` | `YES` | `4115f42e69bff2d783022b6055bc79c18a0d83926e7832b31f6a6474886a47bb` |
| `dsh-healthcheck.ps1` | `a775f7c02c28ea2bd11ada0c77ba5ec912c1c24e` | `8b824ba30109e029748670fcc9731df8d4fc9838` | `YES` | `1fb56a340577c6d48c94b87450a4b4675336eede67a2366afe4b25b06b594fe0` |
| `dsh-guardian.ps1` | `4ad1fd6143015a6cb7d6cf5a8d9503433c56e304` | `4ad1fd6143015a6cb7d6cf5a8d9503433c56e304` | `NO` | `ba3dd337920208ec6a9ec8fb2c9c5322cc0e8e94b67bb92b7efa0fcd93e2a9c0` |
| `dsh-guardian-watchdog.ps1` | `0a2f3d6c35d0f22c390b1ca35f9a47ffa086cda6` | `ca1deb884fd0fa80b721eaf5661ab8040c1dbba3` | `YES` | `c187286d60a1e9de0f966df88dfe206d366efaa06aacf99b7aedc3639ad7f2c5` |
| `dsh-reconnect.ps1` | `01d25b0f06bf7658aadc70ab75c84f1ded86cd3f` | `01d25b0f06bf7658aadc70ab75c84f1ded86cd3f` | `NO` | `a37d23aef1817e3bf6b2a4a5bf76332c9ea8a117a4ab896f0103891ea6954ecf` |
| `DSH-Harness-PS.ps1` | `6698f180146070d5164dbf538538d15bc0662f6e` | `6698f180146070d5164dbf538538d15bc0662f6e` | `NO` | `bf0c85a0c9aa83519f2cbb2ce2ba9a14e606dd57a35485bc0eef5e630cf3066a` |
| `dsh-launcher.js` | `4d607d7e915f8c6930589f0f8a0c8622495112e3` | `4d607d7e915f8c6930589f0f8a0c8622495112e3` | `NO` | `d00626a10f7eff66a7584c3395aa82ba40ffa3c10950385e772991c62ced05b9` |
| `start-dsh-server.ps1` | `bf48a0a8f77a3e673e77686d1a84f8e7aa9c7ca2` | `bf48a0a8f77a3e673e77686d1a84f8e7aa9c7ca2` | `NO` | `d8fd854c57fd89307a45d5a3a643a59ae043b261f8e540770fea6013006ab7bc` |

The exact production change set is therefore:

```text
RH2_DEPLOY_SET =
  plugins/execution-continuity.mjs
  dsh-process-identity.ps1
  dsh-readiness.ps1
  dsh-health.ps1
  dsh-healthcheck.ps1
  dsh-guardian-watchdog.ps1
```

The other PR changes are tests, workflow wiring, or reports and are not
production deployment files.

## Unchanged-in-PR related runtime files

These paths have identical base/head Git blobs and are explicitly excluded
from `RH2_DEPLOY_SET`:

```text
UNCHANGED_IN_PR =
  plugins/execution-continuity-core.mjs
  dsh-guardian.ps1
  dsh-reconnect.ps1
  DSH-Harness-PS.ps1
  dsh-launcher.js
  start-dsh-server.ps1
```

Any deployed/staging/profile byte difference for these files is
`PRE_EXISTING_PRODUCTION_DRIFT`, not an RH2 change. Checkout line-ending/BOM
differences do not change this Git conclusion.

## Production drift matrix (separate dimension)

`STAGING` is `_release-staging`; `DEPLOYED` is the DSH-Client root;
`PROFILE` is `C:/Users/Administrator/.dsh/profiles/web`; `LOADED` is the
hash recorded by `loaded-release.json`. Root plugin files are profile-scoped,
so their DSH-Client root cell is `ABSENT`; root PowerShell/launcher files are
DSH-Client-scoped, so their profile and loaded cells are `N/A`.

| Path | HEAD_CANONICAL_HASH | STAGING | DEPLOYED | PROFILE | LOADED | DRIFT_CLASS |
|---|---|---|---|---|---|---|
| `plugins/execution-continuity.mjs` | `041aad8d4510c33dc3e3671a3ae2b407d18cf9a25db1f75bef7604255ab9c848` | `f9df283da70ddb42c94865c12b9094f2e8c34bf86a338414895e9747903d7bc0` | `ABSENT (profile-scoped)` | `36a7a0a308021f31916a8fcbdfa45cdf5f3bf261f741373003fca09b5a77285f` | `36a7a0a308021f31916a8fcbdfa45cdf5f3bf261f741373003fca09b5a77285f` | `STALE_DEPLOYMENT` |
| `plugins/execution-continuity-core.mjs` | `86d7e1ab9c265f86194afeb93b648df6d1e1928309e9366cfbdd2de9444aa07f` | `e595ab7b3aab4e3f5de2e065a8c5f235be4eb8077d964315d731e412e2b40b43` | `ABSENT (profile-scoped)` | `acbc4381c7e8be0436203dac05de7fda31b766b4bed5ea7743ebe318f1c28f7` | `N/A (not listed)` | `PRE_EXISTING_PRODUCTION_DRIFT` |
| `dsh-readiness.ps1` | `f093593d820a08292bd49820204f4bba4d737526d349047d34b534d5a41cc59e` | `c0982a3866a0a33a694664d9d3eb97c1696bce2dacff841c405c631a4b7de404` | `b0b5b78c5897354ea94ff1fd99ea86057edb909a08fc3da881f648467a423238` | `N/A` | `N/A` | `STALE_DEPLOYMENT` |
| `dsh-process-identity.ps1` | `f8c3f0dc5bad833866ae1d2569fedaf25c0ada9d31abddeb049aeb7de8c089ca` | `ae48cf86681262751453b67300dee2b8bb815ce5f9f74cdd2dfa97e858795c2f` | `ae48cf86681262751453b67300dee2b8bb815ce5f9f74cdd2dfa97e858795c2f` | `N/A` | `N/A` | `STALE_DEPLOYMENT` |
| `dsh-health.ps1` | `4115f42e69bff2d783022b6055bc79c18a0d83926e7832b31f6a6474886a47bb` | `ABSENT` | `26935c932f22a4d680ccf4e6c0363afad12f88fe6c1614d6eeb9856e66c7fbad` | `N/A` | `N/A` | `STALE_DEPLOYMENT` |
| `dsh-healthcheck.ps1` | `1fb56a340577c6d48c94b87450a4b4675336eede67a2366afe4b25b06b594fe0` | `e9e520bd2bb78c694aab0370a8a23027734f9f9743a0a0a2f006be56c76cf958` | `e9e520bd2bb78c694aab0370a8a23027734f9f9743a0a0a2f006be56c76cf958` | `N/A` | `N/A` | `STALE_DEPLOYMENT` |
| `dsh-guardian.ps1` | `ba3dd337920208ec6a9ec8fb2c9c5322cc0e8e94b67bb92b7efa0fcd93e2a9c0` | `ae735e7f813d731f6b0272d6719e328dc279361d0d8c0eaba2b8d207e4c01dc` | `1cf3a49ca593ad5749e76289b43c3910cae1735db1fb93e4983ce2928221da33` | `N/A` | `N/A` | `PRE_EXISTING_PRODUCTION_DRIFT` |
| `dsh-guardian-watchdog.ps1` | `c187286d60a1e9de0f966df88dfe206d366efaa06aacf99b7aedc3639ad7f2c5` | `cafef5f6768058637c1314737680db19e3e708e318f8b75a6a09054c66098f84` | `cafef5f6768058637c1314737680db19e3e708e318f8b75a6a09054c66098f84` | `N/A` | `N/A` | `STALE_DEPLOYMENT` |
| `dsh-reconnect.ps1` | `a37d23aef1817e3bf6b2a4a5bf76332c9ea8a117a4ab896f0103891ea6954ecf` | `ABSENT` | `f29f1971c2db20c52946d19a9768da1fbbbd8271d5cab02fc1f6be8a49be239a` | `N/A` | `N/A` | `PRE_EXISTING_PRODUCTION_DRIFT` |
| `DSH-Harness-PS.ps1` | `bf0c85a0c9aa83519f2cbb2ce2ba9a14e606dd57a35485bc0eef5e630cf3066a` | `8c88d00fd51ee8ac0abb4cc9412c65775821272b4181e8a145c6639f134d72d7` | `24bcacaa1b08c3c2fb8fd9eef2c96c976e45f77a31cc16c9290506a58658a371` | `N/A` | `N/A` | `PRE_EXISTING_PRODUCTION_DRIFT` |
| `dsh-launcher.js` | `d00626a10f7eff66a7584c3395aa82ba40ffa3c10950385e772991c62ced05b9` | `17446ae801a8a1b8a95bc1ace7fd8060d522247f6f2c789c7aa147adfad05fde` | `100e70820112f5885416a88222fe29812eaa199c9b1e9da7e506b97cfd4b5f14` | `N/A` | `N/A` | `KNOWN_RUNTIME_DIAGNOSTIC_OVERRIDE` |
| `start-dsh-server.ps1` | `d8fd854c57fd89307a45d5a3a643a59ae043b261f8e540770fea6013006ab7bc` | `c6d11d1efb8b6e85c480a7af5b9d5b6160fb4e69f7cc323a96d955e2697e4d9b` | `c6d11d1efb8b6e85c480a7af5b9d5b6160fb4e69f7cc323a96d955e2697e4d9b` | `N/A` | `N/A` | `PRE_EXISTING_PRODUCTION_DRIFT` |

The `PRE_EXISTING_PRODUCTION_DRIFT` label applies only to runtime differences
for files whose base/head Git blobs are equal; it never makes an unchanged
file part of the RH2 deployment set. `KNOWN_RUNTIME_DIAGNOSTIC_OVERRIDE` is
the specific, separately decided launcher case.

## Launcher decision

The DSH-Client deployed launcher contains the pre-existing 2026-09-02
diagnostic override at lines 80-88:

```text
--max-old-space-size=4096
--trace-gc
```

The canonical launcher has no V8 flags. Per external review:

```text
LAUNCHER_OVERRIDE=KEEP_TEMPORARILY_FOR_INITIAL_SOAK
```

Do not touch `dsh-launcher.js` in the initial RH2 deployment. After the first
30-60 minute production soak, decide separately whether to remove
`--trace-gc` and restore the canonical launcher.

## Profile copy rule

For `plugins/execution-continuity.mjs`, the only approved future direction is:

```text
GIT_REVIEWED_TREE:plugins/execution-continuity.mjs
  -> active profile destination: ~/.dsh/profiles/web/execution-continuity.mjs
```

Use the exact content from the reviewed Git head. Never source it from
`_release-staging`, the current profile, or a dirty checkout. Do not copy
`execution-continuity-core.mjs` merely because it is a dependency; it is
`UNCHANGED_IN_PR`.

## Explicitly not to touch

- `~/.dsh/profiles/web`, production sessions/intents, Supervisor state, and
  loaded-release state tonight.
- `_release-staging` and the dirty main worktree.
- Unchanged-in-PR files listed above, including `dsh-launcher.js`.
- Credentials, `.credentials.yaml`, and `NOTION_TOKEN`.
- P2.75, P2.8, P3, P4, and PR merge state.

## Future deployment gate

After external review and explicit deployment authorization only:

1. Back up and hash the current DSH-Client/profile set.
2. Copy exactly the six `RH2_DEPLOY_SET` files from the Git reviewed tree.
3. Perform the separately authorized load/restart transaction.
4. Verify owner, `host.describe`, `session.list`, `events.mux`, `events.host`,
   renderer, source/deployed/loaded hashes, and a stable window.
5. On failure, restore the backup transactionally and verify hashes.

No deployment, load, restart, or rollback was performed in this task.

```text
PRODUCTION_MUTATED=NO
```
