# PHASE 02.75 SUPERVISOR — REPORT HF2：CORRECTING 读时粘滞修复（2026-09-01）

## 结论
- **状态**：FIXED + VERIFIED（分支 `hf2-supervisor-correcting-persistence`，修复 commit `b32852d`）。
- **一句话**：`deriveControlState` 读时真值推导把 `phase=complete` 一律映射 `harness_complete`，
  `controlReducer` 将 `CORRECTING → AWAITING_REVIEW`；宿主 goal 已 complete 的会话纠偏
  （02.8 R1 交付后的典型场景）在 `get_goal` 首读即把 review FAIL 的显式监督裁定抹回
  `AWAITING_REVIEW`，重启/新读持续丢失。修复为**读路径持有**：`CORRECTING + complete` 时
  原样返回（与 `pendingMutation` 持有同构），显式命令出口不变。

## 根因与设计依据
- §13 契约：`CORRECTING` 只能由显式 review FAIL 到达；其唯一合法出口也是显式命令
  （`send_correction → RUNNING` · `recordReview PASS/FAIL → VERIFIED/CORRECTING/BLOCKED` ·
  `cancel → CANCELLED`）。读时推导不应产生"隐形出口"。
- Completion Truth 的读时映射只应作用于 `RUNNING/DISPATCHED`（RUNNING → AWAITING_REVIEW
  语义保持不变，e2e read#1 断言覆盖）。
- `completionReason: 'harness_goal_complete'` 在持有分支仍随读返回（下游提示语义不丢）。

## 修复面
- `plugins/supervisor-bridge-core.mjs`：`deriveControlState` 增加一处持有分支（+10 行），
  无 schema/路由/账本改动。

## 验证（全部 exit 0/全绿）
1. **复现**：canonical main（fd26b08）上 `tests/supervisor/e2e-hf2-correcting-persistence.mjs`
   `HF2_EXPECT=squeeze` → exit 42（read#2 CORRECTING 被压回 AWAITING_REVIEW，复现稳定非瞬态）。
2. **修复**：同一测试 `HF2_EXPECT=sticky` → exit 0，32/32 PASS：
   - read#2 / read#3 CORRECTING 粘滞稳定；
   - 纠偏链 correction#1..3 → generation 2/3/4 + 重读回 AWAITING_REVIEW（RUNNING 不粘滞）；
   - 预算尽 FAIL#4 → BLOCKED（终态稳定）；cancel → CANCELLED + 重放幂等；
   - **Leg C**：重启/重读零漂移（before=CORRECTING）。
3. **回归**：`test-supervisor-mutation-state.mjs` 19/19（含 M9b FAIL→CORRECTING→correction
   连续性）；`run-supervisor-ci-e2e.mjs` 三阶段 ALL PHASES PASS（幂等/重放/连续性/坏账本
   fail-closed/无插件回退）。

## 复跑手册
```
node tests/supervisor/e2e-hf2-correcting-persistence.mjs          # sticky（修复态），exit 0
HF2_EXPECT=squeeze node tests/supervisor/e2e-hf2-correcting-persistence.mjs  # 旧语义复现，exit 42
node tests/supervisor/test-supervisor-mutation-state.mjs          # 单元回归 19/19
node tests/supervisor/run-supervisor-ci-e2e.mjs                   # 三阶段真实 E2E
```

## 回滚
`git revert b32852d`（分支内单 commit 修复 + 单 commit 文档；无部署侧状态）。

## 运行时部署证据（2026-09-01 收口补充）
- **事务化部署**：部署前备份 `~/.dsh/profiles/web/supervisor-bridge-core.mjs.bak-hf2-20260901`（回滚锚）；
  部署字节 == 仓库字节（core `5d012c56…` / bridge `057bbc0f…` 双文件 sha256 MATCH）。
- **受控重启**：经 `restart-dsh-server-delayed.ps1`（已提前告知用户）重启加载；
  `GET /supervisor/health` identity 三环一致：loaded sha256（bridge `057bbc0f…` / core `5d012c56…`）
  == deployed == repo；`ledger.state=OK`（receipts=4, error=null）。
- **重启后回归（全部真实执行）**：HF2 sticky E2E `32 passed, 0 failed`（transient500(get_goal)=0
  观察项）＋ mutation 套件 `19 passed, 0 failed`；活体态复查：P3 冻结态完好
  （sg-b734914c… gen=2 / AWAITING_REVIEW / verdict=FAIL，未执行 reconcile）＋
  HF1 VERIFIED 态完好（sg-15fc877d… gen=4 / VERIFIED / PASS）。
- **CI**：PR #80 三 gate 全绿后 merged=`2bf4194`；02.8 分支同步 main 后 head `7399a0b`
  CI L1/L2/L3 全部 success。
