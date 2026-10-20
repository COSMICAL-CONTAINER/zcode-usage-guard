#!/usr/bin/env node
/**
 * quota-guard:额度阈值守卫 hook(零依赖,Node >= 18)
 *
 * 数据源:~/.zcode/scripts/usage-state.json(由 zcode-usage.mjs 的 --hook / --state 写盘,
 * Windows 悬浮窗每次刷新也会带 --state)。本脚本只读本地文件、不发网络请求——
 * ZCode hook 是 inline 执行的,必须毫秒级返回。
 *
 * **登记制**:只对已登记会话生效。会话把自身 id 写进 ~/.zcode/scripts/quota-guard-optin.json
 * (`{"sessions": {"<会话id>": {"at": <epoch>}}}`)后才会被拦截/告警;未登记的对话零打扰。
 * 会话 id 来源优先级:环境变量 CLAUDE_SESSION_ID → --session 参数 → stdin 负载的 session_id。
 *
 * 事件(--event):
 *   UserPromptSubmit  已登记且任一池 ≥ 该池阈值 → 注入一行警告上下文(warnIntervalMinutes 节流)
 *   Stop              已登记、超阈值且未布置续跑 → {"decision":"block","reason":"<收尾协议>"}
 *                     拦住会话;resume-armed.flag 记录的 armedForResetAt ≥ 绑定池重置时间 → 放行,
 *                     重置周期翻篇后自动过期。
 *
 * 输出为 ZCode hook 严格 schema,一切正常时静默 exit 0;本脚本永远不用 exit 2。
 * 可选配置 ~/.zcode/scripts/quota-guard-settings.json:
 *   { "threshold": 95, "thresholds": {"prompt5h":95,"weekly":95,"mcp":0}, "warnIntervalMinutes": 10 }
 * thresholds 按池覆盖全局阈值,设为 0 表示关闭该池监控。
 * 测试参数:--dir/--session/--state-file/--flag-file/--warn-file/--settings-file 可重定向(供 node --test)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const event = argValue('--event') || 'UserPromptSubmit';

const dir = argValue('--dir') || path.join(os.homedir(), '.zcode', 'scripts');
const stateFile = argValue('--state-file') || path.join(dir, 'usage-state.json');
const flagFile = argValue('--flag-file') || path.join(dir, 'resume-armed.flag');
const warnFile = argValue('--warn-file') || path.join(dir, 'quota-guard-warn.json');
const settingsFile = argValue('--settings-file') || path.join(dir, 'quota-guard-settings.json');
const optinFile = argValue('--optin-file') || path.join(dir, 'quota-guard-optin.json');

// 会话 id:环境变量优先,--session 参数次之,stdin 负载兜底(见 readStdinSession)
let sessionId = process.env.CLAUDE_SESSION_ID || argValue('--session') || '';

const DEFAULT_THRESHOLD = 95;
const DEFAULT_WARN_INTERVAL_MIN = 10;
// 快照过期阈值:要给「悬浮窗 30 分钟自动刷新档」留出裕量——阈值与刷新周期相等时,
// 每个刷新周期尾部快照都会被判过期,守卫静默停摆;75 分钟 ≈ 最大刷新档的 2.5 倍
const STATE_MAX_AGE_MS = 75 * 60_000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

function loadSettings() {
  const s = readJson(settingsFile) || {};
  const threshold = Number(s.threshold);
  const warnMin = Number(s.warnIntervalMinutes);
  const globalTh = threshold > 0 && threshold < 100 ? threshold : DEFAULT_THRESHOLD;
  // 每池可覆盖:thresholds.prompt5h / weekly / mcp,设为 0 表示关闭该池监控
  const overrides = {};
  if (s.thresholds && typeof s.thresholds === 'object') {
    for (const [k, v] of Object.entries(s.thresholds)) {
      const n = Number(v);
      overrides[k] = Number.isFinite(n) && n >= 0 && n < 100 ? n : null;
    }
  }
  return {
    threshold: globalTh,
    thresholds: overrides,
    warnIntervalMinutes: warnMin > 0 ? warnMin : DEFAULT_WARN_INTERVAL_MIN,
    // 告警总开关:默认开;关闭后 UserPromptSubmit 告警与 Stop 登记续跑均不生效(权限层级,与 ⚙ 面板/README 一致)
    alertsEnabled: s.alertsEnabled !== false,
    // 额度守卫自动续跑总开关:默认开;只影响「登记过」的会话在 Stop 收尾时是否布置自动续跑
    resumeGuard: s.resumeGuard !== false,
  };
}

// 池的有效阈值:每池覆盖优先,0 = 关闭该池监控
function effectiveThreshold(thresholds, key, globalTh) {
  const v = thresholds ? thresholds[key] : undefined;
  return v === undefined || v === null ? globalTh : v;
}

function fmtCountdown(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m || parts.length === 0) parts.push(`${m} 分钟`);
  return parts.join(' ');
}

const fmtResetLocal = (ms) => (ms > 0
  ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '未知');

// 调用日志:每次触发都留痕(hook 是静默设计,没有它无法定位"为什么没拦")
function debugLog(msg) {
  try {
    fs.appendFileSync(path.join(dir, 'quota-guard.log'),
      `${new Date().toISOString()} [${event}] ${msg}\n`);
  } catch { }
}

// stdin:hook runner 会写事件负载;收齐(至多 250ms)避免写方阻塞,超时即走不拖住进程
async function readStdinPayload() {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve) => {
    let buf = '';
    const done = () => { try { process.stdin.destroy(); } catch { } resolve(buf); };
    const t = setTimeout(done, 250);
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(t); done(); });
    process.stdin.on('error', () => { clearTimeout(t); done(); });
  });
}

function isOptedIn(file, sid) {
  if (!sid) return false;
  const o = readJson(file);
  return !!(o && o.sessions && o.sessions[sid]);
}

async function main() {
  if (!sessionId) {
    const payload = await readStdinPayload();
    try {
      const j = JSON.parse(payload);
      sessionId = String(j.session_id || '');
    } catch { }
  }

  const { threshold, thresholds, warnIntervalMinutes, alertsEnabled, resumeGuard } = loadSettings();
  const opted = isOptedIn(optinFile, sessionId);
  debugLog(`session=${sessionId || '未知'} 登记=${opted ? '是' : '否'}`);
  if (!opted) { debugLog('pass: 会话未登记 quota-guard'); return; } // 未登记的对话零打扰

  const state = readJson(stateFile);
  if (!state || !Array.isArray(state.pools)) { debugLog('pass: 无快照'); return; }
  const ageSec = Math.round((Date.now() - Number(state.updatedAt || 0)) / 1000);
  if (Date.now() - Number(state.updatedAt || 0) > STATE_MAX_AGE_MS) { debugLog(`pass: 快照过期 ${ageSec}s`); return; }

  const poolInfo = (p) => {
    const eff = effectiveThreshold(thresholds, p.key, threshold);
    return eff <= 0 ? `${p.key}:关` : `${p.key}:${Number(p.usedPct).toFixed(0)}%/${eff}%`;
  };
  const over = state.pools.filter((p) => {
    const eff = effectiveThreshold(thresholds, p.key, threshold);
    return eff > 0 && Number(p.usedPct) >= eff;
  });
  if (!over.length) {
    debugLog(`pass: 未超阈值(各池 ${state.pools.map(poolInfo).join(' ')})`);
    return;
  }
  debugLog(`hit: ${over.map((p) => `${p.key}:${Number(p.usedPct).toFixed(0)}%`)} ≥ 各池阈值(快照 ${ageSec}s 前)`);

  // 绑定约束:超阈值池中重置时间最晚者——每周额度耗尽时,5 小时池重置了也没用
  const binding = over.reduce((a, b) => ((Number(b.resetAt) || 0) > (Number(a.resetAt) || 0) ? b : a));
  const bindingReset = Number(binding.resetAt) || 0;
  const poolList = over.map((p) => `${p.label || p.key} ${Number(p.usedPct).toFixed(0)}%`).join('、');

  if (event === 'Stop') {
    // 权限层级:额度告警总开关(alertsEnabled)关闭时,续跑同样锁定且不生效,无论 resumeGuard 勾选状态
    if (!resumeGuard || !alertsEnabled) { debugLog(`pass: 续跑不生效(resumeGuard=${resumeGuard} alertsEnabled=${alertsEnabled})`); return; }
    const flag = readJson(flagFile);
    if (bindingReset > 0 && flag && Number(flag.armedForResetAt) >= bindingReset) { debugLog('pass: flag 已布置,放行'); return; }
    // Stop 的拦截必须走 decision:"block"(ZCode 源码对 Stop 的 block 路径:
    // blockRequested=true + reason 反馈给模型强制续跑);continue:true 实测不生效
    debugLog('拦截 → 输出 decision:block 收尾协议');
    const reason = [
      `额度警报:${poolList} 已达各自阈值(约 ${fmtResetLocal(bindingReset)} 重置)。不要继续任务主体,立即执行收尾协议:`,
      `1. 把当前任务状态写入 ~/.zcode/quota-handoff.md:任务目标、已完成进度、下一步计划、恢复所需的全部上下文;`,
      `2. 用 CronCreate 布置一次性自动化(${fmtResetLocal(bindingReset)} 后 5 分钟触发,recurring=false、maxRuns=1),prompt 必须要求:先读 ~/.zcode/quota-handoff.md 并把你的会话登记进 ~/.zcode/scripts/quota-guard-optin.json,再复查额度(低于阈值才继续),然后接着执行任务;`,
      `3. 向 ~/.zcode/scripts/resume-armed.flag 写入 {"armedForResetAt": ${bindingReset}} 标记已布置(之后 Stop 检查会放行);`,
      `4. 完成后正常结束本次回复,不要再发起新的大型工作。`,
    ].join('\n');
    console.log(JSON.stringify({ decision: 'block', reason }));
    return;
  }

  // UserPromptSubmit:节流告警(总开关关闭时不注入,零打扰)
  if (!alertsEnabled) { debugLog('pass: 告警总开关关闭'); return; }
  const now = Date.now();
  const last = readJson(warnFile);
  if (last && now - Number(last.at || 0) < warnIntervalMinutes * 60_000) { debugLog('pass: 告警节流窗口内'); return; }
  try { fs.writeFileSync(warnFile, JSON.stringify({ at: now, pools: over.map((p) => p.key) })); } catch { }
  const line = `【额度警报】${poolList} 已达各自阈值,` +
    `${bindingReset > now ? fmtCountdown(bindingReset - now) : '即将'}后重置。` +
    `新开长任务前先斟酌;若准备收尾,请按「额度守卫」协议布置续跑。`;
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line },
  }));
}

main();
