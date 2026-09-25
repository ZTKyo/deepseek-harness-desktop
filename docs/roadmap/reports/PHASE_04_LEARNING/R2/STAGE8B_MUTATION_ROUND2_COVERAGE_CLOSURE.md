# STAGE 8b/8c —— 第二轮突变测试（层破除）与覆盖缺口闭合

- **日期**：2026-09-25
- **被测提交（TESTED_HEAD）**：`f44519714127482b6cd11bfc640673dc542f44e4`
- **被测产物**：`plugins/learn-core.mjs`
  SHA256 `5597FD7E68D8D823EFD649F37DA23CAC7E9DB5D4A458F21B8D50E001B64B50FF`（107,536 B，本轮**零改动**）
- **本阶段唯一改动**：`tests/learn/test-learn-core.mjs`
  SHA256 `3C030127341E128F8DAED0B8523D434A4470D4200AFC70D161D823F0A855C169`（60,591 B，+213 行）
- **证据目录**：`_p4r2-evidence/stage8b-mutation-round2*.{mjs,json,txt}`
- **运行器**：`_p4r2-evidence/stage8b-mutation-round2.mjs`（`OUT_SUFFIX` 环境变量可另存一轮结果）

---

## 1. 为什么做第二轮突变

第一轮（`stage8-mutation-proof.*`）用的是**值级**突变（改常量、翻转比较、删除分支）。它证明的是
"某个具体判断是否被断言覆盖"，但**证明不了**"整层防线是否有人看着"。因此第二轮专门做
**层破除（layer defeat）**：把整层安全函数的返回值直接改成放行/放行/失效，然后看有没有任何套件变红。

判定口径（机器化，不靠人工读）：

| 结果 | 含义 |
|---|---|
| `CAUGHT` | 至少一个套件 exit≠0 ⇒ 该层有真实门禁在看守 |
| `GAP` | 全部套件仍绿 ⇒ **该层无测试证据**（防线存在但无人证明它会开火） |
| `EQUIVALENT` | 植入后行为探针未变 ⇒ 该突变不是有效突变（不计入） |

每一轮都强制要求：植入前记录字节 → 植入后校验字节已变 → 跑行为探针 → 跑全部门禁 →
**逐字节还原并校验一致** → 校验 `plugins/` 工作树干净。任一步不成立即整轮判废。

---

## 2. 第二轮结果（闭合前）

| 突变 | 破除对象 | 行为探针（确认破坏真实发生） | 判定 |
|---|---|---|---|
| M3b | `canPublish` 整层返回 `ok:true` | `canPublish(PROPOSED/UNVERIFIED).ok = true` | **GAP** |
| M4b | `containsSecret` 永远返回 `false` | `containsSecret(假密钥) = false` | CAUGHT（core + secrets 两套） |
| M5b | `validateGlobalStore` 直接放行 | 坏库/含未验证条目库均被接受 | **GAP** |
| M6b | Failure Classification 权威两处同时破除 | 伪造分类 `vetoed=false` | CAUGHT（`test-learn-ac5-gap-veto.mjs`） |

⇒ **2 条真覆盖缺口（M3b / M5b），0 条等价突变。**

---

## 3. 缺口定性：整个 Layer B 此前零覆盖

静态计数（闭合前，全部 `tests/learn/*.mjs` 命中次数）：

```
globalRecall        = 0        publishToGlobal     = 0
canPublish          = 0        validateGlobalStore = 0
isPublishable       = 0        publishSignature    = 0
```

这不是"少测了一个分支"，而是**跨会话全局已验证经验库这一整层没有任何测试**：

- 它是 P4 合同【实现原则 3】（没有真实成功证据 ⇒ 永不 VERIFIED）在**跨会话复用面**上的唯一闸门；
- 也是【复用规则】（跨会话召回必须先过适用性检查）的唯一入口；
- STAGE12 已用真实会话证明"发布→跨会话召回"链路可用（A 发布 → B 召回 = 1），但**没有任何测试
  证明这条链路被破坏时会变红**。即：功能验证通过 ≠ 防线被测试看守。

---

## 4. 闭合动作（测试侧，生产代码零改动）

在 `tests/learn/test-learn-core.mjs` 新增 **C16 段（+79 条断言，338 → 417）**，逐条对应该层每一道判断：

**夹具纪律（关键）**：一切"合法可发布经验"必须由**官方链路**产出
（`makeExperience → approve → applyVerification`，真实 `file_hash` 证据 + 注入式 resolver），
**禁止手搓**。手搓夹具会让"实现能造出什么"与"测试以为能造出什么"悄悄解耦——这正是本次缺口的成因。

覆盖清单（摘要）：

1. **发布闸门 `canPublish`**：正向 + 逐条负向原因（`proposed_never_published` /
   `rejected_never_published` / `retired_never_published` / `invalid_experience` /
   `not_verified:missing` / `not_verified:UNVERIFIED` / `method_not_machine_checkable` /
   `no_evidence_record` / `no_last_verified_at` / `no_provenance_anchors` / `contains_secret` /
   `record_too_large`）——"为什么被拒"必须可解释，不留静默死路径。
2. **单条判定 `isPublishable`**：正向 + 非对象/空对象/未验证/无时间戳/无锚点/非机器可校验方法。
3. **发布 `publishToGlobal`**：确定性、**幂等**（重复发布不涨版本）、**更新覆盖**（更晚时间戳）、
   **反陈旧覆盖**（`stale_overwrite_denied`）、**按签名去重**、未验证/提案条目被拒且不改库、
   畸形全局库入参重建空库、按 `lastVerifiedAt` 降序、**满库有界**（500 条上限，构造 500 条
   *签名各不相同* 的条目以免先被去重拦下）。
4. **写/读同构**：`validateGlobalStore(publishToGlobal(...).value) !== null` —— 发布产物必须能
   被校验器接受，禁止写路径与读路径各说各话。
5. **全局库校验 `validateGlobalStore`（fail-closed）**：`null`/数组/字符串/空对象/`schemaVersion` 不符/
   `kind` 不符/`version` 非法/字段非数组/超界/**含未验证或提案条目**/结构坏条目/**重复 id**/
   超界条目/**含密钥条目**/遥测类型不在白名单/函数入参 —— **一个坏条目 ⇒ 整库判废**，绝不"部分信任"。
6. **签名 `publishSignature`**：确定性、内容差异敏感、非对象返回空串。
7. **全局召回 `globalRecall`**：无全局库可用、空查询 `empty_query`（不噪声召回）、
   结构化返回、条目自带 `id/scope/回源锚点`、**跨会话条目必然 `VERIFICATION` 状态**、
   条目要么进结果要么被适用性检查留痕（**绝不静默消失**）。

---

## 5. 第三轮复核（闭合后，同一批突变重跑）

`OUT_SUFFIX=-after-c16 node stage8b-mutation-round2.mjs`：

```
M3b  CAUGHT（门禁真实开火）  ← test-learn-core.mjs
M4b  CAUGHT（门禁真实开火）  ← test-learn-core.mjs, test-learn-r3-secrets.mjs
M5b  CAUGHT（门禁真实开火）  ← test-learn-core.mjs
M6b  CAUGHT（门禁真实开火）  ← test-learn-ac5-gap-veto.mjs
源文件字节无损 = true    plugins 工作树干净 = true
结论：0 条为真覆盖缺口，0 条为等价突变，4 条已被现有门禁捕获
```

⇒ M3b / M5b 由 `GAP` 转为 `CAUGHT`，且捕获者正是新增的 C16 段。**缺口闭合有反向证据，不是自述。**

---

## 6. 全量回归与 CI 安全

| 项 | 闭合前（13:08） | 闭合后（13:44） |
|---|---|---|
| 套件总数 / GREEN / RED | 38 / 37 / 1 | 38 / 37 / 1 |
| 断言总数 | 1279 PASS / 2 FAIL | **1358 PASS / 2 FAIL**（+79，零新增失败） |
| `test-learn-core.mjs` | 338 PASS / 0 FAIL | **417 PASS / 0 FAIL** |
| 唯一 RED | `tests/install-plugin/verify-install-plugin.mjs`（13/2） | 同左（**逐项相同**） |

- 唯一 RED 定性：**PRE-EXISTING / UNRELATED**（改动前后 pass/fail 计数逐项相同；该套件输出与源码
  均无 `learn` 字样；其为 11 个**非 learn** 插件的 profile 副本漂移）。详见 `KNOWN_ISSUES.md`。
- **CI 安全**：新测试在空 `HOME`/`USERPROFILE` 的临时目录下重跑 = `417 PASS / 0 FAIL`，exit 0
  （仅用纯函数与注入式 resolver，不依赖本机状态）。
- **CI 接入**：`tests\learn\test-learn-core.mjs` 已在 `.github/workflows/ci-level2.yml` 的套件列表中，
  新增覆盖**自动进入 CI**，无需另改流水线。

---

## 7. 未覆盖 / 残余风险（诚实登记）

1. **`publishToGlobal` 的遥测路径未断言**：被拒发布写入 `GLOBAL_PUBLISH_DENIED` 遥测这一行为，
   本节只断言了"库未被改动"，未断言遥测条目内容。
2. **`applyVerification` 的 FAIL 分支降级路径**（VERIFIED → `REVALIDATION_REQUIRED`）本节只经
   夹具间接触及，未做独立负向断言（既有套件另有覆盖，但未与全局库发布面串联）。
3. **全局库的并发/多写者语义**未测：该层是纯函数式（调用方传库、返回新库），无锁语义可测，
   但"两个写者同时发布"的时序未在真实服务上验证。
4. **生产未部署**：learn 插件当前**未挂载**到 `~/.dsh/profiles/web/cordis.patch.yml`（该文件与
   autonomous preset 中均无 learn 条目），`profiles/web/` 下仅存一份旧的 `learn.mjs`/`learn-core.mjs`
   残余副本。本节全部结论均针对**候选侧仓库产物**；上线配方见 STAGE12 §8.3，本节不改动实盘。

---

## 8. 复现命令

```powershell
cd "C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2"

# 1) 候选侧单元套件（应 417 PASS / 0 FAIL）
node tests\learn\test-learn-core.mjs

# 2) 第二轮突变（层破除）——闭合后应 4/4 CAUGHT
cd ..\_p4r2-evidence
$env:OUT_SUFFIX = "-after-c16"; node stage8b-mutation-round2.mjs; Remove-Item Env:\OUT_SUFFIX

# 3) 全量回归（38 套件，唯一 RED 应为 install-plugin 且为既有）
cd ..\_p4r2
& tests\learn\run-r3-final-head-full.ps1
```

## 9. 回退

本阶段只改测试文件，回退 = `git checkout HEAD -- tests/learn/test-learn-core.mjs`
（生产代码 `plugins/learn-core.mjs` 全程字节未变，无生产回退需求）。
