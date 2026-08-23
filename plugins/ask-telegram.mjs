// ask-telegram.mjs —— ask_user_question 远程通道（host 侧，2026-08-15）
//
// 把 GUI 的 ask_user_question 弹窗桥接到 Telegram 手机端：
//   1) 本插件经 webServer.tapIndex 注入浏览器脚本 ask-telegram-client.js，
//      它检测到问题弹窗出现时 POST http://127.0.0.1:<port>/question → 写 pending 文件；
//   2) 常驻 bot（DSH-Client/telegram-bot/telegram-bot.mjs）轮询 pending 目录，
//      用 InlineKeyboard 把问题+选项推到用户手机 Telegram；
//   3) 用户在手机点击选项 → bot 写 answers/<hash>-<ts>.json；
//   4) 浏览器脚本轮询 GET /answers，按题目文本匹配后自动点击 GUI 弹窗对应选项
//      （走 DSH 正常提交链路，不碰核心代码）。
//
// 注入机制说明（2026-08-16 修正）：曾用 client 插件包（telegram-answer-client +
// profiles/node_modules junction）注册，但 cordis loader 的用户级 client 包始终
// 未进入 boot manifest（secret-gate-client 亦如此）——故改用 host 插件直接
// webServer.register + tapIndex 注入纯浏览器脚本（与 client-modules 同款机制）。
//
// 文件布局（answersRoot，默认 ~/.dsh/telegram-answers/）：
//   pending/<ts>-<hash>.json   待 bot 发送的问题（发送后 bot 移入 sent/）
//   sent/<ts>-<hash>.json      bot 已发送、等待用户手机选择的问题
//   answers/<hash>-<ts>.json   用户手机选择的答案（浏览器脚本消费）
// 其中 hash = sha1(题目文本).slice(0,8)（bot 的 callback_data 用 hash+选项序号定位）。
//
// 挂载：~/.dsh/profiles/web/cordis.patch.yml（insert 段）：
//   - id: ask-telegram
//     name: './ask-telegram.mjs'
//     config: { answersRoot: 'C:\\Users\\Administrator\\.dsh\\telegram-answers', httpPort: 9240 }
// 纯 ESM，零第三方依赖（node:http + node:fs）。删除本段即还原。

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const name = 'ask-telegram';
export const inject = ['webServer'];

let cfg = {
  answersRoot: path.join(homedir(), '.dsh', 'telegram-answers'),
  httpPort: 9240,
  cleanupDays: 7,
};

/** 浏览器端脚本（与插件同目录），经 webServer 注入页面。 */
const CLIENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ask-telegram-client.js');

function hashOf(title) {
  return createHash('sha1').update(String(title ?? '')).digest('hex').slice(0, 8);
}

function jsonFile(dir, file) {
  try {
    return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return null;
  }
}

export function apply(ctx, config = {}) {
  cfg = { ...cfg, ...config };
  const pendingDir = path.join(cfg.answersRoot, 'pending');
  const sentDir = path.join(cfg.answersRoot, 'sent');
  const answersDir = path.join(cfg.answersRoot, 'answers');
  for (const d of [pendingDir, sentDir, answersDir]) mkdirSync(d, { recursive: true });

  // ---- 注入浏览器端脚本（tapIndex + register，client-modules 同款机制） ----
  let clientJs = '';
  let clientRev = '0';
  try {
    clientJs = readFileSync(CLIENT_JS_PATH, 'utf8');
    clientRev = createHash('sha1').update(clientJs).digest('hex').slice(0, 8);
    ctx.webServer?.register({
      kind: 'exact',
      path: '/ask-telegram-client.js',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(clientJs);
      },
    });
    ctx.webServer?.tapIndex((html) =>
      html.includes('/ask-telegram-client.js')
        ? html
        : html.replace('</head>', `<script defer src="/ask-telegram-client.js?rev=${clientRev}"></script></head>`)
    );
    ctx.logger?.info(`ask-telegram: 已注入浏览器脚本（rev=${clientRev}）`);
  } catch (e) {
    ctx.logger?.warn(`ask-telegram: 浏览器脚本注入失败: ${e.message}`);
  }

  // CORS 头：页面（127.0.0.1:3080）跨源访问本端点
  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };
  const sendJson = (res, code, obj) => {
    cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.httpPort}`);
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    // POST /question —— 前端插件报告问题弹窗出现（含当前题文本与选项）
    if (req.method === 'POST' && url.pathname === '/question') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const q = JSON.parse(body || '{}');
          const title = String(q.title ?? '').trim();
          const options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
          if (!title) return sendJson(res, 400, { ok: false, reason: 'empty title' });
          const hash = hashOf(title);
          const file = `${Date.now()}-${hash}.json`;
          writeFileSync(
            path.join(pendingDir, file),
            JSON.stringify({ hash, title, options, multiSelect: q.multiSelect === true, at: Date.now(), uid: randomUUID() }, null, 2),
            'utf8'
          );
          sendJson(res, 200, { ok: true, hash, file });
        } catch (e) {
          sendJson(res, 500, { ok: false, reason: String(e.message ?? e) });
        }
      });
      return;
    }
    // GET /answers —— 前端插件轮询手机端答案
    if (req.method === 'GET' && url.pathname === '/answers') {
      try {
        const list = readdirSync(answersDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => jsonFile(answersDir, f))
          .filter(Boolean)
          .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
        sendJson(res, 200, { ok: true, answers: list });
      } catch (e) {
        sendJson(res, 500, { ok: false, reason: String(e.message ?? e) });
      }
      return;
    }
    // POST /tick-log —— 前端脚本上报每次检测结果（调试用，供 GET /tick-log 读取）
    if (req.method === 'POST' && url.pathname === '/tick-log') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const ts = new Date().toISOString().slice(11, 19);
          const file = path.join(cfg.answersRoot, 'tick.log');
          writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : '') + `[${ts}] ${body.slice(0, 500)}\n`, 'utf8');
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 500, { ok: false, reason: String(e.message ?? e) });
        }
      });
      return;
    }
    // GET /tick-log —— 读取前端脚本调试日志（最近 30 行）
    if (req.method === 'GET' && url.pathname === '/tick-log') {
      try {
        const file = path.join(cfg.answersRoot, 'tick.log');
        const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-30) : [];
        sendJson(res, 200, { ok: true, lines });
      } catch (e) {
        sendJson(res, 500, { ok: false, reason: String(e.message ?? e) });
      }
      return;
    }
    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, pending: readdirSync(pendingDir).length, sent: readdirSync(sentDir).length, answers: readdirSync(answersDir).length });
      return;
    }
    sendJson(res, 404, { ok: false, reason: 'not found' });
  });

  server.on('error', (e) => ctx.logger?.warn(`ask-telegram: HTTP 服务启动失败（端口 ${cfg.httpPort}）: ${e.message}`));
  server.listen(cfg.httpPort, '127.0.0.1', () => {
    ctx.logger?.info(`ask-telegram: 已就绪 http://127.0.0.1:${cfg.httpPort}（answersRoot=${cfg.answersRoot}）`);
  });

  // 定期清理过期文件（防堆积）
  const cleanup = setInterval(() => {
    try {
      const cutoff = Date.now() - cfg.cleanupDays * 86400000;
      for (const dir of [pendingDir, sentDir, answersDir]) {
        for (const f of readdirSync(dir)) {
          const p = path.join(dir, f);
          try {
            if (existsSync(p)) {
              // 文件名：pending/sent 为 <ts>-<hash>.json；answers 为 <hash>-<ts>.json。
              // 统一提取 13 位毫秒时间戳判断，超期删除（实现 cleanupDays 语义）。
              const m = f.match(/(\d{13})/);
              const ts = m ? Number(m[1]) : NaN;
              if (Number.isFinite(ts) && ts < cutoff) unlinkSync(p);
            }
          } catch {}
        }
      }
    } catch {}
  }, 3600000);
  cleanup.unref?.();
  ctx.on?.('dispose', () => {
    clearInterval(cleanup);
    server.close();
  });
}
