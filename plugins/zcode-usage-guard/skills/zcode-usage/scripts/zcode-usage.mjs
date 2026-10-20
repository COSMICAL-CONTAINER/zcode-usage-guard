#!/usr/bin/env node
/**
 * GLM / 智谱 Coding Plan 用量查询(零依赖,需 Node >= 18)
 *
 * 数据来源与官方 glm-plan-usage 插件相同:
 *   GET {domain}/api/monitor/usage/quota/limit   —— 5 小时池 / 每周额度 / MCP 每月额度
 *   GET {domain}/api/monitor/usage/model-usage   —— 模型 token 用量(当日)
 *   GET {domain}/api/monitor/usage/tool-usage    —— MCP 工具调用(当日)
 * domain 取自 baseURL:open.bigmodel.cn(智谱)或 api.z.ai(国际)。
 *
 * API Key 自动读取顺序(靠前的优先):
 *   1. --key/--base 运行参数
 *   2. 环境变量 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
 *   3. 手动配置文件 ~/.zcode/zcode-usage-manual.json
 *      (macOS HUD / Windows 悬浮窗的「🔑 配置 API Key」界面写入,CLI 查询同样生效)
 *   4. ZCode 配置 ~/.zcode/v2/config.json(兼容 ~/.zcode/config.json):
 *      扫描全部已启用 provider(不再只认固定 4 个名字,自定义 provider 也能识别),
 *      但只接受 open.bigmodel.cn / api.z.ai 两个域名——zcode.z.ai(启动版套餐)没有
 *      /api/monitor 监控接口,拿它的凭据查询必然 404,宁可报「未找到 Key」
 *      引导用户走悬浮窗的 🔑 手动配置
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const asHook = argv.includes('--hook');
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// 额度采样历史:--samples 改存储路径,
// --quota-history [N] / --export-quota-csv <path> 为纯本地视图(无需凭据)
const samplesArg = flagValue('--samples');
const exportQuotaCsvArg = flagValue('--export-quota-csv');
const quotaHistoryCount = (() => {
  const n = parseInt(flagValue('--quota-history'), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60) : 8;
})();

// ---------- 自安装:node zcode-usage.mjs --install ----------
const COMMAND_MD = `---
description: 查询智谱 GLM Coding Plan 的 5 小时/每周/每月额度与用量
---

运行以下命令查询 Coding Plan 用量:

\`\`\`bash
node ~/.zcode/scripts/zcode-usage.mjs
\`\`\`

(若 ~ 无法展开,改用: node "$HOME/.zcode/scripts/zcode-usage.mjs")

然后将输出用简洁的中文表格汇报给用户,必须包含:

1. **5 小时 Prompt 池**:已用百分比、重置时间(倒计时)
2. **每周额度**:已用百分比、重置时间
3. **MCP 工具调用(每月)**:已用/总量、剩余次数、重置时间、各工具明细
4. **当日模型用量**:调用次数、token 消耗、高峰期(工作日 14–18 时)/非高峰期拆分、按模型汇总(如有)
5. **近7天窗口平均水位**:如输出含该行则一并汇报(口径:各五小时周期末次已用%
   按窗口加权平均;末次观测是下界,周期最终使用率未知);用户想看逐周期水位历史时,
   运行 node ~/.zcode/scripts/zcode-usage.mjs --quota-history(纯本地读取,无需凭据);
   用户想看曲线图时,运行 node ~/.zcode/scripts/quota-curve.mjs(独立窗口,立即返回)

如果命令执行失败,原样展示错误信息,并提示用户:API Key 存放在 ~/.zcode/v2/config.json,
可在 ZCode 的模型设置中重新配置,或去智谱开放平台「个人编程套餐 > 用量统计」网页版查看。

不要改写或猜测数字,一切以脚本输出为准;如需原始 JSON,可运行带 --json 参数的同一命令。
`;

if (argv.includes('--install')) {
  const home = os.homedir();
  const scriptDest = path.join(home, '.zcode', 'scripts', 'zcode-usage.mjs');
  const commandDest = path.join(home, '.zcode', 'commands', 'usage.md');
  fs.mkdirSync(path.dirname(scriptDest), { recursive: true });
  fs.mkdirSync(path.dirname(commandDest), { recursive: true });
  const selfPath = fileURLToPath(import.meta.url);
  if (path.resolve(selfPath) !== path.resolve(scriptDest)) {
    fs.copyFileSync(selfPath, scriptDest);
  }
  fs.writeFileSync(commandDest, COMMAND_MD, 'utf8');
  console.log('安装完成:');
  console.log(`  脚本   -> ${scriptDest}`);
  console.log(`  命令   -> ${commandDest}(ZCode 新开对话输入 /usage)`);

  // 悬浮窗(仅 Windows,且安装目录里带有 widget 脚本)
  const selfDir = path.dirname(selfPath);
  const widgetSrc = path.join(selfDir, 'zcode-usage-widget.ps1');
  if (process.platform === 'win32' && fs.existsSync(widgetSrc)) {
    const widgetDest = path.join(home, '.zcode', 'scripts', 'zcode-usage-widget.ps1');
    fs.copyFileSync(widgetSrc, widgetDest);
    const winPath = widgetDest.replace(/\//g, '\\');
    const vbs = `CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${winPath}""", 0, False\r\n`;
    const launchVbs = path.join(home, '.zcode', 'scripts', 'zcode-usage-widget-launch.vbs');
    fs.writeFileSync(launchVbs, vbs, 'ascii');
    // 开机自启
    const startupDir = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    fs.mkdirSync(startupDir, { recursive: true });
    fs.writeFileSync(path.join(startupDir, 'zcode-usage-widget.vbs'), vbs, 'ascii');
    // 立即弹出悬浮窗(已有实例在运行时,会自动唤起到前台)
    spawn('wscript.exe', [launchVbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log('  悬浮窗 -> 已安装并启动(置顶显示,每 10 分钟刷新)');
    console.log('           隐藏/唤回:Ctrl+G 全局快捷键;启动 ZCode 时也会自动唤起');
    console.log('           开机自启已开启(悬浮窗右键菜单可关闭)');
  } else if (process.platform === 'win32') {
    console.log('  悬浮窗 -> 未安装(当前目录没有 zcode-usage-widget.ps1;从完整 zip 安装可获得)');
  }
  // 用量曲线(全家桶):quota-curve.mjs + curve.html + echarts.min.js 三件套
  const curveFiles = ['quota-curve.mjs', 'curve.html', 'echarts.min.js'];
  if (fs.existsSync(path.join(selfDir, 'curve.html'))) {
    for (const f of curveFiles) {
      const src = path.join(selfDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(home, '.zcode', 'scripts', f));
    }
    console.log('  用量曲线 -> 已安装(node ~/.zcode/scripts/quota-curve.mjs 打开;悬浮窗右键菜单「📈 用量曲线」)');
  }
  process.exit(0);
}

// ---------- 反安装:清除 --install 安装的全部内容 ----------
if (argv.includes('--uninstall')) {
  const home = os.homedir();
  const { exec } = await import('node:child_process');
  const removed = [];
  // 1. 结束悬浮窗进程
  if (process.platform === 'win32') {
    exec('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'powershell.exe\'\'\' | Where-Object { $_.CommandLine -match \'zcode-usage-widget\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      () => { });
  }
  // 2. 删除文件
  const targets = [
    path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'zcode-usage-widget.vbs'),
    path.join(home, '.zcode', 'scripts', 'zcode-usage.mjs'),
    path.join(home, '.zcode', 'scripts', 'zcode-usage-widget.ps1'),
    path.join(home, '.zcode', 'scripts', 'zcode-usage-widget-launch.vbs'),
    path.join(home, '.zcode', 'scripts', 'zcode-usage-widget.pos.json'),
    path.join(home, '.zcode', 'scripts', 'quota-curve.mjs'),
    path.join(home, '.zcode', 'scripts', 'curve.html'),
    path.join(home, '.zcode', 'scripts', 'echarts.min.js'),
    path.join(home, '.zcode', 'scripts', 'quota-curve.port'),
    path.join(home, '.zcode', 'commands', 'usage.md'),
  ];
  // 采样历史(quota-samples.jsonl)与周期台账/设置一样属于用户数据,卸载不删
  for (const t of targets) {
    if (fs.existsSync(t)) { fs.rmSync(t); removed.push(t); }
  }
  // 3. 移除 cli 配置里的 SessionStart hook
  const cliConfig = path.join(home, '.zcode', 'cli', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cliConfig, 'utf8'));
    if (cfg.hooks && cfg.hooks.events) {
      // 只移除引用了 zcode-usage 的 hook 条目,保留用户自己的其他 hooks
      const hookText = (h) => JSON.stringify(h);
      let touched = false;
      for (const ev of Object.keys(cfg.hooks.events)) {
        const groups = cfg.hooks.events[ev] || [];
        const kept = groups
          .map((g) => (g.hooks
            ? { ...g, hooks: g.hooks.filter((h) => !hookText(h).includes('zcode-usage')) }
            : g))
          .filter((g) => !g.hooks || g.hooks.length > 0);
        if (kept.length !== groups.length
          || kept.some((g, i) => hookText(g) !== hookText(groups[i]))) touched = true;
        if (kept.length) cfg.hooks.events[ev] = kept;
        else delete cfg.hooks.events[ev];
      }
      if (Object.keys(cfg.hooks.events).length === 0) delete cfg.hooks;
      if (touched) {
        fs.writeFileSync(cliConfig, JSON.stringify(cfg, null, 2) + '\n');
        removed.push(cliConfig + ' (zcode-usage hooks)');
      }
    }
  } catch { /* 配置读取失败则跳过 */ }
  console.log('卸载完成。已清除:');
  for (const r of removed) console.log('  - ' + r);
  if (!removed.length) console.log('  (没有发现已安装的内容)');
  console.log('插件本体请在 ZCode 设置 → 插件管理中卸载(其悬浮窗会随之自动退出)。');
  process.exit(0);
}


// ---------- 凭据与域名 ----------
function fromArgs() {
  const key = flagValue('--key'), base = flagValue('--base');
  return key && base ? { token: key, base, from: 'args' } : null;
}
function fromEnv() {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ZAI_API_KEY || '';
  // ZAI_API_KEY 单独出现时默认国际站;ANTHROPIC_AUTH_TOKEN 可能指向任意代理,没 base 不瞎猜
  const base = process.env.ANTHROPIC_BASE_URL
    || (!process.env.ANTHROPIC_AUTH_TOKEN && process.env.ZAI_API_KEY
      ? 'https://api.z.ai/api/anthropic' : '');
  return token && base ? { token, base, from: 'env' } : null;
}
/// 读 JSON 文件;容忍 Windows 编辑器常加的 UTF-8 BOM,读不了返回 null
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}
/// 手动配置文件:悬浮窗「🔑 配置 API Key」界面写入,CLI 查询同样生效
function fromManualFile() {
  const obj = readJson(path.join(os.homedir(), '.zcode', 'zcode-usage-manual.json'));
  const key = typeof obj?.apiKey === 'string' ? obj.apiKey.trim() : '';
  const base = typeof obj?.apiBase === 'string' ? obj.apiBase.trim() : '';
  return key && base ? { token: key, base, from: 'manual' } : null;
}
function fromZcodeConfig() {
  const files = [
    path.join(os.homedir(), '.zcode', 'v2', 'config.json'), // 当前 ZCode
    path.join(os.homedir(), '.zcode', 'config.json'),       // 兼容其他版本的布局
  ];
  // 监控接口只存在于两个官方域名;zcode.z.ai(启动版套餐)没有 /api/monitor,
  // 拿它的凭据去查必然 404,直接跳过,让报错引导用户走「🔑 手动配置」
  const monitorHosts = ['open.bigmodel.cn', 'api.z.ai'];
  // 同域名内按 编程套餐 > 通用 优先;列表外的自定义 provider 排最后兜底
  const prefer = [
    'builtin:bigmodel-coding-plan', 'builtin:zai-coding-plan',
    'builtin:bigmodel', 'builtin:zai',
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const cfg = readJson(file);
    const providers = cfg?.provider || cfg?.providers;
    if (!providers || typeof providers !== 'object') continue;
    // 扫描全部 provider;凭据字段兼容 options.apiKey/baseURL 与顶层 apiKey/base 两种写法
    const found = [];
    for (const [name, pv] of Object.entries(providers)) {
      const key = pv?.options?.apiKey ?? pv?.options?.api_key ?? pv?.apiKey;
      const base = pv?.options?.baseURL ?? pv?.options?.base_url ?? pv?.baseURL ?? pv?.base;
      if (pv?.enabled === false || !key || !base) continue;
      let host;
      try { host = new URL(base).host; } catch { continue; }
      if (!monitorHosts.includes(host)) continue;
      const rank = prefer.indexOf(name);
      found.push({ name, token: key, base, rank: rank < 0 ? 9 : rank });
    }
    found.sort((a, b) => a.rank - b.rank); // sort 稳定,同分保持配置文件里的先后
    if (found.length) {
      return { token: found[0].token, base: found[0].base, from: `zcode:${found[0].name}` };
    }
  }
  return null;
}

// 凭据惰性解析(main 入口才执行):被 zcode-usage.test.mjs import 时不触发查找与退出
let cred = null;
let origin = null;
export function ensureCred() {
  if (cred) return;
  const found = findCred();
  if (!found) {
    console.error('未找到 Coding Plan API Key。请任选其一:');
    console.error('  1. 在 ZCode 中配置 Coding Plan API Key(~/.zcode/v2/config.json)');
    console.error('  2. 悬浮窗里点「🔑 配置 API Key」填写(推荐,保存到 ~/.zcode/zcode-usage-manual.json,CLI 查询同样生效)');
    console.error('  3. 设置环境变量 ANTHROPIC_AUTH_TOKEN 和 ANTHROPIC_BASE_URL');
    console.error('  4. 运行时传参: --key <apiKey> --base https://open.bigmodel.cn/api/anthropic');
    process.exit(1);
  }
  setCred(found);
}

/** 非退出式凭据探测(服务类调用方用:quota-curve 找不到 Key 时优雅降级而非退出) */
export function findCred() {
  return fromArgs() || fromEnv() || fromManualFile() || fromZcodeConfig();
}

/** 注入已找到的凭据,使 get() 走对应 origin */
export function setCred(found) {
  cred = found;
  origin = new URL(found.base).origin;
}

// ---------- 请求 ----------
// 常规查询 10s、hook 模式 5s,防止网络悬挂时阻塞悬浮窗 UI 或会话启动
const FETCH_TIMEOUT = asHook ? 5000 : 10000;
let bearerTried = false;
export async function get(p) {
  let res;
  try {
    res = await fetch(origin + p, {
      headers: {
        Authorization: cred.token,
        'Accept-Language': 'zh-CN,zh',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `请求超时(${FETCH_TIMEOUT / 1000}s):${origin} 无响应,请检查网络`
      : `网络错误,无法连接 ${origin}:${e.message}`);
  }
  if (res.status === 401 && !bearerTried && !cred.token.startsWith('Bearer ')) {
    bearerTried = true;
    cred.token = `Bearer ${cred.token}`;
    return get(p);
  }
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== undefined && body.code !== 200 && body.code !== 0) {
    throw new Error(`${p} -> ${body.msg || body.code}`);
  }
  return body.data ?? body;
}

// ---------- 北京时间纯函数(export 供 zcode-usage.test.mjs 单测) ----------
// 智谱服务端按北京时间(UTC+8)记账并定义峰时;全部用 +08:00 显式折算,与本机时区无关
// (借鉴 zcode-watch 的做法——本机恰好 UTC+8 时结果与旧实现一致,海外/出差机器不会错位)。
const BJ_OFFSET_MS = 8 * 3600_000;
const z2 = (n) => String(n).padStart(2, '0');

/** epoch(ms) → 北京时间字符串 'YYYY-MM-DD HH:mm:ss'(纯 UTC 运算,不吃本机时区) */
export function bjFmt(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${z2(d.getUTCMonth() + 1)}-${z2(d.getUTCDate())}`
    + ` ${z2(d.getUTCHours())}:${z2(d.getUTCMinutes())}:${z2(d.getUTCSeconds())}`;
}

/** epoch(ms) → 所在北京日的 00:00:00(epoch);当日查询窗口的起点 */
export function bjDayStartMs(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BJ_OFFSET_MS;
}

/** 'YYYY-MM-DD' → 星期(0=周日),走 Date.UTC 不吃本机时区;畸形返回 -1 */
export function weekdayOfDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 小时桶标签(服务端北京时间 'YYYY-MM-DD HH:00')是否落在高峰:工作日 14–17 点。
 *  星期取自标签自身的日期,而非当前时刻——跨零点/周末边界自洽;畸形标签返回 false */
export function isPeakHourLabel(label) {
  const s = String(label || '');
  const dow = weekdayOfDateStr(s.slice(0, 10));
  if (dow < 1 || dow > 5) return false;
  const hour = Number(s.slice(11, 13));
  return hour >= 14 && hour <= 17;
}

/** model-usage 当日响应 → 高峰用量 { calls, tokens }(逐小时桶按标签归类) */
export function peakOf(modelUsage) {
  let calls = 0;
  let tokens = 0;
  const xTime = modelUsage?.x_time || [];
  for (let i = 0; i < xTime.length; i++) {
    if (!isPeakHourLabel(xTime[i])) continue;
    calls += Number(modelUsage.modelCallCount?.[i]) || 0;
    tokens += Number(modelUsage.tokensUsage?.[i]) || 0;
  }
  return { calls, tokens };
}

// ---------- 周期历史导出:--export-csv <out.csv>(读本地 JSONL,无需凭据、不发请求) ----------
const historyArg = flagValue('--history');
const csvArg = flagValue('--export-csv');
if (csvArg) {
  const histFile = historyArg || path.join(os.homedir(), '.zcode', 'scripts', 'usage-history.jsonl');
  const rows = fs.existsSync(histFile)
    ? fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const head = 'cycle_start_beijing,cycle_end_beijing,calls,tokens,peak_calls,peak_tokens';
  const body = rows.map((r) => [
    bjFmt(Number(r.cycleStart)), bjFmt(Number(r.cycleEnd)),
    Number(r.calls) || 0, Number(r.tokens) || 0,
    Number(r.peakCalls) || 0, Number(r.peakTokens) || 0,
  ].join(','));
  fs.writeFileSync(csvArg, [head, ...body].join('\n') + (body.length ? '\n' : ''));
  console.log(`已导出 ${body.length} 条周期记录 -> ${csvArg}`);
  process.exit(0);
}
// ---------- 颜色与排版 ----------
// 仅在真终端且明确支持 ANSI 时着色(Git Bash 有 TERM,Windows Terminal 有 WT_SESSION);
// 管道/重定向/老式 cmd 下自动输出纯文本,避免乱码。NO_COLOR 可强制关闭。
const supportsAnsi = process.platform !== 'win32'
  || !!process.env.TERM
  || !!process.env.WT_SESSION
  || process.env.ConEmuANSI === 'ON';
const useColor = !process.env.NO_COLOR && process.stdout.isTTY && supportsAnsi;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
// 用量越高越醒目:<50% 绿,50-80% 黄,>=80% 红加粗
const rateStyle = (p) => (p >= 80 ? '1;31' : p >= 50 ? '33' : '32');

// 显示宽度:中日韩全角/emoji 按 2 列计,用于对齐
function dw(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)
      || (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}
const padEndW = (s, width) => s + ' '.repeat(Math.max(0, width - dw(s)));

// ---------- 展示辅助 ----------
const UNIT_NAME = { 3: '小时', 5: '个月', 6: '周' }; // 接口实测:unit 3/5/6 对应时/月/周
const periodText = (u, n) => (UNIT_NAME[u] ? `${n}${UNIT_NAME[u]}` : `${n}×unit${u}`);
const fmtTs = (ts) => ts > 0
  ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';
function countdown(ms) {
  if (!ms || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m || (!d && !h)) parts.push(`${m} 分钟`);
  return parts.join(' ') + '后';
}
const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');
const fmtTokens = (n) => {
  const v = Number(n || 0);
  return v >= 1e8 ? (v / 1e8).toFixed(2) + ' 亿'
    : v >= 1e4 ? (v / 1e4).toFixed(1) + ' 万'
    : fmtNum(v);
};
function bar(pct, width = 18) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * width);
  const style = rateStyle(p);
  return c(style, '▰'.repeat(filled) + '▱'.repeat(width - filled)) + '  ' + c(style, `已用 ${p.toFixed(1)}%`);
}

function labelFor(limit) {
  const period = periodText(limit.unit, limit.number);
  if (limit.type === 'TIME_LIMIT') return `MCP 工具调用(${period})`;
  if (period.includes('小时')) return '5 小时 Prompt 池';
  if (period.includes('周')) return '每周额度';
  return `Prompt 额度(${period})`;
}
const iconFor = (limit) => {
  if (limit.type === 'TIME_LIMIT') return '🔧';
  return periodText(limit.unit, limit.number).includes('小时') ? '🕐' : '📅';
};

const LABEL_W = 22; // 标签列显示宽度,保证进度条对齐
const rule = (ch) => c('2;36', ch.repeat(50));

// ---------- 额度采样历史(观测口径,零依赖 JSONL) ----------
// 与 usage-history.jsonl(周期消费台账)互补:台账记"每周期用了多少量",采样记"额度水位怎么走的"。
// 语义守则(与 widget 一致):只记观测事实,不回填不插值;过期窗口(resetAt<=at)拒绝;
// 同刻去重;最终使用率未知(末次水位是下界,顶格 100% 的周期真实消耗可能更高);
// 程序没在跑的时段就是没有采样(悬浮窗/插件不在 = 空窗)。
const DEFAULT_SAMPLES_FILE = () => path.join(os.homedir(), '.zcode', 'scripts', 'quota-samples.jsonl');

/** 读取采样 JSONL;坏行跳过(与 recordHistory 同风格) */
export function readSamples(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** 一次成功查询 → 追加一条采样;返回是否落盘及原因(调用方兜住异常,不影响主流程)。
 *  去重键 (at, resetAt, host) 对全文件查重(等价 widget 的 UNIQUE 约束):
 *  任意位置的重复都会被拦,跨服务商的同刻采样各留一条。 */
export function recordSample(quota, file, nowMs, host) {
  const l = (quota?.limits || []).find((x) => x.type !== 'TIME_LIMIT' && x.unit === 3);
  const pct = Number(l?.percentage);
  const resetAt = Number(l?.nextResetTime);
  if (!l || l.percentage === null || l.percentage === undefined
    || !Number.isFinite(pct) || pct < 0 || pct > 100 || !(resetAt > 0)) {
    return { recorded: false, reason: 'no-five-hour-pool' }; // 含 null/缺失水位:绝不伪造 0%
  }
  if (resetAt <= nowMs) return { recorded: false, reason: 'expired-window' };
  const hostKey = String(host || 'unknown');
  const seen = new Set(readSamples(file)
    .map((s) => `${Number(s.at)}|${Number(s.resetAt)}|${s.host || ''}`));
  if (seen.has(`${nowMs}|${resetAt}|${hostKey}`)) {
    return { recorded: false, reason: 'duplicate' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    at: nowMs, resetAt, usedPct: pct,
    level: String(quota.level || 'unknown').toUpperCase(),
    host: hostKey,
  }) + '\n');
  return { recorded: true };
}

/** 采样 → 周期分组(按 host+resetAt,不同服务商的流不合并):首见/末次/峰值水位、
 *  采样数、是否进行中;resetAt 降序。水位非法(非有限数/越界)的行忽略。 */
export function periodsOf(samples, nowMs) {
  const byReset = new Map();
  for (const s of samples) {
    const resetAt = Number(s.resetAt);
    const pct = Number(s.usedPct);
    const at = Number(s.at);
    if (!(resetAt > 0) || !(at > 0) || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    const key = `${s.host || ''}|${resetAt}`;
    const p = byReset.get(key) || { host: s.host || '', resetAt, count: 0, firstAt: at, lastAt: 0, firstPct: pct, lastPct: pct, peakPct: pct };
    p.count += 1;
    if (at < p.firstAt) { p.firstAt = at; p.firstPct = pct; }
    if (at >= p.lastAt) { p.lastAt = at; p.lastPct = pct; }
    if (pct > p.peakPct) p.peakPct = pct;
    byReset.set(key, p);
  }
  return [...byReset.values()]
    .map((p) => ({ ...p, active: p.resetAt > nowMs }))
    .sort((a, b) => b.resetAt - a.resetAt);
}

/** 已完成周期 → 按周期中点归属北京日的"窗口末次水位"日均值(各周期末次水位取平均)。
 *  周期起点 = 同服务商上一周期重置时刻(最早一个周期无上界信息,用首见采样时刻,
 *  中点归属最多左移 ~2.5h——观测数据的固有限制,widget 同款近似)。
 *  水位是观测下界:顶格 100% 的周期真实消耗可能更高,最终使用率未知。 */
export function dayConsumption(samples, days, nowMs) {
  const byHost = new Map();
  for (const p of periodsOf(samples, nowMs)) {
    if (p.active) continue;
    if (!byHost.has(p.host)) byHost.set(p.host, []);
    byHost.get(p.host).push(p);
  }
  const byDay = new Map();
  for (const periods of byHost.values()) {
    periods.sort((a, b) => a.resetAt - b.resetAt);
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      // 起点取上一周期重置点;但两周期间隔远超一个周期长(约 5h,长期停用后恢复)时,
      // 中点会落到无观测的日期,改用本周期首次采样时间(与最早周期的近似一致)
      const prevReset = i > 0 ? periods[i - 1].resetAt : 0;
      const start = i > 0 && prevReset && p.firstAt - prevReset <= 6 * 3600e3 ? prevReset : p.firstAt;
      const mid = Math.round((start + p.resetAt) / 2);
      const dayMs = bjDayStartMs(mid);
      const d = byDay.get(dayMs) || { dayMs, n: 0, sum: 0 };
      d.n += 1;
      d.sum += p.lastPct;
      byDay.set(dayMs, d);
    }
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = bjDayStartMs(nowMs) - i * 86400_000;
    const d = byDay.get(dayMs);
    out.push({ dayMs, dayLabel: bjFmt(dayMs).slice(5, 10), n: d ? d.n : 0, meanPct: d ? d.sum / d.n : null });
  }
  return out;
}

// ---------- 曲线服务所需:官方用量响应解析 + API 估价(供 quota-curve.mjs 复用) ----------
/** model-usage 原始 data → 页面/卡片消费的形状(移植自 widget 的 parse_model_usage) */
export function parseModelUsage(data) {
  const labels = (data?.x_time || []).map(String);
  const width = labels.length;
  const models = [];
  for (const entry of data?.modelDataList || []) {
    if (!entry || !entry.modelName) continue;
    const tokens = (entry.tokensUsage || []).map((v) => Number(v) || 0).slice(0, width);
    while (tokens.length < width) tokens.push(0);
    models.push({ modelName: String(entry.modelName), totalTokens: Number(entry.totalTokens) || 0, hourTokens: tokens });
  }
  models.sort((a, b) => b.totalTokens - a.totalTokens);
  const total = data?.totalUsage || {};
  return {
    generatedAtUtc: new Date().toISOString(),
    granularity: String(data?.granularity || 'hourly'),
    hourLabels: labels,
    hourTokens: (data?.tokensUsage || []).map((v) => Number(v) || 0).slice(0, width),
    totalCalls: Number(total.totalModelCallCount) || 0,
    totalTokens: Number(total.totalTokensUsage) || 0,
    models,
  };
}

/** tool-usage 原始 data → {tools:[{toolName, totalUsageCount}]}(按次数降序) */
export function parseToolUsage(data) {
  const tools = (data?.toolSummaryList || [])
    .filter((t) => t && t.toolName)
    .map((t) => ({ toolName: String(t.toolName), totalUsageCount: Number(t.totalUsageCount) || 0 }));
  tools.sort((a, b) => b.totalUsageCount - a.totalUsageCount);
  return { generatedAtUtc: new Date().toISOString(), tools };
}

// 按量刊牌价(每百万 tokens,输入/输出;国内刊牌为主,国际价折算)。估价口径:输入:输出=8:2,
// 接口不提供输入/输出拆分;未收录模型按中档回退。金额为估算,非实付。
export const API_PRICES_CNY = {
  'glm-5.3-flashx': [2.11, 7.36],
  'glm-5.3-flash': [1.07, 3.58],
  'glm-5.3': [8.0, 28.0],
  'glm-4.7': [4.28, 15.73],
};
export const API_INPUT_SHARE = 0.8;
const API_PRICE_FALLBACK = [2.0, 7.0];

/** 最长匹配取价(glm-5.3 不会吞掉 glm-5.3-flash) */
export function apiPriceFor(modelName) {
  const name = String(modelName || '').toLowerCase();
  for (const key of Object.keys(API_PRICES_CNY).sort((a, b) => b.length - a.length)) {
    if (name.includes(key)) return API_PRICES_CNY[key];
  }
  return API_PRICE_FALLBACK;
}

/** 逐模型估价明细(按金额降序);cny 保持全精度,perMillion 四舍五入仅供展示 */
export function costBreakdownCny(models) {
  const parts = [];
  for (const m of models || []) {
    const tokens = (m?.hourTokens || []).reduce((s, v) => s + (Number(v) || 0), 0);
    if (tokens <= 0) continue;
    const [pin, pout] = apiPriceFor(m?.modelName);
    const perMillion = API_INPUT_SHARE * pin + (1 - API_INPUT_SHARE) * pout;
    parts.push({ name: String(m?.modelName || '?'), tokens, perMillion: Math.round(perMillion * 100) / 100, cny: tokens / 1e6 * perMillion });
  }
  parts.sort((a, b) => b.cny - a.cny);
  return parts;
}

export function estimateCostCny(models) {
  return costBreakdownCny(models).reduce((s, p) => s + p.cny, 0);
}

/** 北京时间 14:00-18:00 高峰桶的 token 占比(0-100;标签无小时粒度时 null) */
export function peakHourShareCny(labels, tokens) {
  let peak = 0, total = 0;
  for (const [i, label] of (labels || []).entries()) {
    const hour = Number(String(label).split(' ')[1]?.slice(0, 2));
    if (!Number.isFinite(hour)) return null;
    const t = Number(tokens?.[i]) || 0;
    total += t;
    if (hour >= 14 && hour < 18) peak += t;
  }
  return total > 0 ? (peak / total) * 100 : null;
}

/** 采样记录开关(⚙ 设置面板「额度采样记录」;默认关——普通用户零写盘,显式 true 才开) */
export function samplesEnabled() {
  try {
    const s = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.zcode', 'scripts', 'quota-guard-settings.json'), 'utf8').replace(/^﻿/, ''));
    return s.quotaSamples === true;
  } catch { return false; }
}

/** --export-quota-csv:逐次采样导出(本地读,无需凭据、不发请求;水位非法的行过滤) */
function runQuotaCsvExport(outPath, samplesFile) {
  const samples = readSamples(samplesFile || DEFAULT_SAMPLES_FILE())
    .filter((s) => Number(s.at) > 0 && Number(s.resetAt) > 0
      && Number.isFinite(Number(s.usedPct)) && Number(s.usedPct) >= 0 && Number(s.usedPct) <= 100);
  const head = 'observed_at_beijing,reset_at_beijing,used_pct,remaining_pct';
  const body = samples.map((s) => [
    bjFmt(Number(s.at)), bjFmt(Number(s.resetAt)),
    Number(s.usedPct), (100 - Number(s.usedPct)).toFixed(1),
  ].join(','));
  fs.writeFileSync(outPath, [head, ...body].join('\n') + (body.length ? '\n' : ''));
  console.log(`已导出 ${body.length} 条采样 -> ${outPath}`);
}

/** --quota-history [N]:最近周期水位 + 近 7 天窗口平均消耗(本地读) */
function runQuotaHistoryView(samplesFile, count) {
  const file = samplesFile || DEFAULT_SAMPLES_FILE();
  const samples = readSamples(file);
  if (!samples.length) {
    console.log(`暂无采样记录(${file})。悬浮窗/插件每次成功查询会自动累积;`);
    console.log('数据语义:只记观测事实,程序未运行的时段无采样,周期最终使用率未知。');
    return;
  }
  const nowMs = Date.now();
  const periods = periodsOf(samples, nowMs);
  console.log(bold(`额度采样历史 · 最近 ${Math.min(count, periods.length)} 个周期`)
    + dim(`(共 ${periods.length} 周期 / ${samples.length} 条采样)`));
  for (const p of periods.slice(0, count)) {
    console.log(` ${padEndW(fmtTs(p.resetAt) + ' 重置', 18)}`
      + `${String(p.count).padStart(3)} 采样  `
      + `首见 ${p.firstPct.toFixed(0)}% → 末次 ${p.lastPct.toFixed(0)}% · 峰值 ${p.peakPct.toFixed(0)}%`
      + (p.active ? c('32', ' · 进行中') : ''));
  }
  const days = dayConsumption(samples, 7, nowMs).filter((d) => d.n > 0);
  if (days.length) {
    const totalN = days.reduce((s, d) => s + d.n, 0);
    const totalSum = days.reduce((s, d) => s + d.meanPct * d.n, 0);
    console.log('');
    console.log(bold('近 7 天窗口末次水位') + dim('(各周期末次已用%按日平均;观测下界,顶格 100% 的周期真实消耗可能更高,最终使用率未知)'));
    for (const d of days) {
      const filled = Math.round(d.meanPct / 5);
      console.log(` ${d.dayLabel}  ${c(rateStyle(d.meanPct), '▰'.repeat(filled) + '▱'.repeat(Math.max(0, 20 - filled)))}  ${c(rateStyle(d.meanPct), d.meanPct.toFixed(0) + '%')}  ${dim(`(${d.n} 窗口)`)}`);
    }
    console.log(` 7 天合计(按窗口加权): ${c(rateStyle(totalSum / totalN), (totalSum / totalN).toFixed(0) + '%')}  ${dim(`(共 ${totalN} 窗口)`)}`);
  }
  console.log('');
  console.log(dim(`    采样文件 ${file} · 导出 CSV 加 --export-quota-csv <路径>`));
}

if (exportQuotaCsvArg) { runQuotaCsvExport(exportQuotaCsvArg, samplesArg); process.exit(0); }
if (argv.includes('--quota-history')) { runQuotaHistoryView(samplesArg, quotaHistoryCount); process.exit(0); }

// ---------- 状态快照(quota-guard 数据面)----------
// 消费方(quota-guard hook、自动化任务)一律只读文件、不发网络请求,hook 才能毫秒级返回。
// 写入时机:--hook 模式(每次会话启动)+ 常规模式带 --state <path>;Windows 悬浮窗每次刷新也带 --state。
// 池的 key 语义:prompt5h=5 小时池(unit 3)、weekly=每周额度(unit 6)、mcp=MCP 工具调用(TIME_LIMIT)
const POOL_META = [
  { key: 'prompt5h', label: '5小时池', match: (l) => l.type !== 'TIME_LIMIT' && l.unit === 3 },
  { key: 'weekly', label: '每周额度', match: (l) => l.type !== 'TIME_LIMIT' && l.unit === 6 },
  { key: 'mcp', label: 'MCP月度', match: (l) => l.type === 'TIME_LIMIT' },
];
function writeStateFile(quota, file) {
  const pools = (quota.limits || []).map((l) => {
    const meta = POOL_META.find((m) => m.match(l));
    return {
      key: meta ? meta.key : `unit${l.unit}`,
      label: meta ? meta.label : labelFor(l),
      usedPct: Number(l.percentage) || 0,
      resetAt: Number(l.nextResetTime) || 0,
    };
  });
  const snap = {
    updatedAt: Date.now(),
    level: String(quota.level || 'unknown').toUpperCase(),
    host: new URL(origin).host,
    pools,
  };
  // 原子替换:先写临时文件再 rename,hook 永远读不到半个文件
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- 周期历史:把每个已完成 5 小时周期的用量补录进 JSONL ----------
const qsRange = (startMs, endMs) => `?startTime=${encodeURIComponent(bjFmt(startMs))}&endTime=${encodeURIComponent(bjFmt(endMs))}`;

/** 需要补录的已完成周期末端列表:从最近一个往前数,只取已结束且晚于 lastEnd 的,最多 maxBack 个 */
export function missingCycleEnds(nextReset, cycleMs, lastEnd, maxBack, nowMs) {
  const ends = [];
  for (let end = nextReset - cycleMs; end > lastEnd && ends.length < maxBack; end -= cycleMs) {
    if (end <= nowMs) ends.push(end); // 当前周期(nextReset 处)尚未结束,不记录
  }
  return ends;
}

/** 补录已完成周期的模型用量到 JSONL(假设周期连续;长期闲置造成的边界漂移以实际记录为准)。
 *  只在跨周期时发请求(通常 0-1 个新周期,最多回填 2 个),其余刷新零额外开销。 */
async function recordHistory(quota, file) {
  const l = (quota.limits || []).find((x) => x.type !== 'TIME_LIMIT' && x.unit === 3);
  if (!l || !(Number(l.nextResetTime) > 0)) return;
  const cycleMs = (Number(l.number) || 5) * 3600_000;
  const nextReset = Number(l.nextResetTime);
  const records = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean)
    : [];
  const lastEnd = records.length ? Number(records[records.length - 1].cycleEnd) : 0;
  const ends = missingCycleEnds(nextReset, cycleMs, lastEnd, 2, Date.now());
  for (const end of ends) {
    const start = end - cycleMs;
    const mu = await get('/api/monitor/usage/model-usage' + qsRange(start, end)).catch(() => null);
    const t = mu && mu.totalUsage;
    if (!t) break; // 查不到就不硬造,下次刷新再试
    const { calls, tokens } = peakOf(mu);
    records.push({
      cycleStart: start, cycleEnd: end,
      calls: Number(t.totalModelCallCount) || 0,
      tokens: Number(t.totalTokensUsage) || 0,
      peakCalls: calls, peakTokens: tokens,
      recordedAt: Date.now(),
    });
  }
  if (records.length) {
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
}

// ---------- 本机消耗:解析本地 rollout 的模型 I/O 日志(账号级之外的机器视角) ----------
// 数据源:~/.zcode/cli/rollout/model-io-sess_*.jsonl,每行一次模型请求,含
// completedAt / model.modelId / response.usage.{inputTokens,outputTokens,totalTokens}。
// 逐行正则提取(不 JSON.parse 整行——单行可达数百 KB),只统计北京时间当日。
export function localUsageToday(nowMs, rolloutDir) {
  const rdir = rolloutDir || path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  const dayStart = bjDayStartMs(nowMs);
  const out = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, byModel: {} };
  let files = [];
  try { files = fs.readdirSync(rdir).filter((f) => /^model-io-sess_.*\.jsonl$/.test(f)); } catch { return out; }
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(path.join(rdir, f), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.includes('"totalTokens":')) continue; // 快速预筛,跳过绝大多数行
      const ts = line.match(/"completedAt":"([^"]+)"/);
      if (!ts || !(Date.parse(ts[1]) >= dayStart)) continue;
      const tot = line.match(/"totalTokens":(\d+)/);
      if (!tot) continue; // 无用量(中断/失败)的请求
      const inp = line.match(/"inputTokens":(\d+)/);
      const outp = line.match(/"outputTokens":(\d+)/);
      const mid = (line.match(/"modelId":"([^"]+)"/) || [])[1] || '未知';
      out.calls++;
      out.inputTokens += Number(inp?.[1]) || 0;
      out.outputTokens += Number(outp?.[1]) || 0;
      out.totalTokens += Number(tot[1]) || 0;
      const bm = out.byModel[mid] || (out.byModel[mid] = { calls: 0, tokens: 0 });
      bm.calls++;
      bm.tokens += Number(tot[1]) || 0;
    }
  }
  return out;
}

// ---------- 本机生成速度:同源 rollout 日志,不依赖任何外部服务 ----------
// 取最近活跃会话文件里的 N 次已完成调用,算 输出tokens/durationMs 的中位速度与缓存命中率。
// 跨所有会话统计,是"本机当前速度";JSONL 没有首字延迟,所以是含预填充口径,比纯解码偏低属正常。
export function localSpeedRecent(nowMs, rolloutDir, window = 10) {
  const rdir = rolloutDir || path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  let files = [];
  try {
    files = fs.readdirSync(rdir).filter((f) => /^model-io-sess_.*\.jsonl$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(rdir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, 8).map((x) => x.f); // 最近活跃的会话文件优先
  } catch { return null; }
  const perFile = []; // 每个文件内的行是时间升序;文件按活跃度新→旧排
  let cacheRead = 0, input = 0;
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(path.join(rdir, f), 'utf8').split('\n'); } catch { continue; }
    const rates = [];
    for (const line of lines) {
      if (!line.includes('"durationMs":')) continue;
      const dur = Number((line.match(/"durationMs":(\d+)/) || [])[1]);
      const outp = Number((line.match(/"outputTokens":(\d+)/) || [])[1]);
      if (!dur || !outp) continue; // 无用量或无耗时(中断/失败)的请求
      rates.push(outp / (dur / 1000));
      cacheRead += Number((line.match(/"cacheReadTokens":(\d+)/) || [])[1]) || 0;
      input += Number((line.match(/"inputTokens":(\d+)/) || [])[1]) || 0;
    }
    if (rates.length) perFile.push(rates.reverse()); // 倒序:每文件最新的样本排前面
  }
  const recent = perFile.flat().slice(0, window); // flat 后就是"最新优先",取前 window 条 = 最近 N 次调用
  if (!recent.length) return null;
  recent.sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  const median = recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
  return { samples: recent.length, medianRate: Math.round(median), cacheHitRate: input > 0 ? cacheRead / input : null };
}

// 会话注入开关:⚙ 设置的「会话启动注入用量摘要」,存 quota-guard-settings.json(与 guard/悬浮窗共用)。
// 权限层级:上面的「额度告警」总开关(alertsEnabled)关闭时,注入锁定且不生效。
// 默认关闭——用户不一定想要对话被注入上下文;关闭时不输出注入内容,但用量快照仍随 --hook 续期(守卫依赖新鲜快照)。
function sessionInjectEnabled() {
  try {
    const s = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.zcode', 'scripts', 'quota-guard-settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    return s.sessionInject === true && s.alertsEnabled !== false;
  } catch { return false; }
}

// 最近 N 次调用的纯解码速度/缓存命中/首字延迟:来自 ZCode 的 sqlite 用量库 model_usage 表,
// 与输入框状态条(api-quota)同源同口径,数字会一致。纯解码 = 输出tokens / (总时长 - 首字延迟),
// 剔除等首字的时间,反映模型真实吐字吞吐(含预填充口径会被首字延迟摊薄,显示偏低)。
// node:sqlite 需 Node ≥22.5;低版本或库打开失败时返回 null(悬浮窗回退 JSONL 的含预填充口径)。
export async function localSqliteStats(limit = 10) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
    let rows;
    try {
      rows = db.prepare(
        `SELECT output_tokens AS out, duration_ms AS dur, time_to_first_token_ms AS ttft,
                input_tokens AS inp, cache_read_input_tokens AS cr
         FROM model_usage
         WHERE output_tokens > 0 AND duration_ms > 0
           AND COALESCE(query_source, '') <> 'session_title'
         ORDER BY started_at DESC LIMIT ?`
      ).all(limit);
    } finally {
      db.close(); // 查询抛异常(表结构漂移/库被锁)也要释放句柄
    }
    const decodes = [], ttfts = [];
    let cacheRead = 0, input = 0;
    for (const r of rows) {
      const out = Number(r.out), dur = Number(r.dur), ttft = Number(r.ttft);
      if (ttft > 0 && dur > ttft) {
        decodes.push(out / ((dur - ttft) / 1000));
        ttfts.push(ttft);
      }
      cacheRead += Number(r.cr) || 0;
      input += Number(r.inp) || 0;
    }
    if (!rows.length) return null;
    const median = (arr) => {
      if (!arr.length) return null;
      arr.sort((a, b) => a - b);
      const m = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
    };
    const md = median(decodes);
    const mt = median(ttfts);
    // 键集与 JSONL 回退口径(localSpeedRecent)保持一致,悬浮窗/调用方无需区分数据来源
    return {
      samples: rows.length,
      medianRate: null, // sqlite 口径不产含预填充速度,该键留空
      medianDecodeRate: md === null ? null : Math.round(md),
      medianTtftMs: mt === null ? null : Math.round(mt),
      cacheHitRate: input > 0 ? cacheRead / input : null,
    };
  } catch { return null; }
}

// ---------- 主流程 ----------
async function main() {
  ensureCred();
  const quota = await get('/api/monitor/usage/quota/limit');

  // 状态快照:--hook 模式固定写默认路径;常规模式带 --state <path> 时写指定路径(自动化/调试用)
  // 注意:快照续期不受「会话启动注入」开关影响——quota-guard 依赖新鲜快照,该开关只门控下方输出
  const stateArg = flagValue('--state');
  if (asHook || stateArg) {
    const statePath = stateArg || path.join(os.homedir(), '.zcode', 'scripts', 'usage-state.json');
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      writeStateFile(quota, statePath);
    } catch { /* 落盘失败不影响查询主流程 */ }
  }

  // 额度采样记录(移植自 widget):每次成功查询追加一条观测水位;⚙ 设置「额度采样记录」
  // 关闭时不记录;记录失败绝不影响主流程
  try {
    if (samplesEnabled()) {
      recordSample(quota, samplesArg || DEFAULT_SAMPLES_FILE(), Date.now(), new URL(origin).host);
    }
  } catch { /* 采样落盘失败不影响查询 */ }

  // 注入门控:关闭时快照已在上面续期,这里只跳过 additionalContext 输出,对对话零打扰
  if (asHook && !sessionInjectEnabled()) return;

  // 周期历史:--history <jsonl> 时补录刚结束的 5 小时周期(跨周期才发请求,平时零开销)
  if (historyArg) {
    try {
      fs.mkdirSync(path.dirname(historyArg), { recursive: true });
      await recordHistory(quota, historyArg);
    } catch { /* 历史补录失败不影响查询主流程 */ }
  }

  // SessionStart hook 模式:只查额度,输出 additionalContext JSON,注入会话上下文
  if (asHook) {
    const parts = [];
    for (const l of quota.limits || []) {
      const p = Number(l.percentage) || 0;
      const name = l.type === 'TIME_LIMIT' ? 'MCP'
        : periodText(l.unit, l.number).includes('小时') ? '5小时池' : '每周';
      const reset = l.nextResetTime > 0 ? `,${countdown(l.nextResetTime - Date.now())}重置` : '';
      parts.push(`${name} ${p.toFixed(0)}%${reset}`);
    }
    const line = `【GLM Coding Plan 用量】${parts.join(' · ')}(如需详情运行 node ~/.zcode/scripts/zcode-usage.mjs)`;
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
    }));
    return;
  }

  // 当日用量(失败不影响额度展示);高峰期 = 工作日(周一至周五)北京时间 14:00–18:00
  const now = new Date();
  const nowMs = now.getTime();
  const qs = (startMs, endMs) => `?startTime=${encodeURIComponent(bjFmt(startMs))}&endTime=${encodeURIComponent(bjFmt(endMs))}`;
  const dayStartMs = bjDayStartMs(nowMs);
  const [modelUsage, toolUsage] = await Promise.all([
    get('/api/monitor/usage/model-usage' + qs(dayStartMs, nowMs)).catch(() => null),
    get('/api/monitor/usage/tool-usage' + qs(dayStartMs, nowMs)).catch(() => null),
  ]);
  // 高峰/非高峰拆分:非高峰 = 当日总量 - 高峰;高峰 = peakOf 对当日响应的小时序列求和。
  // 不再单独发峰窗区间请求:官方接口对当天的区间查询会把 endTime 截到当前时刻
  // (晚间查询会把全天算进高峰),且区间 endTime 桶为包含语义(会把 18–19 点多算)。
  // 窗口与峰时全部锚定北京时间(见纯函数段);序列缺失时不拆分(只显示当日总量)。
  let usageSplit = null;
  const total = modelUsage?.totalUsage;
  if (total && Array.isArray(modelUsage.x_time)) {
    const { calls: pc, tokens: pt } = peakOf(modelUsage);
    usageSplit = {
      peak: { calls: pc, tokens: pt },
      offPeak: {
        calls: Math.max(0, (Number(total.totalModelCallCount) || 0) - pc),
        tokens: Math.max(0, (Number(total.totalTokensUsage) || 0) - pt),
      },
    };
  }

  if (asJson) {
    // 速度/缓存/首字:sqlite 纯解码口径优先(与输入框状态条一致);node:sqlite 不可用时回退 JSONL 含预填充。
    // 两条路径键集一致:samples/medianRate/medianDecodeRate/cacheHitRate/medianTtftMs
    const ls = (await localSqliteStats()) || localSpeedRecent(nowMs) || null;
    const localSpeed = ls
      ? {
          samples: ls.samples,
          medianRate: ls.medianRate ?? null,
          medianDecodeRate: ls.medianDecodeRate ?? null,
          cacheHitRate: ls.cacheHitRate ?? null,
          medianTtftMs: ls.medianTtftMs ?? null,
        }
      : null;
    console.log(JSON.stringify({
      quota, modelUsage, toolUsage, usageSplit,
      localUsage: localUsageToday(nowMs), // 本机视角:解析本地模型 I/O 日志(北京时间当日)
      localSpeed, // 本机生成速度/缓存/首字:自行计算,悬浮窗的 ⚡ 行数据源
    }, null, 2));
    return;
  }

  const host = new URL(origin).host;
  const level = (quota.level || 'unknown').toUpperCase();
  console.log(rule('━'));
  console.log(bold(' ⚡ GLM Coding Plan 用量'));
  console.log(dim(`    ${level} 套餐 · ${host} · ${now.toLocaleString('zh-CN')}`));
  console.log(rule('━'));

  for (const l of quota.limits || []) {
    const p = Number(l.percentage) || 0;
    console.log('');
    console.log(` ${iconFor(l)}  ${bold(padEndW(labelFor(l), LABEL_W))}${bar(p)}`);
    if (l.type === 'TIME_LIMIT') {
      console.log(dim(`      已用 ${fmtNum(l.currentValue)} / ${fmtNum(l.usage)} 次 · 剩余 ${fmtNum(l.remaining)}`));
    } else {
      console.log(dim(`      剩余 ${(100 - p).toFixed(1)}%`));
    }
    if (l.nextResetTime > 0) {
      console.log(dim(`      ↻ ${fmtTs(l.nextResetTime)} 重置(${countdown(l.nextResetTime - now.getTime())})`));
    }
    const details = l.usageDetails || [];
    if (details.length) {
      console.log(dim(`      ${details.map((d) => `${d.modelCode} ${fmtNum(d.usage)}`).join(' · ')}`));
    }
  }

  if (modelUsage?.totalUsage) {
    const t = modelUsage.totalUsage;
    console.log('');
    console.log(` 📊  ${bold(padEndW('当日模型用量', LABEL_W))}`
      + `${fmtNum(t.totalModelCallCount)} 次 · ${fmtTokens(t.totalTokensUsage)} tokens`);
    if (usageSplit) {
      const splitLine = (label, v) => dim(`      ${padEndW(label, 26)}${fmtNum(v.calls)} 次 · ${fmtTokens(v.tokens)} tokens`);
      console.log(splitLine('高峰期(工作日 14–18 时)', usageSplit.peak));
      console.log(splitLine('非高峰期', usageSplit.offPeak));
    }
    const models = t.modelSummaryList || [];
    if (models.length) {
      console.log(dim(`      ${models.map((m) => `${m.modelName} ${fmtTokens(m.totalTokens)}`).join(' · ')}`));
    }
  }

  if (toolUsage?.totalUsage) {
    const t = toolUsage.totalUsage;
    const parts = [];
    if (t.totalSearchMcpCount) parts.push(`联网搜索 ${fmtNum(t.totalSearchMcpCount)}`);
    if (t.totalWebReadMcpCount) parts.push(`网页读取 ${fmtNum(t.totalWebReadMcpCount)}`);
    if (t.totalZreadMcpCount) parts.push(`Zread ${fmtNum(t.totalZreadMcpCount)}`);
    if (parts.length) {
      console.log('');
      console.log(` 🔌  ${bold(padEndW('当日 MCP 调用', LABEL_W))}${parts.join(' · ')}`);
    }
  }

  // 近 7 天窗口末次水位(采样历史有数据才显示;本地读,不发请求;按窗口加权)
  try {
    const samples = readSamples(samplesArg || DEFAULT_SAMPLES_FILE());
    const days = dayConsumption(samples, 7, nowMs).filter((d) => d.n > 0);
    if (days.length) {
      const totalN = days.reduce((s, d) => s + d.n, 0);
      const mean = days.reduce((s, d) => s + d.meanPct * d.n, 0) / totalN;
      console.log('');
      console.log(` 📈  ${bold(padEndW('近7天窗口平均水位', LABEL_W))}${c(rateStyle(mean), mean.toFixed(0) + '%')}  ${dim(`(末次观测下界 · ${totalN} 窗口 · --quota-history 看明细)`)}`);
    }
  } catch { /* 无采样历史时静默 */ }

  console.log('');
  console.log(rule('━'));
  console.log(dim(`    凭据来源 ${cred.from} · 加 --json 看原始数据`));
}

// 仅作为可执行入口时运行(main 之外无副作用),供 zcode-usage.test.mjs 安全 import
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error('查询失败:', e.message);
    if (String(e.message).includes('HTTP 401')) {
      console.error('该 API Key 可能:1) 已失效或被更换;2) 不是 Coding Plan 专用 Key(普通按量付费 Key 无法查询套餐额度)。');
      console.error('请在 ZCode 的模型设置中检查 Key,或在悬浮窗「🔑 配置 API Key」里更新,或到智谱开放平台「个人编程套餐」重新获取。');
    }
    process.exit(1);
  });
}
