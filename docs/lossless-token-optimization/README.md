# 🔥 Lossless Token Optimization — Fixing a Silent Tool-Output Leak in DeepSeek Harness

> **Discovered & fixed on 2026-08-20.** A silent defect in the harness's built-in
> `tool-result-pruner` meant oversized tool outputs (2万–5.8万 chars) were **never
> pruned** — they rode along in the model context for the *entire rest of the
> session*, inflating every single call and amplifying cache-miss blowups.
> This repo documents the evidence, the root cause, and the fix.

---

## 🐛 The Bug: Your "auto-pruner" Never Actually Prunes

DeepSeek Harness ships a `dsh-compaction-tool-result-pruner` component whose job is:
*"if a tool result is huge, trim it to head + tail so it stops hogging context."*
Sounds great. **It doesn't work.** Two independent defects:

### 1️⃣ It only wakes up at 60% context pressure — which never happens
`dsh-compaction-basic` only calls the pruner *inside* `compactIfNeeded()`, which fires
at `thresholdRatio: 0.6` of the model's context window. For Muse Spark 1.2 (1M window)
that means **629K tokens**. Day-to-day tasks never get there → **the pruner never runs.**

### 2️⃣ Even when it runs, it measures the WRONG thing — literally 0 chars
The real tool-result message shape is **nested**:

```
message.content = [ { type: 'tool-result', content: [ { type: 'text', text: '<50,000 chars>' } ] } ]
```

But `measureContent()` only counts **top-level** blocks where `block.type === 'text'`
(`dsh-compaction-tool-result-pruner/lib/index.js:79-81`). The top-level block is
`tool-result`, not `text` → **measureContent returns 0** → `totalChars <= threshold`
→ *"nothing to prune."* So even under pressure, **nothing ever gets pruned.**

### 📊 The Receipts (real session data, not vibes)

Scanned 115 sessions / ~7,000 model calls from `~/.dsh/sessions`:

| Model | Sessions | Calls | Total context | Cache hit | Oversized results never pruned |
|---|---:|---:|---:|---:|---:|
| Muse Spark 1.2 (Command Code) | 4 | 392 | **51.7M tokens** | 80.8% | **24 results, ~500K chars** |
| DeepSeek V4 Flash (OpenCode) | 75 | 4,939 | 1.23B tokens | 97.2% | many |

- Muse average context per call: **131,812 tokens** (25,337 new + 106,475 cached)
- **Cache-miss steps**: `inputTokens` spiked to **242,595** — the whole history, giant
  outputs included, re-billed at full price
- A single 27K-char `pwsh` directory listing was re-sent on **every** subsequent call

**The smoking gun:** in two Muse sessions, **24/24 oversized tool results carried zero
prune markers** — the built-in pruner had never touched a single one.

---

## 🔧 The Fix: `tool-output-offload.mjs` (a drop-in plugin)

We did **not** patch the running harness core (self-hosting red line). Instead we wrote
a small plugin that mounts on the same `agent/pre-step` hook as the built-in
compaction, and does the job *correctly*:

- **Recursive measurement** — digs into the nested `tool-result` shape and counts the
  real text (5万 chars is 5万 chars, not 0)
- **Recursive trimming** — anything over 8,192 chars becomes
  `head(4,096) + "[... tool result middle pruned ...]" + tail(1,024)` (≈ 5,159 chars)
- **100% lossless & protocol-compatible** — uses the harness's own shadow-price
  protocol (`compaction/prune` shadow event + `tool/result` surface `replace` with
  `sourceEventSeqs`). The original full text stays in the append-only session log,
  fully retrievable. Replay validation passes. Idempotent.
- **Zero routing / model / context-window changes** — pure context packaging.

### Install

```powershell
# 1. copy the plugin next to your autonomous preset
Copy-Item plugins/tool-output-offload.mjs "$env:USERPROFILE\.dsh\.agent-presets\autonomous\"

# 2. register it FIRST in the compaction group of agent.cordis.yml:
#    - id: tool-output-offload
#      name: './tool-output-offload.mjs'
#    (must sit before compaction-basic so big outputs are trimmed before pressure check)

# 3. next new session picks it up automatically (preset mount detects file change);
#    no service restart needed.
```

### Uninstall
Remove the row from `agent.cordis.yml` and delete the plugin file. That's it.

---

## ✅ Verified Results

### Offline A/B (replaying real sessions with/without the plugin)

| Session | Reduction per call |
|---|---:|
| Muse session A | **38.4%** |
| Muse session B | **23.9%** |
| DeepSeek session | **12.6%** |

→ **Average ≈ 25% fewer input tokens per call**, all from cutting genuinely redundant
(and fully recoverable) tool-output payloads. Well past the 15% bar.

### Live run (real GUI session)

- 2/2 oversized outputs pruned: `16,012 → 5,159` chars, same `callId`, original intact
- `compaction/prune` shadow events recorded (`shadowedSeqs`, `shadowedTokenCount`)
- Surface replacement valid (`264 replaces 261`, `396 replaces 393`)
- **Session health: 2/2 turns `completed`, 0 errors**
- Same harness, old-session control: **14/15 oversized outputs NOT pruned** → the
  improvement is real and attributable to the plugin

### What did NOT change
- ✅ Model routing / provider priority / fallback — untouched
- ✅ Context windows — untouched (Muse 1,048,576 / DeepSeek 1,000,000)
- ✅ Reasoning quality / tools / streaming — untouched
- ✅ Tool evidence — original outputs still in `~/.dsh/sessions/**/session.jsonl.zstd`

---

## 🧰 Audit Scripts (`audit-scripts/`)

Read-only diagnostic tools used to find and quantify the leak:

| Script | Purpose |
|---|---|
| `decode-session.cjs` | multi-frame zstd session log decoder |
| `usage-summary.cjs` | per-model token/cache summary across all sessions |
| `usage-trend.cjs` | per-turn context growth curves |
| `tool-result-audit2.cjs` | oversized tool-result census (nested-aware) |
| `offline-ab.cjs` | replay sessions with/without pruning → % reduction |
| `verify-live.cjs` | shadow-event / surface-replace / retrievability check |
| `verify-plugin-protocol.cjs` | protocol-compatibility proof against real `dsh-session` |

---

## 💡 What this means for the ecosystem

If you run DeepSeek Harness with a big-context model (Muse, 1M-token DeepSeek routes)
and ever wondered *"why does my context crawl toward 190K and my cache-miss bills
hurt"* — this is one of the answers. The built-in pruner is structurally blind to the
real message shape; this plugin restores the intended behavior without touching core.

**Star the project, try the plugin, and tell us if your per-call context drops ~25%.**
If the upstream harness ever fixes `measureContent` to understand nesting, this plugin
becomes a no-op — until then, it's the difference between paying for 50K of dead text
on every turn or not.

---

## 📄 License
MIT — do whatever, just don't blame us if your context is *still* fat (it won't be).
