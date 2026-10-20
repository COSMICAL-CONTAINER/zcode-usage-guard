// quota-guard 行为单测(零依赖,node --test)
// 通过 --dir/--state-file/--flag-file/--warn-file 把文件全部重定向到临时目录,子进程方式运行
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'quota-guard.mjs');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-guard-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
}

function stateAt(dir, pools, ageMs = 0) {
  const file = path.join(dir, 'usage-state.json');
  writeJson(file, { updatedAt: Date.now() - ageMs, level: 'PRO', host: 'open.bigmodel.cn', pools });
  return file;
}

const pool = (key, usedPct, resetAt, label = key) => ({ key, label, usedPct, resetAt });

/** 运行 guard;opts 可覆盖 state/flag/warn 文件路径(默认都在 dir 下);
 *  默认以 sess-test 登记会话,opts.noOptin=true 用于未登记场景,opts.input 作 stdin 负载 */
function run(event, dir, opts = {}) {
  const args = [script, '--event', event, '--dir', dir, '--session', opts.session || 'sess-test'];
  if (opts.state) args.push('--state-file', opts.state);
  if (opts.flag) args.push('--flag-file', opts.flag);
  if (opts.warn) args.push('--warn-file', opts.warn);
  if (!opts.noOptin) {
    writeJson(path.join(dir, 'quota-guard-optin.json'),
      { sessions: { [opts.session || 'sess-test']: { at: Date.now() } } });
  }
  const r = spawnSync(process.execPath, args,
    { encoding: 'utf8', timeout: 15000, input: opts.input || '' });
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  return r.stdout.trim();
}

test('没有状态文件时静默通过', (t) => {
  const dir = tmpDir(t);
  assert.equal(run('Stop', dir), '');
  assert.equal(run('UserPromptSubmit', dir), '');
});

test('快照过期(>75 分钟,超过悬浮窗最大刷新档的 2.5 倍裕量)时静默通过', (t) => {
  const dir = tmpDir(t);
  const state = stateAt(dir, [pool('prompt5h', 99, Date.now() + 3600e3)], 76 * 60_000);
  assert.equal(run('Stop', dir, { state }), '');
});

test('低于阈值时两个事件都静默', (t) => {
  const dir = tmpDir(t);
  stateAt(dir, [pool('prompt5h', 94.9, Date.now() + 3600e3), pool('weekly', 10, Date.now() + 3 * 86400e3)]);
  assert.equal(run('Stop', dir), '');
  assert.equal(run('UserPromptSubmit', dir), '');
});

test('Stop 超阈值 → decision:block + 收尾协议 reason', (t) => {
  const dir = tmpDir(t);
  const resetAt = Date.now() + 2 * 3600e3;
  stateAt(dir, [pool('prompt5h', 97.3, resetAt, '5小时池')]);
  const out = run('Stop', dir);
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.ok(parsed.reason.includes('quota-handoff.md'), 'reason 应包含交接文件路径');
  assert.ok(parsed.reason.includes('resume-armed.flag'), 'reason 应包含标记文件路径');
  assert.ok(parsed.reason.includes('CronCreate'), 'reason 应包含布置定时任务的指令');
});

test('Stop 绑定约束:取超阈值池中重置更晚者(weekly)', (t) => {
  const dir = tmpDir(t);
  const soon = Date.now() + 2 * 3600e3;
  const later = Date.now() + 3 * 86400e3;
  stateAt(dir, [pool('prompt5h', 99, soon, '5小时池'), pool('weekly', 99, later, '每周额度')]);
  const parsed = JSON.parse(run('Stop', dir));
  assert.ok(parsed.reason.includes('每周额度'), 'reason 应点名绑定池');
});

test('Stop:有效 flag(armedForResetAt ≥ 绑定重置)放行', (t) => {
  const dir = tmpDir(t);
  const resetAt = Date.now() + 2 * 3600e3;
  stateAt(dir, [pool('prompt5h', 97, resetAt, '5小时池')]);
  const flag = path.join(dir, 'resume-armed.flag');
  writeJson(flag, { armedForResetAt: resetAt });
  assert.equal(run('Stop', dir, { flag }), '');
});

test('Stop:过期 flag(重置周期翻篇)重新拦截', (t) => {
  const dir = tmpDir(t);
  const newResetAt = Date.now() + 2 * 3600e3;
  stateAt(dir, [pool('prompt5h', 97, newResetAt, '5小时池')]);
  const flag = path.join(dir, 'resume-armed.flag');
  writeJson(flag, { armedForResetAt: newResetAt - 5 * 3600e3 }); // 上一周期的重置点
  const parsed = JSON.parse(run('Stop', dir, { flag }));
  assert.equal(parsed.decision, 'block');
});

test('UserPromptSubmit 超阈值 → 注入警告并写节流文件', (t) => {
  const dir = tmpDir(t);
  stateAt(dir, [pool('mcp', 96, Date.now() + 5 * 86400e3, 'MCP月度')]);
  const warn = path.join(dir, 'quota-guard-warn.json');
  const parsed = JSON.parse(run('UserPromptSubmit', dir, { warn }));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('额度警报'));
  assert.ok(fs.existsSync(warn), '应写入节流文件');
});

test('UserPromptSubmit:节流窗口内不重复提醒', (t) => {
  const dir = tmpDir(t);
  stateAt(dir, [pool('prompt5h', 96, Date.now() + 3600e3, '5小时池')]);
  const warn = path.join(dir, 'quota-guard-warn.json');
  writeJson(warn, { at: Date.now(), pools: ['prompt5h'] });
  assert.equal(run('UserPromptSubmit', dir, { warn }), '');
});

test('settings 文件可调低阈值让 90% 也触发', (t) => {
  const dir = tmpDir(t);
  writeJson(path.join(dir, 'quota-guard-settings.json'), { threshold: 90 });
  stateAt(dir, [pool('prompt5h', 90.5, Date.now() + 3600e3, '5小时池')]);
  const parsed = JSON.parse(run('Stop', dir));
  assert.equal(parsed.decision, 'block');
});

test('每池独立阈值:mcp=0 关闭后不参与触发,只拦 prompt5h', (t) => {
  const dir = tmpDir(t);
  writeJson(path.join(dir, 'quota-guard-settings.json'),
    { threshold: 95, thresholds: { prompt5h: 95, weekly: 95, mcp: 0 } });
  const soon = Date.now() + 3600e3;
  stateAt(dir, [pool('prompt5h', 96, soon, '5小时池'), pool('mcp', 60, Date.now() + 5 * 86400e3, 'MCP月度')]);
  const parsed = JSON.parse(run('Stop', dir));
  assert.equal(parsed.decision, 'block');
  assert.ok(parsed.reason.includes('5小时池'), '应拦截 5 小时池');
  assert.ok(!parsed.reason.includes('MCP月度'), '已关闭的 MCP 不应出现在拦截里');
});

test('每池独立阈值:MCP 可单独设低阈值独立触发', (t) => {
  const dir = tmpDir(t);
  writeJson(path.join(dir, 'quota-guard-settings.json'),
    { threshold: 95, thresholds: { prompt5h: 95, mcp: 50 } });
  stateAt(dir, [pool('mcp', 55, Date.now() + 5 * 86400e3, 'MCP月度')]);
  const parsed = JSON.parse(run('Stop', dir));
  assert.equal(parsed.decision, 'block');
  assert.ok(parsed.reason.includes('MCP月度'));
});

test('每池独立阈值:全部关闭时即使 100% 也静默', (t) => {
  const dir = tmpDir(t);
  writeJson(path.join(dir, 'quota-guard-settings.json'),
    { threshold: 95, thresholds: { prompt5h: 0, mcp: 0 } });
  stateAt(dir, [pool('prompt5h', 100, Date.now() + 3600e3, '5小时池'), pool('mcp', 100, Date.now() + 86400e3, 'MCP月度')]);
  assert.equal(run('Stop', dir), '');
});

test('会话未登记:即使 100% 也静默放行(登记制)', (t) => {
  const dir = tmpDir(t);
  stateAt(dir, [pool('prompt5h', 100, Date.now() + 3600e3, '5小时池')]);
  assert.equal(run('Stop', dir, { noOptin: true }), '');
  assert.equal(run('UserPromptSubmit', dir, { noOptin: true }), '');
});

test('stdin 负载里的 session_id 也能匹配登记', (t) => {
  const dir = tmpDir(t);
  writeJson(path.join(dir, 'quota-guard-optin.json'), { sessions: { 'sess-stdin': { at: Date.now() } } });
  stateAt(dir, [pool('prompt5h', 96, Date.now() + 3600e3, '5小时池')]);
  const r = spawnSync(process.execPath, [script, '--event', 'Stop', '--dir', dir],
    { encoding: 'utf8', timeout: 15000, input: JSON.stringify({ session_id: 'sess-stdin' }) });
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.decision, 'block');
});
