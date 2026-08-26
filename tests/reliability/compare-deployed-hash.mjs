// compare-deployed-hash.mjs — R2-3: 对比 repo 源 vs 已部署目标位的 sha256
// 用法: node compare-deployed-hash.mjs [--repair]  (--repair 用 install-plugin 同步)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const REPO = process.cwd();
const PLUGINS_DIR = path.join(REPO, "plugins");
const profileDir = path.join(os.homedir(), ".dsh", "profiles", "web");
const presetDir = path.join(os.homedir(), ".dsh", ".agent-presets", "autonomous");
const names = ["context-memory-core.mjs", "context-memory.mjs"];
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

let anyDiff = false;
for (const n of names) {
  const src = path.join(PLUGINS_DIR, n);
  const dst = path.join(profileDir, n);
  if (!fs.existsSync(src)) { console.log(`SKIP ${n}: no repo source`); continue; }
  if (!fs.existsSync(dst)) { console.log(`MISS ${n}: not deployed to ${dst}`); anyDiff = true; continue; }
  const hs = sha(src), hd = sha(dst);
  const ok = hs === hd;
  console.log(`${ok ? "MATCH" : "DIFF "} ${n}: src=${hs.slice(0, 16)} dep=${hd.slice(0, 16)}`);
  if (!ok) anyDiff = true;
}

// config 引用存在性：至少一个配置文件启用（R1 设计 = autonomous 预设启用）
{
  const enabled = [];
  for (const c of [
    { p: path.join(presetDir, "agent.cordis.yml"), label: "preset agent.cordis.yml" },
    { p: path.join(profileDir, "cordis.patch.yml"), label: "profile cordis.patch.yml" },
  ]) {
    if (!fs.existsSync(c.p)) { console.log(`MISS ${c.label}: not found`); anyDiff = true; continue; }
    const t = fs.readFileSync(c.p, "utf8");
    if (/context-memory/.test(t)) enabled.push(c.label);
  }
  if (enabled.length === 0) { console.log("MISS no config enables context-memory"); anyDiff = true; }
  else { console.log(`OK   enabled in: ${enabled.join(", ")}`); }
}

console.log(anyDiff ? "\nRESULT: DEPLOYMENT DIFFERS FROM REPO (need sync)" : "\nRESULT: ALL MATCH (deployed == repo)");
process.exit(anyDiff ? 1 : 0);
