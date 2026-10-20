// 用量曲线单测(node --test,零依赖):payload 纯函数 + 子进程服务集成
// 运行:node --test plugins/zcode-usage/skills/zcode-usage/scripts/quota-curve.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { curvePayloadFromFile } from './quota-curve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quota-curve-'));

test('curvePayloadFromFile:分组/剩余换算/峰值/状态/排序;坏行忽略', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  
  fs.writeFileSync(file, [
    JSON.stringify({ at: 1, resetAt: 100, usedPct: 40, level: 'pro', host: 'a.cn' }),
    JSON.stringify({ at: 2, resetAt: 100, usedPct: 80, level: 'pro', host: 'a.cn' }),
    JSON.stringify({ at: 3, resetAt: 300, usedPct: 15, host: 'a.cn' }),
    JSON.stringify({ at: 4, resetAt: 300, usedPct: 'oops', host: 'a.cn' }), // 非法水位忽略
    JSON.stringify({ at: 5, resetAt: 100, usedPct: 5, host: 'b.cn' }), // 跨服务商独立周期
  ].join('\n') + '\n');
  const p = curvePayloadFromFile(file, 250); // now=250:reset 300 进行中,100 已过期
  assert.equal(p.periods.length, 3);
  assert.deepEqual(p.periods.map((x) => x.reset_at), [300, 100, 100]); // 重置时刻降序
  const active = p.periods[0];
  assert.equal(active.status, 'active');
  assert.equal(active.samples.length, 1);
  assert.equal(active.samples[0][1], 85); // 剩余 = 100 - 已用
  const done = p.periods[1];
  assert.equal(done.status, 'expired');
  assert.equal(done.peak_used_percent, 80);
  assert.deepEqual(done.samples, [[1, 60], [2, 20]]); // 时间升序
  assert.ok(done.plan_levels.includes('PRO'));
  assert.equal(p.periods[2].provider_name, 'b.cn');
  assert.equal(p.periods[2].samples.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('curvePayloadFromFile:超过 60 个周期只保留最近的 60 个', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  const lines = [];
  for (let i = 1; i <= 70; i++) {
    lines.push(JSON.stringify({ at: i, resetAt: i * 1000, usedPct: 10, host: 'a.cn' }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const p = curvePayloadFromFile(file, 1_000_000);
  assert.equal(p.periods.length, 60);
  assert.equal(p.periods[0].reset_at, 70_000); // 最近的在前
  fs.rmSync(dir, { recursive: true, force: true });
});

test('服务集成:静态页/echarts/数据路由;无凭据时 /models 返回空对象', async () => {
  const dir = tmp();
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.zcode'), { recursive: true }); // 空 HOME:findCred 必然失败
  const samples = path.join(dir, 's.jsonl');
  fs.writeFileSync(samples, JSON.stringify({ at: 1, resetAt: Date.now() + 3600_000, usedPct: 30, host: 'a.cn' }) + '\n');
  const child = spawn(process.execPath, [path.join(HERE, 'quota-curve.mjs'),
    '--no-open', '--samples', samples], {
    env: { ...process.env, USERPROFILE: home, HOME: home, ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", ZAI_API_KEY: "" },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      const buf = [];
      const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout.on('data', (d) => {
        buf.push(d);
        const m = Buffer.concat(buf).toString().match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
      });
    });
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('用量曲线'));
    const js = await fetch(`${url}/echarts.min.js`);
    assert.equal(js.status, 200);
    const data = await (await fetch(`${url}/data`)).json();
    assert.equal(data.periods.length, 1);
    assert.equal(data.periods[0].samples[0][1], 70);
    const models = await (await fetch(`${url}/models`)).json();
    assert.deepEqual(models, {}); // 空 HOME 无凭据:优雅降级,不崩、不发网络
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
