// 额度采样历史单测(node --test,零依赖)
// 运行:node --test plugins/zcode-usage/skills/zcode-usage/scripts/quota-samples.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSamples, recordSample, periodsOf, dayConsumption,
} from './zcode-usage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quota-samples-'));
const quotaOf = (pct, resetAt) => ({
  level: 'pro',
  limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: pct, nextResetTime: resetAt }],
});

// ---------- recordSample:观测守则 ----------
test('recordSample:成功查询追加一行,字段完整', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  const r = recordSample(quotaOf(22.5, 1_800_000_000_000), file, 1_700_000_000_000, 'open.bigmodel.cn');
  assert.deepEqual(r, { recorded: true });
  const rows = readSamples(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usedPct, 22.5);
  assert.equal(rows[0].resetAt, 1_800_000_000_000);
  assert.equal(rows[0].at, 1_700_000_000_000);
  assert.equal(rows[0].level, 'PRO');
  assert.equal(rows[0].host, 'open.bigmodel.cn');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSample:过期窗口(resetAt<=at)拒绝——接口偶发回旧窗口时不得伪造跨周期行', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  assert.equal(recordSample(quotaOf(50, 999), file, 1000, 'h').recorded, false);
  assert.equal(recordSample(quotaOf(50, 1000), file, 1000, 'h').recorded, false);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSample:缺 5 小时池或水位非法时不记录', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  assert.equal(recordSample({ limits: [{ type: 'TIME_LIMIT', unit: 5 }] }, file, 1, 'h').recorded, false);
  assert.equal(recordSample(quotaOf('x', 2000), file, 1000, 'h').recorded, false);
  assert.equal(recordSample(quotaOf(140, 2000), file, 1000, 'h').recorded, false);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSample:同刻去重(全文件任意位置,同 at+resetAt+host)', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  recordSample(quotaOf(10, 2000), file, 1000, 'h');
  assert.equal(recordSample(quotaOf(10, 2000), file, 1000, 'h').reason, 'duplicate');
  assert.equal(readSamples(file).length, 1);
  // 不同时刻/不同周期照常记录
  assert.equal(recordSample(quotaOf(12, 2000), file, 1100, 'h').recorded, true);
  // 早于末行的重复(非末行位置)同样被拦——等价 widget 的 UNIQUE 约束
  assert.equal(recordSample(quotaOf(10, 2000), file, 1000, 'h').reason, 'duplicate');
  assert.equal(readSamples(file).length, 2);
  // 跨服务商的同刻采样各留一条(不同流不互斥)
  assert.equal(recordSample(quotaOf(10, 2000), file, 1000, 'other').recorded, true);
  assert.equal(readSamples(file).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSample:水位为 null/缺失时不记录(绝不伪造 0%)', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  const withNull = { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: null, nextResetTime: 2000 }] };
  const missing = { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, nextResetTime: 2000 }] };
  assert.equal(recordSample(withNull, file, 1000, 'h').recorded, false); // Number(null)=0 陷阱
  assert.equal(recordSample(missing, file, 1000, 'h').recorded, false);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readSamples:坏行跳过、文件不存在返回空', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"at":1,"resetAt":2,"usedPct":3}\nnot-json\n\n{"at":4}\n');
  assert.equal(readSamples(file).length, 2);
  assert.equal(readSamples(path.join(dir, 'none.jsonl')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- periodsOf:周期分组 ----------
test('periodsOf:按 host+resetAt 分组(跨服务商不合并),首见/末次/峰值/进行中,降序;坏行忽略', () => {
  const now = 250; // resetAt 100/200 已过期,300 仍在进行中
  const rows = [
    { at: 1, resetAt: 100, usedPct: 10 },
    { at: 2, resetAt: 100, usedPct: 50 },
    { at: 3, resetAt: 100, usedPct: 30 }, // 末次(乱序到达也按 at 取)
    { at: 4, resetAt: 200, usedPct: 70 },
    { at: 5, resetAt: 300, usedPct: 15 },
    { at: 6, resetAt: 300, usedPct: 'oops' }, // 非法水位忽略
    { at: 7, resetAt: 100, usedPct: 5, host: 'api.z.ai' }, // 同 resetAt 不同服务商 → 独立周期
  ];
  const p = periodsOf(rows, now);
  assert.equal(p.length, 4);
  assert.deepEqual(p.map((x) => x.resetAt), [300, 200, 100, 100]); // 降序(同 resetAt 双流相邻)
  assert.deepEqual(p.map((x) => x.host), ['', '', '', 'api.z.ai']);
  const first = p[2];
  assert.equal(first.count, 3);
  assert.equal(first.firstPct, 10);
  assert.equal(first.lastPct, 30); // at=3 末次,而非峰值 50
  assert.equal(first.peakPct, 50);
  assert.equal(first.active, false);
  assert.equal(p[0].active, true); // resetAt=300 > now
  assert.equal(p[0].count, 1); // 非法行未计入
  assert.equal(p[3].count, 1); // 跨服务商流独立
});

// ---------- dayConsumption:窗口平均消耗(北京日归属 = 周期中点) ----------
test('dayConsumption:跨日周期按中点归属,日均=各周期末次水位平均', () => {
  const dayA = Date.parse('2026-10-15T00:00:00+08:00');
  const dayB = dayA + 86400_000;
  const now = dayB + 10 * 3600_000;
  const rows = [
    // 周期1:05h 起于 dayA,10h 重置 → 中点 07.5h → dayA;末次 40%
    { at: dayA + 5 * 3600_000, resetAt: dayA + 10 * 3600_000, usedPct: 40 },
    // 周期2:10h→22h → 中点 16h → dayA;末次 80%
    { at: dayA + 11 * 3600_000, resetAt: dayA + 22 * 3600_000, usedPct: 80 },
    // 周期3:22h(dayA)→03h(dayB) → 中点 00.5h → dayB;末次 60%
    { at: dayA + 23 * 3600_000, resetAt: dayB + 3 * 3600_000, usedPct: 60 },
  ];
  const days = dayConsumption(rows, 7, now);
  assert.equal(days.length, 7);
  const a = days[days.length - 2];
  const b = days[days.length - 1];
  assert.equal(a.dayLabel, '10-15');
  assert.equal(a.n, 2);
  assert.equal(a.meanPct, 60); // (40+80)/2
  assert.equal(b.dayLabel, '10-16');
  assert.equal(b.n, 1);
  assert.equal(b.meanPct, 60);
  assert.equal(days[0].n, 0);
  assert.equal(days[0].meanPct, null);
});

test('dayConsumption:进行中周期不参与统计', () => {
  const now = 10_000;
  const rows = [{ at: 1, resetAt: now + 500, usedPct: 90 }];
  const days = dayConsumption(rows, 3, now);
  assert.ok(days.every((d) => d.n === 0));
});
