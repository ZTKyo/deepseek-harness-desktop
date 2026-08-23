// completion-notify.mjs — 回合结束 Telegram 完成通知（服务内触发，2026-08-15）
//
// 背景：外部"分离进程轮询会话日志"方案连续多轮失败（v2 误报 / v3 TDZ 崩溃 /
// v4 全量解码滞后 3.5 分钟 / v5 静默卡死不轮询）且造成系统内存压力。
// 本插件改为服务内触发：Harness 自己知道回合何时结束——无需轮询、无外部进程、
// 无沙箱与孤儿进程问题。
//
// 用法（agent 纪律：作为回合最后一个动作，写入 flag 文件）：
//   $flag = @{ message = '<消息>'; sessionId = $env:DSH_SESSION_ID;
//              createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
//   [System.IO.File]::WriteAllText("$env:USERPROFILE\.dsh\completion-notify.json",
//       $flag, (New-Object System.Text.UTF8Encoding($false)))
//
// 插件监听本服务全部会话的 session/event；当 flag.sessionId 对应会话出现
// reason.kind === "completed" 的 turn/end（且时间晚于 flag.createdAt）时，
// 异步 spawn telegram-alert.ps1 发送通知并删除 flag。
// 异常结束（error/aborted/max-tokens）不发送——flag 保留，等待该会话下一次正常完成。
// telegram-alert.ps1 路径：优先 flag.alertPs1，否则由会话 header.cwd 推导
// （<cwd>\DSH-Client\telegram-alert.ps1），否则配置 config.alertPs1。
//
// 纯 ESM，无第三方依赖。

import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const name = "completion-notify";

export function apply(ctx, config = {}) {
  const FLAG = config.flagPath ?? join(homedir(), ".dsh", "completion-notify.json");

  const send = (flag, event, session) => {
    let alertPs1 = flag.alertPs1;
    if (!alertPs1 && typeof session?.header?.cwd === "string") {
      alertPs1 = join(session.header.cwd, "DSH-Client", "telegram-alert.ps1");
    }
    if (!alertPs1) alertPs1 = config.alertPs1;
    if (!alertPs1 || typeof alertPs1 !== "string") {
      ctx.logger.warn("completion-notify: 找不到 telegram-alert.ps1（flag.alertPs1 / 会话 cwd / config 均不可用）");
      return;
    }
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", alertPs1, flag.message],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("error", (error) => {
      ctx.logger.warn(`completion-notify: 发送失败（${String(error?.message ?? error)}）`);
    });
    child.on("exit", (code) => {
      ctx.logger.info(
        `completion-notify: 已发送完成通知（session=${session?.id ?? "?"}，turn=${event.data?.turn ?? event.turn}，alert exit=${code}）`
      );
    });
  };

  ctx.on("session/event", (session, event) => {
    if (!event || typeof event !== "object" || event.type !== "turn/end") return;
    const reason = event.data?.reason ?? event.reason;
    if (reason?.kind !== "completed") return; // 只对正常完成的回合发送
    let flag;
    try {
      flag = JSON.parse(readFileSync(FLAG, "utf8"));
    } catch {
      return; // 无 flag 或不可读：无事可做
    }
    if (!flag || typeof flag.message !== "string" || !flag.message) return;
    const sessionId = String(session?.id ?? session?.header?.id ?? "");
    if (!sessionId || !flag.sessionId || String(flag.sessionId) !== sessionId) return;
    if (typeof flag.createdAt === "number" && typeof event.time === "number" && event.time < flag.createdAt) return;
    try {
      rmSync(FLAG, { force: true });
    } catch {
      /* 删除失败不影响发送 */
    }
    try {
      send(flag, event, session);
    } catch (error) {
      ctx.logger.warn(`completion-notify: 发送异常（${String(error?.message ?? error)}）`);
    }
  });
}
