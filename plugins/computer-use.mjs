// computer-use.mjs —— 浏览器 Computer Use 永久工具插件（2026-08-15 由演示固化）
//
// 把 2026-08-15 晚实测验证过的「CDP 常驻浏览器 + 视觉循环」能力固化为 DSH 正式工具：
// agent 在会话中直接调用 browser_* 工具操作真实网页（截图 → read_image 看图 →
// vision-bridge 自动解析 → 决策 → 点击/输入 → 再截图），不再依赖临时脚本。
//
// 工具清单：
//   browser_start   —— 启动/复用常驻无头 Chrome（正式 Chrome + 独立 profile + 代理）
//   browser_stop    —— 停止常驻浏览器（释放资源）
//   browser_open    —— 打开/跳转 URL
//   browser_info    —— 当前页标题/URL
//   browser_shot    —— 截图（支持区域 clip），返回文件路径（随后用 read_image 查看）
//   browser_labels  —— 列出页面可交互元素（label/文本/中心坐标），支持过滤
//   browser_click   —— 点击（text=/textx=/aria=/CSS 选择器）
//   browser_type    —— 向当前焦点输入文本
//   browser_press   —— 按键（Enter/Escape/Control+, 等）
//   browser_back    —— 后退
//
// 机制要点：
//   - 懒启动：任一工具调用时若 9223 未监听，自动 spawn 常驻 Chrome（detached，独立于
//     dsh 进程存活；DSH 重启后残留实例会被复用，profile 登录态长期有效）。
//   - 每次工具调用 connectOverCDP → 操作 → 断开（浏览器保持运行，页面状态持续）。
//   - 截图返回文件路径，agent 用内建 read_image 查看；vision-bridge 会把图片自动
//     解析成文字（精确模式命中"坐标/位置/布局"等关键词时走 Qwen）。
//   - 正式 Chrome 而非 Chromium for Testing：Notion 等站点会拦截后者。
//
// 挂载：~/.dsh/profiles/web/cordis.patch.yml（insert 段）：
//   - id: computer-use
//     name: './computer-use.mjs'
//     config:
//       port: 9223
//       chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
//       proxy: 'http://192.168.168.1:7890'
//       profilesDir: '<browser-bridge profiles 目录>'   # 复用 notion 登录态等
//       shotDir: '<output/playwright 目录>'
//       pwCore: '<playwright-core/index.js 路径>'
//       defaultProfile: 'default'
// 纯 ESM，无第三方依赖（playwright-core 经 createRequire 从 npx 缓存引入）。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const name = 'computer-use';
export const inject = ['tools'];

const require = createRequire(import.meta.url);

/** 模块级状态：本插件 spawn 的 Chrome 主进程（残留实例无法追溯，用端口探测兜底）。 */
let spawnedChild = null;
let currentProfile = null;

/** 配置默认值（apply 时用 config 覆盖）。 */
let cfg = {
  port: 9223,
  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  proxy: 'http://192.168.168.1:7890',
  profilesDir: 'C:\\Users\\Administrator\\Desktop\\sdeepseek harness\\DSH-Client\\browser-bridge\\profiles',
  shotDir: 'C:\\Users\\Administrator\\Desktop\\sdeepseek harness\\output\\playwright',
  pwCore: 'D:\\C盘迁移\\开发缓存\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright-core\\index.js',
  defaultProfile: 'default',
  viewport: '1366,850',
  startTimeoutMs: 20000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpReachable() {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function chromePidOnPort() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { timeout: 10000 }, (err, out) => {
      if (err) return resolve(null);
      const pid = parseInt((out || '').trim().split(/\s+/)[0], 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

async function startBrowser(profile) {
  if (await cdpReachable()) {
    return { reused: true, profile: currentProfile ?? null };
  }
  const dir = path.join(cfg.profilesDir, profile);
  mkdirSync(dir, { recursive: true });
  const [w, h] = cfg.viewport.split(',').map((n) => parseInt(n, 10));
  const child = spawn(cfg.chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cfg.port}`,
    `--user-data-dir=${dir}`,
    `--proxy-server=${cfg.proxy}`,
    '--no-first-run',
    '--disable-gpu',
    `--window-size=${w},${h}`,
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  spawnedChild = child;
  currentProfile = profile;
  const deadline = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < deadline) {
    if (await cdpReachable()) return { reused: false, profile };
    await sleep(500);
  }
  throw new Error(`浏览器启动超时（${cfg.startTimeoutMs / 1000}s）：${cfg.chromePath}`);
}

async function stopBrowser() {
  if (spawnedChild?.pid) {
    await new Promise((res) => execFile('taskkill', ['/PID', String(spawnedChild.pid), '/F'], { windowsHide: true }, () => res()));
    spawnedChild = null;
    currentProfile = null;
    return { stopped: true, via: 'spawned-pid' };
  }
  const pid = await chromePidOnPort();
  if (pid) {
    await new Promise((res) => execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => res()));
    spawnedChild = null;
    currentProfile = null;
    return { stopped: true, via: 'port-pid' };
  }
  return { stopped: false, reason: '无运行中的浏览器' };
}

async function withPage(fn) {
  await startBrowser(currentProfile ?? cfg.defaultProfile);
  const { chromium } = require(cfg.pwCore);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.port}`);
  try {
    const ctx = browser.contexts()[0];
    const page = ctx?.pages().find((p) => !p.url().startsWith('devtools')) ?? ctx?.pages()[0];
    if (!page) throw new Error('浏览器无可用页面');
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

function parseClip(s) {
  if (!s) return undefined;
  const [x, y, w, h] = s.split(',').map((n) => parseInt(n.trim(), 10));
  if (![x, y, w, h].every(Number.isFinite)) throw new Error(`clip 格式应为 "x,y,宽,高"，收到: ${s}`);
  return { x, y, width: w, height: h };
}

export function apply(ctx, config = {}) {
  cfg = { ...cfg, ...config };
  mkdirSync(cfg.shotDir, { recursive: true });
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

  ctx.tools.register(defineTool({
    name: 'browser_start',
    description: 'Start (or reuse) the persistent headless Chrome used for browser computer-use. Normally auto-started on first browser_* call; use this to explicitly pick a profile (e.g. "notion" for the saved Notion login) or to restart with a different one. Profile logins persist across dsh restarts.',
    parameters: {
      profile: { type: 'string', description: `Profile name under the profiles dir (default: "${cfg.defaultProfile}"; "notion" holds the saved Notion login).` },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, reused: { type: 'boolean' }, profile: { type: 'string' }, port: { type: 'number' } } }, render },
    async execute(args) {
      const profile = args.profile ?? cfg.defaultProfile;
      const { reused } = await startBrowser(profile);
      return { ok: true, reused, profile, port: cfg.port };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_stop',
    description: 'Stop the persistent headless Chrome (frees CPU/RAM; profile and logins are kept on disk). Browser auto-restarts on the next browser_* call.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { stopped: { type: 'boolean', required: true }, reason: { type: 'string' } } }, render },
    async execute() {
      return await stopBrowser();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open (or navigate) a URL in the persistent browser. Waits for the page, then reports title/url. Use after this to call browser_shot and read the screenshot with read_image.',
    parameters: {
      url: { type: 'string', required: true, description: 'Full URL, e.g. https://app.notion.com' },
      wait_ms: { type: 'number', description: 'Extra settle time in ms after load (default 2500).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, title: { type: 'string' }, url: { type: 'string' } } }, render },
    async execute(args) {
      return await withPage(async (page) => {
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(args.wait_ms ?? 2500);
        return { ok: true, title: (await page.title()).slice(0, 120), url: page.url() };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_info',
    description: 'Report the current page title and URL of the persistent browser.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, url: { type: 'string' } } }, render },
    async execute() {
      return await withPage(async (page) => ({ title: (await page.title()).slice(0, 120), url: page.url() }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_shot',
    description: 'Screenshot the current page (or a clip region) to a PNG file and return its path. ALWAYS follow this with the read_image tool on that path — the vision-bridge plugin auto-describes the image as structured Chinese text (exact mode for "坐标/位置/布局/UI" queries). This is the "look at the screen" step of computer-use.',
    parameters: {
      name: { type: 'string', description: 'Output file name without extension (timestamped if omitted).' },
      clip: { type: 'string', description: 'Region as "x,y,width,height" to capture only part of the viewport.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, path: { type: 'string', required: true } } }, render },
    async execute(args) {
      return await withPage(async (page) => {
        const fname = `${args.name ?? `shot-${Date.now()}`}.png`;
        const file = path.join(cfg.shotDir, fname);
        await page.screenshot({ path: file, fullPage: false, clip: parseClip(args.clip) });
        return { ok: true, path: file };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_labels',
    description: 'List visible interactive elements (aria-label / button text / link text) with their center coordinates — use this to discover what is clickable before clicking, instead of guessing. Optional keyword filter (case-insensitive substring on label+text) and limit.',
    parameters: {
      keyword: { type: 'string', description: 'Only return elements whose label/text contains this substring.' },
      limit: { type: 'number', description: 'Max items (default 60).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } } } }, render },
    async execute(args) {
      return await withPage(async (page) => {
        const raw = await page.evaluate(() => {
          const out = [];
          const els = document.querySelectorAll('[aria-label], button, [role=button], a');
          for (const el of els) {
            const label = el.getAttribute('aria-label');
            const text = (el.textContent || '').trim().slice(0, 40);
            if (!label && !text) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            if (r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
            out.push({ label: label || '', text, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
          return out;
        });
        let items = raw;
        if (args.keyword) {
          const k = args.keyword.toLowerCase();
          items = items.filter((it) => (it.label + ' ' + it.text).toLowerCase().includes(k));
        }
        items = items.slice(0, args.limit ?? 60);
        return { items };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element. Selector forms: "text=关键字" (substring match), "textx=精确文本" (exact), "aria=标签" (aria-label), or a raw CSS selector. Prefer labels from browser_labels; re-snapshot (browser_labels/browser_shot) after navigation or big UI changes since refs go stale.',
    parameters: {
      selector: { type: 'string', required: true, description: 'text=/textx=/aria= or CSS selector.' },
      wait_ms: { type: 'number', description: 'Settle time after click (default 2500).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, title: { type: 'string' }, url: { type: 'string' } } }, render },
    async execute(args) {
      return await withPage(async (page) => {
        let loc;
        if (args.selector.startsWith('text=')) loc = page.getByText(args.selector.slice(5), { exact: false }).first();
        else if (args.selector.startsWith('textx=')) loc = page.getByText(args.selector.slice(6), { exact: true }).first();
        else if (args.selector.startsWith('aria=')) loc = page.locator(`[aria-label="${args.selector.slice(5)}"]`).first();
        else loc = page.locator(args.selector).first();
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 15000 });
        await sleep(args.wait_ms ?? 2500);
        return { ok: true, title: (await page.title()).slice(0, 120), url: page.url() };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into the currently focused element (click the target field first). Use for form/input values; for keys (Enter/Escape/Tab/Ctrl+, etc.) use browser_press.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render },
    async execute(args) {
      return await withPage(async (page) => {
        await page.keyboard.type(args.text, { delay: 15 });
        return { ok: true };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: 'Press a keyboard key or combo, e.g. Enter, Escape, Tab, Control+a, Control+,, F5. Useful for shortcuts (Notion settings: Control+,) and form submission.',
    parameters: {
      key: { type: 'string', required: true, description: 'Playwright key name, e.g. Enter / Escape / Control+,' },
      wait_ms: { type: 'number', description: 'Settle time after press (default 1200).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render },
    async execute(args) {
      return await withPage(async (page) => {
        await page.keyboard.press(args.key);
        await sleep(args.wait_ms ?? 1200);
        return { ok: true };
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_back',
    description: 'Go back one page in history.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, url: { type: 'string' } } }, render },
    async execute() {
      return await withPage(async (page) => {
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(1200);
        return { ok: true, url: page.url() };
      });
    },
  }));

  ctx.logger?.info(`computer-use: 已注册 10 个 browser_* 工具（port ${cfg.port}，profile 目录 ${cfg.profilesDir}）`);
}
