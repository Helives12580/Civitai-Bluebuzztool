/**
 * 诊断脚本：拉取 civitai 官方的「任务定义与上限」，与本地 src/tasks.mjs 交叉验证。
 *
 * 端点：user.userRewardDetails（protectedProcedure）
 * 注意源码里的取舍：`awarded` / `awardedCount` 返回 -1 —— 官方注释说明
 * 「按需查 awarded 需要一次 ClickHouse 全量查询，暂不做」。所以这个端点给的是
 * 定义与上限，不含进度；进度只能从交易流水取。
 *
 * 用法：node scripts/probe-reward-details.mjs
 *
 * 运行前需要已有账号：先启动工具并在面板「添加账号」。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from '../src/tasks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let cfg;
try {
  cfg = JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf8'));
} catch {
  console.error('找不到 data/config.json。');
  console.error('请先启动工具（双击 start.bat），在面板里「添加账号」并点「验证 Key」，再运行本脚本。');
  process.exit(1);
}
const acc = cfg.accounts?.[0];
if (!acc) {
  console.error('data/config.json 里还没有账号。');
  console.error('请先在面板「添加账号」并点「验证 Key」，再运行本脚本。');
  process.exit(1);
}

const base = acc.host === 'red' ? 'https://civitai.red' : 'https://civitai.com';
const url = `${base}/api/trpc/user.userRewardDetails?input=${encodeURIComponent(
  JSON.stringify({ json: {} }),
)}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${acc.apiKey}` } });
const body = await res.json();
if (body?.error) {
  console.error('查询失败:', JSON.stringify(body.error.json));
  process.exit(1);
}

const rows = body?.result?.data?.json ?? [];
console.log(`官方返回 ${rows.length} 项\n`);

const local = new Map(TASKS.map((t) => [t.type, t]));
const norm = (s) => (s ?? '').replace(/^Buzz Reward:\s*/, '').trim();

let mismatch = 0;
/** 官方 API 对 onDemand 项不返回 interval（它们用单值 cap 定义，intervalCap 取自 caps 数组）。 */
let intervalGap = 0;
console.log('官方 type / 单次 / 上限 / 周期 / onDemand   ←→   本地');
console.log('─'.repeat(96));
for (const r of rows) {
  const l = local.get(r.type);
  // interval 只对非 onDemand 项可比：官方对 onDemand 项恒返回空，语义上它们是按 UTC 日结算的。
  const intervalComparable = !r.onDemand;
  const same =
    l &&
    Number(l.amount) === Number(r.awardAmount) &&
    (l.cap ?? null) === (r.cap ?? null) &&
    (!intervalComparable || (l.capInterval ?? null) === (r.interval ?? null));
  if (!same) mismatch += 1;
  if (r.onDemand && r.interval == null) intervalGap += 1;
  const flag = same ? '✓' : '✗';
  const lo = l ? `${l.amount} / ${l.cap ?? '—'} / ${l.capInterval ?? '—'}` : '（本地无此项）';
  console.log(
    `${flag} ${String(r.type).padEnd(28)} ${String(r.awardAmount).padStart(4)} / ${String(
      r.cap ?? '—',
    ).padStart(6)} / ${String(r.interval ?? '—').padEnd(5)} / ${
      r.onDemand ? 'Y' : 'N'
    }   ←→  ${lo}`,
  );
  if (!same) {
    console.log(`     官方描述: ${r.description}`);
    console.log(`     官方 trigger: ${r.triggerDescription ?? '—'}`);
  }
}

console.log('─'.repeat(96));
const localOnly = TASKS.filter((t) => !rows.some((r) => r.type === t.type));
if (localOnly.length) {
  console.log('本地有、官方未返回:', localOnly.map((t) => t.type).join(', '));
  console.log('  （这些 reward 在源码里标了 visible: false，官方 UI 不展示，但奖励真实可得）');
}
console.log(`\n实质不一致项: ${mismatch} / ${rows.length}`);
console.log(
  `官方 interval 字段缺口: ${intervalGap} 项（全部是 onDemand 项，官方返回空 —— 已知 API 行为，非本地错误）`,
);

// 顺带核对 description 映射表（流水归类靠它）
console.log('\n=== description 映射核对（流水归类依据）===');
for (const r of rows) {
  const l = local.get(r.type);
  if (!l) continue;
  const official = norm(r.description);
  console.log(`  ${String(r.type).padEnd(28)} 官方="${official}"`);
}
