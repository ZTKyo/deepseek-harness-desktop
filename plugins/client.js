// agent-inspector-client —— 右侧 Agent Inspector 面板（浏览器端 bundle）
//
// 功能：
//   1. 聊天区右上方添加可折叠 Agent Inspector 按钮
//   2. 点击展开/收起右侧 Inspector 面板
//   3. 面板显示：Task Progress / Agents / Routing / Cost / Validation / Safety / Activity
//   4. 收起时按钮显示状态（● 72% / ✓ / ⚠ / 🔴 / ⚠ Pro）
//   5. 记住上次展开状态与宽度（localStorage）
//   6. 不干扰左侧栏
//   7. 从 session events 实时提取数据（turn/tool/model 事件）
//
// 格式：window.__ModuleLoader__.load({id, factory})
// factory 导出 apply(ctx)，ctx 提供 sessions + connection

window.__ModuleLoader__.load({
	id: "agent-inspector-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const name = "agent-inspector-client";
		const inject = ["connection", "sessions"];
		const LS_KEY_OPEN = "agent-inspector.open.v1";
		const LS_KEY_WIDTH = "agent-inspector.width.v1";

		// ───── 样式 ─────
		const CSS_TAG = "@dsh/agent-inspector-client/styles";
		const CSS = [
			".ai-panel{position:fixed;right:0;top:0;bottom:0;width:360px;max-width:80vw;background:var(--dsw-specific-menu,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);border-left:1px solid rgba(127,127,127,.18);z-index:9999;display:flex;flex-direction:column;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;transition:transform .25s ease;box-shadow:-4px 0 24px rgba(0,0,0,.12)}",
			"@media (prefers-color-scheme:dark){.ai-panel{background:#1e1e22;border-left-color:rgba(127,127,127,.22);box-shadow:-4px 0 24px rgba(0,0,0,.45)}}",
			".ai-panel-closed{transform:translateX(100%);pointer-events:none}",
			".ai-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(127,127,127,.15);flex-shrink:0}",
			".ai-title{font-size:13px;font-weight:700;letter-spacing:.3px;opacity:.92}",
			".ai-close{background:none;border:none;color:inherit;font-size:16px;cursor:pointer;opacity:.5;padding:4px 8px;border-radius:6px}",
			".ai-close:hover{opacity:1;background:rgba(127,127,127,.12)}",
			".ai-body{overflow-y:auto;flex:1;padding:12px 14px}",
			".ai-section{margin-bottom:16px}",
			".ai-section-head{font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;opacity:.65;margin-bottom:6px;display:flex;align-items:center;gap:6px}",
			".ai-section-body{font-size:12.5px;line-height:1.65}",
			".ai-badge{display:inline-block;padding:2px 7px;border-radius:8px;font-size:10.5px;font-weight:600;letter-spacing:.2px}",
			".ai-badge-green{background:rgba(34,139,34,.14);color:#228b22}",
			"@media(prefers-color-scheme:dark){.ai-badge-green{background:rgba(34,139,34,.22);color:#5eca5e}}",
			".ai-badge-yellow{background:rgba(180,140,0,.14);color:#b48c00}",
			"@media(prefers-color-scheme:dark){.ai-badge-yellow{background:rgba(180,140,0,.22);color:#e0c040}}",
			".ai-badge-red{background:rgba(220,60,60,.14);color:#dc3c3c}",
			"@media(prefers-color-scheme:dark){.ai-badge-red{background:rgba(220,60,60,.22);color:#f06060}}",
			".ai-badge-blue{background:rgba(74,125,255,.14);color:#4a7dff}",
			"@media(prefers-color-scheme:dark){.ai-badge-blue{background:rgba(74,125,255,.22);color:#7aa2ff}}",
			".ai-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0}",
			".ai-row-label{opacity:.7;font-size:11.5px}",
			".ai-row-value{font-weight:600;font-size:12px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ai-progress-bar{height:6px;border-radius:3px;background:rgba(127,127,127,.14);overflow:hidden;margin:6px 0}",
			".ai-progress-fill{height:100%;border-radius:3px;transition:width .5s ease;background:linear-gradient(90deg,#4a7dff,#a78bfa)}",
			".ai-dim{opacity:.55;font-size:11px}",
			".ai-toggle{position:fixed;right:12px;top:12px;z-index:10000;display:flex;align-items:center;gap:5px;padding:5px 10px;border-radius:10px;border:1px solid rgba(127,127,127,.2);background:rgba(255,255,255,.85);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,.08)}",
			"@media(prefers-color-scheme:dark){.ai-toggle{background:rgba(30,30,34,.88);border-color:rgba(127,127,127,.3)}}",
			".ai-toggle:hover{box-shadow:0 4px 12px rgba(0,0,0,.12)}",
			".ai-toggle-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}",
			".ai-dot-green{background:#228b22}",
			".ai-dot-yellow{background:#b48c00}",
			".ai-dot-red{background:#dc3c3c}",
			".ai-activity-item{padding:3px 0;border-bottom:1px solid rgba(127,127,127,.08);font-size:11.5px}",
			".ai-activity-time{opacity:.45;font-size:10.5px;margin-right:6px}",
		].join("\n");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=\"" + CSS_TAG + "\"]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "agent-inspector-client";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ───── 状态 ─────
		let isOpen = localStorage.getItem(LS_KEY_OPEN) === "true";

		// Inspector 状态（由 session events 驱动）
		let state = {
			status: "idle",         // idle | running | waiting | stalled | done
			model: null,            // 当前实际使用的模型
			expectedModel: null,    // 预期模型
			provider: null,         // 当前 provider
			percent: 0,             // 进度百分比
			currentStep: null,      // 当前步骤描述
			turnCount: 0,           // 回合计数
			toolCalls: 0,           // 工具调用计数
			lastEventTime: null,    // 最后事件时间
			expensive: false,       // 是否使用昂贵模型
			activity: [],           // 最近活动记录
		};

		// ───── DOM 构建 ─────
		function buildToggle() {
			const btn = document.createElement("button");
			btn.className = "ai-toggle";
			btn.id = "ai-toggle-btn";
			btn.title = "Agent Inspector (展开/收起)";
			btn.innerHTML = '<span class="ai-toggle-dot ai-dot-green" id="ai-dot"></span><span id="ai-label">Agent</span>';
			btn.onclick = togglePanel;
			return btn;
		}

		function buildPanel() {
			const panel = document.createElement("div");
			panel.className = "ai-panel" + (isOpen ? "" : " ai-panel-closed");
			panel.id = "ai-inspector-panel";
			panel.innerHTML = [
				'<div class="ai-head">',
				'  <span class="ai-title">AGENT INSPECTOR</span>',
				'  <button class="ai-close" id="ai-close-btn">✕</button>',
				'</div>',
				'<div class="ai-body">',
				'  <div class="ai-section">',
				'    <div class="ai-section-head"><span class="ai-badge ai-badge-blue" id="ai-status-badge">IDLE</span> Task</div>',
				'    <div class="ai-section-body">',
				'      <div class="ai-progress-bar"><div class="ai-progress-fill" id="ai-fill" style="width:0%"></div></div>',
				'      <div id="ai-task-text" class="ai-dim">No active task</div>',
				'    </div>',
				'  </div>',
				'  <div class="ai-section">',
				'    <div class="ai-section-head">ROUTING</div>',
				'    <div class="ai-section-body">',
				'      <div class="ai-row"><span class="ai-row-label">Expected</span><span class="ai-row-value" id="ai-exp">—</span></div>',
				'      <div class="ai-row"><span class="ai-row-label">Actual</span><span class="ai-row-value" id="ai-act">—</span></div>',
				'      <div class="ai-row"><span class="ai-row-label">Provider</span><span class="ai-row-value" id="ai-prv">—</span></div>',
				'    </div>',
				'  </div>',
				'  <div class="ai-section">',
				'    <div class="ai-section-head">METRICS</div>',
				'    <div class="ai-section-body">',
				'      <div class="ai-row"><span class="ai-row-label">Turns</span><span class="ai-row-value" id="ai-turns">0</span></div>',
				'      <div class="ai-row"><span class="ai-row-label">Tool Calls</span><span class="ai-row-value" id="ai-tools">0</span></div>',
				'      <div class="ai-row"><span class="ai-row-label">Heartbeat</span><span class="ai-row-value" id="ai-heartbeat"><span class="ai-badge ai-badge-green">Healthy</span></span></div>',
				'      <div class="ai-row"><span class="ai-row-label">Last Event</span><span class="ai-row-value ai-dim" id="ai-last">—</span></div>',
				'    </div>',
				'  </div>',
				'  <div class="ai-section">',
				'    <div class="ai-section-head">ACTIVITY</div>',
				'    <div class="ai-section-body" id="ai-activity"><span class="ai-dim">No activity</span></div>',
				'  </div>',
				'</div>',
			].join("\n");
			return panel;
		}

		function togglePanel() {
			isOpen = !isOpen;
			localStorage.setItem(LS_KEY_OPEN, String(isOpen));
			updateLayout();
		}

		function updateLayout() {
			const panel = document.getElementById("ai-inspector-panel");
			const toggle = document.getElementById("ai-toggle-btn");
			if (panel) panel.classList.toggle("ai-panel-closed", !isOpen);
			if (toggle) {
				const dot = document.getElementById("ai-dot");
				const label = document.getElementById("ai-label");
				if (dot) dot.className = "ai-toggle-dot " + dotClass();
				if (label) {
					if (state.expensive) label.textContent = "⚠ Pro";
					else if (!isOpen && state.status === "running") label.textContent = "● " + state.percent + "%";
					else if (state.status === "done") label.textContent = "✓";
					else label.textContent = "Agent";
				}
			}
		}

		function dotClass() {
			if (state.status === "running") return state.expensive ? "ai-dot-yellow" : "ai-dot-green";
			if (state.status === "stalled") return "ai-dot-red";
			if (state.status === "waiting") return "ai-dot-yellow";
			return "ai-dot-green";
		}

		function render() {
			setBadge("ai-status-badge", state.status.toUpperCase(), state.status === "running" ? "green" : state.status === "done" ? "blue" : "blue");
			setFill("ai-fill", state.percent);
			setText("ai-task-text", state.currentStep || (state.percent > 0 ? state.percent + "%" : "No active task"));
			setText("ai-exp", state.expectedModel || "—");
			setText("ai-act", state.model || "—");
			setText("ai-prv", state.provider || "—");
			setText("ai-turns", String(state.turnCount));
			setText("ai-tools", String(state.toolCalls));
			setText("ai-last", state.lastEventTime ? timeAgo(state.lastEventTime) : "—");
			// Heartbeat
			const hbEl = document.getElementById("ai-heartbeat");
			if (hbEl) {
				if (state.status === "stalled") {
					hbEl.innerHTML = '<span class="ai-badge ai-badge-red">Stalled</span>';
				} else if (state.status === "waiting") {
					hbEl.innerHTML = '<span class="ai-badge ai-badge-yellow">Suspected</span>';
				} else if (state.status === "running") {
					hbEl.innerHTML = '<span class="ai-badge ai-badge-green">Healthy</span>';
				} else {
					hbEl.innerHTML = '<span class="ai-badge ai-badge-blue">Idle</span>';
				}
			}
			// Activity
			const actEl = document.getElementById("ai-activity");
			if (actEl) {
				if (!state.activity.length) { actEl.innerHTML = '<span class="ai-dim">No activity</span>'; }
				else {
					actEl.innerHTML = state.activity.slice(-8).reverse().map(e =>
						'<div class="ai-activity-item"><span class="ai-activity-time">' + esc(e.t) + '</span>' + esc(e.text) + '</div>'
					).join("");
				}
			}
			updateLayout();
		}

		function setBadge(id, text, color) {
			const el = document.getElementById(id);
			if (el) { el.textContent = text; el.className = "ai-badge ai-badge-" + color; }
		}
		function setFill(id, pct) {
			const el = document.getElementById(id);
			if (el) el.style.width = pct + "%";
		}
		function setText(id, text) {
			const el = document.getElementById(id);
			if (el) el.textContent = text;
		}
		function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
		function timeAgo(ts) {
			const sec = Math.floor((Date.now() - ts) / 1000);
			if (sec < 5) return "just now";
			if (sec < 60) return sec + "s ago";
			if (sec < 3600) return Math.floor(sec / 60) + "m ago";
			return Math.floor(sec / 3600) + "h ago";
		}

		function addActivity(text) {
			const now = new Date();
			const t = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
			state.activity.push({ t, text: text.slice(0, 120) });
			if (state.activity.length > 20) state.activity = state.activity.slice(-20);
			state.lastEventTime = Date.now();
		}

		// ───── Session Event 订阅（核心数据源） ─────
		let lastNodeSeq = -1;
		let taskStartTime = null;
		let lastActivityTime = null;
		let stallThreshold = 120000;
		let confirmedStall = 300000;
		let currentSession = null;
		let unsubSession = null;
		let unsubList = null;

		/**
		 * 绑定到指定会话并订阅其节点变化。
		 * API 模式与 secret-gate-client 完全一致：
		 *   sessions.binding(id) → session.subscribe() → session.getSnapshot().nodes
		 */
		function bindSession(id) {
			if (unsubSession) { try { unsubSession(); } catch {} unsubSession = null; }
			currentSession = null;
			if (!id) return;
			let b = null;
			try { b = sessions.binding(id); } catch { b = null; }
			if (b && b.session) {
				currentSession = b.session;
				try { unsubSession = currentSession.subscribe(onSnapshot); } catch { currentSession = null; }
			}
			if (currentSession) seedCursor();
		}

		/** 建立游标：历史节点不触发增量，只记录最大 seq */
		function seedCursor() {
			let maxSeq = -1;
			try {
				const s = currentSession.getSnapshot();
				if (s) {
					for (const n of s.nodes || []) {
						if (typeof n.seq === "number" && n.seq > maxSeq) maxSeq = n.seq;
					}
				}
			} catch {}
			lastNodeSeq = maxSeq;
		}

		/** 会话快照变化回调：处理新增节点（assistant / tool-call / tool-result / user） */
		function onSnapshot() {
			if (!currentSession) return;
			let snap = null;
			try { snap = currentSession.getSnapshot(); } catch { return; }
			if (!snap) return;
			const nodes = snap.nodes || [];
			for (const node of nodes) {
				if (!node || typeof node.seq !== "number") continue;
				if (node.seq <= lastNodeSeq) continue;
				lastNodeSeq = node.seq;
				processNode(node);
			}
			// 心跳检测
			if (state.status === "running" && lastActivityTime) {
				const elapsed = Date.now() - lastActivityTime;
				if (elapsed > confirmedStall) { state.status = "stalled"; }
				else if (elapsed > stallThreshold) { state.status = "waiting"; }
			}
			render();
		}

		/** 处理单个节点（与 secret-gate-client 的 node.kind 一致） */
		function processNode(node) {
			const kind = node.kind;
			const now = Date.now();
			lastActivityTime = now;

			if (kind === "assistant") {
				// assistant 消息：提取模型信息
				state.turnCount = (state.turnCount || 0) + (state._lastWasAssistant ? 0 : 1);
				state._lastWasAssistant = true;
				const model = node.model;
				if (model) {
					state.model = model;
					state.expensive = /pro|opus|gpt-5/i.test(model);
				}
				state.status = "running";
				addActivity("Assistant: " + (node.text || "").slice(0, 80));
			}
			else if (kind === "user") {
				state._lastWasAssistant = false;
				state.status = "running";
				addActivity("User message");
			}
			else if (kind === "tool-call") {
				state.toolCalls = (state.toolCalls || 0) + 1;
				const toolName = node.name || "tool";
				addActivity("Tool: " + toolName);
			}
			else if (kind === "tool-result") {
				addActivity("Tool result: " + (node.name || ""));
			}
			estimateProgress();
		}

		// ───── 真实进度估算（基于活动密度，非时间线性） ─────
		function estimateProgress() {
			if (state.status === "idle" || state.status === "done") return;
			// 基于已完成的 turns + tool calls 估算
			const turnScore = Math.min((state.turnCount || 0) * 15, 60);
			const toolScore = Math.min((state.toolCalls || 0) * 3, 30);
			const total = Math.min(turnScore + toolScore, 95);
			if (total > state.percent) {
				state.percent = total;
			}
			// 当前步骤描述
			if ((state.toolCalls || 0) > 0 && (state.turnCount || 0) > 0) {
				state.currentStep = "Turn " + state.turnCount + " · " + state.toolCalls + " tool calls";
			} else if ((state.turnCount || 0) > 0) {
				state.currentStep = "Turn " + state.turnCount + " in progress";
			}
		}

		// ───── 宿主数据推送监听（WPF 客户端 WebView2） ─────
		if (typeof window !== "undefined" && window.chrome && window.chrome.webview) {
			window.chrome.webview.addEventListener("message", function (ev) {
				try {
					const d = JSON.parse(ev.data);
					if (d && d.__DSH_AGENT_INSPECTOR__) {
						const s = d.state;
						if (s) Object.assign(state, s);
						render();
					}
				} catch (e) {}
			});
		}

		// ───── 初始化 ─────
		function init() {
			ensureCss();
			if (!document.getElementById("ai-toggle-btn")) document.body.appendChild(buildToggle());
			if (!document.getElementById("ai-inspector-panel")) document.body.appendChild(buildPanel());
			const closeBtn = document.getElementById("ai-close-btn");
			if (closeBtn) closeBtn.onclick = togglePanel;
			updateLayout();
		}

		// ───── 插件主体（apply 由 module loader 调用） ─────
		function apply(ctx) {
			const sessions = ctx.sessions;
			init();

			// 响应式订阅会话列表变化（与 secret-gate-client 相同模式）
			unsubList = sessions.list.subscribe(() => {
				let snap = null;
				try { snap = sessions.list.getSnapshot(); } catch { return; }
				const id = snap && snap.current;
				if (id) bindSession(id);
			});

			// 初始绑定
			let snap0 = null;
			try { snap0 = sessions.list.getSnapshot(); } catch { snap0 = null; }
			if (snap0 && snap0.current) bindSession(snap0.current);

			// 清理：ctx.effect（与 secret-gate-client 一致）
			ctx.effect(() => () => {
				if (unsubSession) try { unsubSession(); } catch {}
				if (unsubList) try { unsubList(); } catch {}
			}, "agent-inspector-client: subscriptions");
		}

		exports.apply = apply;
		exports.name = name;
		exports.inject = inject;
		return module.exports;
	}
});
