#!/usr/bin/env node
/**
 * 用量曲线(全家桶):只读本地服务 + 浏览器窗口。零依赖(Node >= 18)。
 *
 *   node quota-curve.mjs               # 打开曲线窗口(单实例:已有服务则直接再开一窗)
 *   node quota-curve.mjs --no-open     # 只起服务并打印 URL
 *   node quota-curve.mjs --samples x   # 指定采样 JSONL(默认 ~/.zcode/scripts/quota-samples.jsonl)
 *   node quota-curve.mjs --port 18765  # 指定端口(默认随机;端口记在 ~/.zcode/scripts/quota-curve.port)
 *   node quota-curve.mjs --idle 600    # 闲置 N 秒自动退出(默认 600,最小 60)
 *
 * 页面为原生曲线页(暗色 ECharts:今日默认视图、渐变填充、
 * 双击选周期、月视图、悬停公式),数据层改读本插件的采样 JSONL;/models 代理官方监控接口
 * (30s 节流)并附 API 估价;无凭据时曲线照常,仅模型/估价面板为空。服务只绑定 127.0.0.1。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bjFmt, bjDayStartMs, readSamples, get, findCred, setCred,
  parseModelUsage, parseToolUsage, estimateCostCny, costBreakdownCny, peakHourShareCny,
} from './zcode-usage.mjs';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const samplesFile = flagValue('--samples') || path.join(os.homedir(), '.zcode', 'scripts', 'quota-samples.jsonl');
const idleSec = Math.max(60, Number(flagValue('--idle')) || 600);
const noOpen = argv.includes('--no-open');
const portArg = Number(flagValue('--port')) || 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURVE_HTML = path.join(HERE, 'curve.html');
const ECHARTS_JS = path.join(HERE, 'echarts.min.js');
const PORT_FILE = path.join(os.homedir(), '.zcode', 'scripts', 'quota-curve.port');

// ---------- /data:采样 JSONL → 页面的 periods 形状(与 widget browser_payload 同构) ----------
/** 逐周期:按 host+resetAt 分组,采样变 [epoch_ms, 剩余%];水位非法的行忽略 */
export function curvePayloadFromFile(file, nowMs = Date.now()) {
  const byKey = new Map();
  for (const s of readSamples(file)) {
    const at = Number(s.at);
    const resetAt = Number(s.resetAt);
    const pct = Number(s.usedPct);
    if (!(at > 0) || !(resetAt > 0) || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const key = `${s.host || ''}|${resetAt}`;
    const p = byKey.get(key) || {
      provider_id: s.host || 'unknown',
      provider_name: s.host || 'unknown',
      plan_levels: new Set(),
      reset_at: resetAt,
      peak_used_percent: 0,
      samples: [],
    };
    p.plan_levels.add(String(s.level || 'unknown').toUpperCase());
    p.peak_used_percent = Math.max(p.peak_used_percent, pct);
    p.samples.push([at, Math.round((100 - pct) * 100) / 100]);
    byKey.set(key, p);
  }
  const periods = [...byKey.values()]
    .map((p) => ({ ...p, plan_levels: [...p.plan_levels], status: p.reset_at > nowMs ? 'active' : 'expired' }))
    .sort((a, b) => b.reset_at - a.reset_at)
    .slice(0, 60); // 页面与 widget 同上限:一次画 60 个周期足够
  for (const p of periods) p.samples.sort((a, b) => a[0] - b[0]);
  return { generated_at: new Date().toISOString(), periods };
}

// ---------- /models:代理官方接口(30s 节流缓存),带 API 估价 ----------
const modelsCache = new Map(); // key -> {at, payload}
let credReady = false;

function ensureCredSafe() {
  if (credReady) return true;
  const found = findCred();
  if (!found) return false;
  setCred(found);
  credReady = true;
  return true;
}

export async function modelsPayloadFor(params, nowMs = Date.now()) {
  let start = params.get ? params.get('start') : params.start;
  let end = params.get ? params.get('end') : params.end;
  const day = params.get ? params.get('date') : params.date;
  if (start && end) {
    // 终点钳制到当前(widget 同款:未来的终点官方会拒)
    if (Date.parse(`${end.replace(' ', 'T')}+08:00`) > nowMs + 5 * 60_000) end = bjFmt(nowMs);
  } else if (day) {
    const d = Date.parse(`${day}T00:00:00+08:00`);
    if (Number.isFinite(d)) {
      start = bjFmt(d);
      end = bjFmt(Math.min(d + 86_399_000, nowMs));
    }
  } else {
    start = bjFmt(bjDayStartMs(nowMs));
    end = bjFmt(nowMs);
  }
  if (!start || !end) return null;
  const key = `${start}|${end}`;
  const hit = modelsCache.get(key);
  if (hit && nowMs - hit.at < 30_000) return hit.payload;
  if (!ensureCredSafe()) return null;
  const qs = `?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`;
  const payload = { key };
  let any = false;
  try {
    payload.models = parseModelUsage(await get(`/api/monitor/usage/model-usage${qs}`));
    any = true;
  } catch { payload.models = null; }
  try {
    payload.tools = parseToolUsage(await get(`/api/monitor/usage/tool-usage${qs}`));
    any = any || payload.tools.tools.length > 0;
  } catch { payload.tools = null; }
  if (!any) {
    modelsCache.set(key, { at: nowMs, payload: null });
    return null;
  }
  // models 拉取失败时 payload.models 为 null:cost 段降级为 null,
  // 不能在这里抛 TypeError——否则整个 payload 被外层 catch 吞成 {},已成功的 tools 数据一并丢失
  payload.cost = payload.models
    ? {
        inputShare: 0.8,
        cny: estimateCostCny(payload.models.models),
        peakPct: peakHourShareCny(payload.models.hourLabels, payload.models.hourTokens),
        parts: costBreakdownCny(payload.models.models),
      }
    : null;
  modelsCache.set(key, { at: nowMs, payload });
  return payload;
}

// ---------- HTTP 服务(仅 127.0.0.1;全部 no-store) ----------
let lastSeen = Date.now();

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, file, type) {
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

const server = http.createServer((req, res) => {
  lastSeen = Date.now();
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/' || u.pathname === '/index.html') return sendFile(res, CURVE_HTML, 'text/html; charset=utf-8');
  if (u.pathname === '/echarts.min.js') return sendFile(res, ECHARTS_JS, 'application/javascript');
  if (u.pathname === '/data') return sendJson(res, curvePayloadFromFile(samplesFile));
  if (u.pathname === '/models') {
    return modelsPayloadFor(u.searchParams)
      .then((p) => sendJson(res, p || {}))
      .catch(() => sendJson(res, {}));
  }
  res.writeHead(404);
  res.end();
});

// ---------- 浏览器窗口 ----------
function openBrowser(url) {
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : [];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      try {
        spawn(exe, [`--app=${url}`, '--window-size=1180,860'], { detached: true, stdio: 'ignore' }).unref();
        return;
      } catch { /* 试下一个 */ }
    }
  }
  // 兜底:系统默认打开方式(win: start / mac: open / linux: xdg-open)
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开浏览器时至少服务还在,URL 已打印 */ }
}

// ---------- 单实例:端口文件活着 → 直接再开一窗 ----------
async function main() {
  if (!fs.existsSync(CURVE_HTML) || !fs.existsSync(ECHARTS_JS)) {
    console.error('缺少 curve.html / echarts.min.js(与脚本同目录);请完整安装插件或整目录下载');
    process.exit(2);
  }
  if (!portArg && fs.existsSync(PORT_FILE)) {
    const port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    if (port > 0) {
      try {
        const ping = await fetch(`http://127.0.0.1:${port}/data`, { signal: AbortSignal.timeout(800) });
        if (ping.ok) {
          openBrowser(`http://127.0.0.1:${port}/`);
          console.log(`曲线服务已在运行:http://127.0.0.1:${port}/`);
          return;
        }
      } catch { /* 端口文件过期,重新起 */ }
    }
  }
  server.listen(portArg || 0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    // 端口文件只由"真实窗口模式"写(--no-open 为程序化/测试模式,避免顶掉在用实例)
    if (!noOpen) {
      try {
        fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
        fs.writeFileSync(PORT_FILE, String(port));
      } catch { /* 端口文件写失败不影响 */ }
    }
    console.log(`用量曲线: ${url}  (采样 ${samplesFile};闲置 ${idleSec}s 自动退出)`);
    if (!noOpen) openBrowser(url);
    const timer = setInterval(() => {
      if (Date.now() - lastSeen > idleSec * 1000) {
        clearInterval(timer);
        if (!noOpen) {
          try { fs.unlinkSync(PORT_FILE); } catch { /* 已被新实例接管 */ }
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      }
    }, 5000);
    timer.unref();
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
