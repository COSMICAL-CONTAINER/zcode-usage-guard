// zcode-usage 纯函数单测(node --test,零依赖)
// 运行:node --test plugins/zcode-usage-guard/skills/zcode-usage/scripts/zcode-usage.test.mjs
// 日历事实:2026-09-11 是周五,09-12 周六,09-13 周日,09-07 周一
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bjFmt, bjDayStartMs, weekdayOfDateStr, isPeakHourLabel, peakOf,
} from './zcode-usage.mjs';

// ---------- 北京时间折算(纯 UTC 运算,结果与本机时区无关) ----------
test('bjFmt:epoch → 北京时间字符串', () => {
  assert.equal(bjFmt(Date.UTC(2026, 8, 10, 16, 30, 5)), '2026-09-11 00:30:05');
  assert.equal(bjFmt(Date.parse('2026-09-11T18:00:00+08:00')), '2026-09-11 18:00:00');
  assert.equal(bjFmt(Date.parse('2026-09-11T10:00:00Z')), '2026-09-11 18:00:00');
});

test('bjDayStartMs:任意时刻 → 所在北京日的零点', () => {
  assert.equal(bjDayStartMs(Date.parse('2026-09-11T18:33:00+08:00')), Date.parse('2026-09-11T00:00:00+08:00'));
  assert.equal(bjDayStartMs(Date.parse('2026-09-11T00:00:01+08:00')), Date.parse('2026-09-11T00:00:00+08:00'));
  // 北京 9-11 23:30 = UTC 9-11 15:30,仍属北京 9-11
  assert.equal(bjDayStartMs(Date.UTC(2026, 8, 11, 15, 30, 0)), Date.parse('2026-09-11T00:00:00+08:00'));
});

test('weekdayOfDateStr:走 Date.UTC;畸形返回 -1', () => {
  assert.equal(weekdayOfDateStr('2026-09-11'), 5);
  assert.equal(weekdayOfDateStr('2026-09-12'), 6);
  assert.equal(weekdayOfDateStr('2026-09-13'), 0);
  assert.equal(weekdayOfDateStr('oops'), -1);
  assert.equal(weekdayOfDateStr(''), -1);
});

// ---------- 高峰判定(工作日北京时间 14:00–17:59,小时桶左闭右开) ----------
test('isPeakHourLabel:工作日 14–17 点桶为高峰;18 点桶起非高峰;周末全否', () => {
  assert.equal(isPeakHourLabel('2026-09-11 14:00'), true);
  assert.equal(isPeakHourLabel('2026-09-11 17:00'), true);
  // 回归点:18 点桶属非高峰(旧实现晚间把全天算进高峰的 bug)
  assert.equal(isPeakHourLabel('2026-09-11 18:00'), false);
  assert.equal(isPeakHourLabel('2026-09-11 13:00'), false);
  assert.equal(isPeakHourLabel('2026-09-11 02:00'), false);
  assert.equal(isPeakHourLabel('2026-09-12 14:00'), false); // 周六
  assert.equal(isPeakHourLabel('2026-09-13 15:00'), false); // 周日
  assert.equal(isPeakHourLabel('2026-09-07 14:00'), true); // 周一
  assert.equal(isPeakHourLabel(''), false);
  assert.equal(isPeakHourLabel(null), false);
});

test('peakOf:按桶标签归类高峰;畸形标签跳过;空响应归零', () => {
  const mu = {
    x_time: ['2026-09-11 00:00', '2026-09-11 14:00', '2026-09-11 15:00', '2026-09-11 17:00', '2026-09-11 18:00', 'oops'],
    modelCallCount: [30, 5, 6, 7, 9, 99],
    tokensUsage: [100, 50, 60, 70, 90, 999],
  };
  assert.deepEqual(peakOf(mu), { calls: 18, tokens: 180 });
  assert.deepEqual(peakOf(null), { calls: 0, tokens: 0 });
  assert.deepEqual(peakOf({}), { calls: 0, tokens: 0 });
  // 周六桶即使落在 14–17 点也全为非高峰
  assert.deepEqual(
    peakOf({ x_time: ['2026-09-12 14:00'], modelCallCount: [5], tokensUsage: [50] }),
    { calls: 0, tokens: 0 },
  );
  // 高峰进行中(16 点桶为部分数据),只计已出现的 14/15/16 桶
  assert.deepEqual(
    peakOf({
      x_time: ['2026-09-11 14:00', '2026-09-11 15:00', '2026-09-11 16:00'],
      modelCallCount: [5, 6, 2],
      tokensUsage: [50, 60, 20],
    }),
    { calls: 13, tokens: 130 },
  );
});

// ---- 周期历史:missingCycleEnds ----
import { missingCycleEnds } from './zcode-usage.mjs';

test('missingCycleEnds:从最近已完成周期往前补录,不含未结束的当前周期', () => {
  const now = 1_000_000_000_000;
  const cycle = 5 * 3600_000;
  const nextReset = now + 2 * 3600_000; // 当前周期还剩 2 小时
  const ends = missingCycleEnds(nextReset, cycle, 0, 2, now);
  assert.deepEqual(ends, [nextReset - cycle, nextReset - 2 * cycle]);
});

test('missingCycleEnds:尊重 lastEnd,不重复补录', () => {
  const now = 1_000_000_000_000;
  const cycle = 5 * 3600_000;
  const nextReset = now + 3600_000;
  const lastEnd = nextReset - cycle; // 最近一个已补录
  const ends = missingCycleEnds(nextReset, cycle, lastEnd, 2, now);
  // 该周期已在记录里(lastEnd),更旧的周期按时间顺序不回填 → 无需补录
  assert.deepEqual(ends, []);
});

test('missingCycleEnds:maxBack 限制回填数量', () => {
  const now = 1_000_000_000_000;
  const ends = missingCycleEnds(now, 5 * 3600_000, 0, 2, now);
  assert.equal(ends.length, 2);
});

// ---- 本机消耗:localUsageToday ----
import { localUsageToday } from './zcode-usage.mjs';

test('localUsageToday:按北京时间当日过滤并聚合(不含昨日/无用量行)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-usage-'));
  const now = Date.now();
  const dayStart = bjDayStartMs(now); // 北京当日 00:00(epoch)
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (completedAt, total, inp, outp, modelId = 'GLM-5.3-Flash') =>
    JSON.stringify({ completedAt, model: { modelId }, response: { usage: { inputTokens: inp, outputTokens: outp, totalTokens: total } } });
  // 今天北京时间内的一条 + 北京昨天的一条 + 无用量的一条
  const lines = [
    mk(iso(dayStart + 10 * 3600_000), 1000, 900, 100),
    mk(iso(dayStart - 3600_000), 9999, 9999, 9999), // 北京昨天:不入账
    mk(iso(dayStart + 11 * 3600_000)).replace('"totalTokens"', '"otherTokens"'), // 无用量
  ];
  fs.writeFileSync(path.join(dir, 'model-io-sess_test.jsonl'), lines.join('\n'));
  const u = localUsageToday(now, dir);
  assert.equal(u.calls, 1);
  assert.equal(u.totalTokens, 1000);
  assert.equal(u.inputTokens, 900);
  assert.equal(u.outputTokens, 100);
  assert.equal(u.byModel['GLM-5.3-Flash'].calls, 1);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
