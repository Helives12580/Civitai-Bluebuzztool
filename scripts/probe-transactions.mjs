/**
 * 诊断脚本：拉今日交易流水，逐笔列出所有奖励入账。
 * 用途：自己核对「本轮实际到账」—— 这是最权威的口径（余额会被你自己的消费干扰）。
 * 用法：node scripts/probe-transactions.mjs [YYYY-MM-DD]
 *
 * 运行前需要已有账号：先启动工具并在面板「添加账号」。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const start = `${day}T00:00:00.000Z`;
const end = `${day}T23:59:59.999Z`;

const payload = { json: { start, end, limit: 200 }, meta: { values: { start: ['Date'], end: ['Date'] } } };
const url = `${base}/api/trpc/buzz.getUserTransactions?input=${encodeURIComponent(JSON.stringify(payload))}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${acc.apiKey}` } });
const body = await res.json();
if (body?.error) {
  console.error('查询失败:', body.error.json.message);
  process.exit(1);
}

const txs = body?.result?.data?.json?.transactions ?? [];
const income = txs.filter((t) => t.amount > 0);

console.log(`账号 ${acc.name} @ ${base}  日界(UTC) ${day}`);
console.log(`交易总数 ${txs.length}，其中入账 ${income.length} 笔\n`);

let sum = 0;
console.log('=== 入账明细 ===');
for (const t of income) {
  sum += t.amount;
  const wallet = `${t.fromAccountType}->${t.toAccountType}`;
  console.log(`  +${String(t.amount).padEnd(6)} ${t.date}  ${wallet.padEnd(14)} ${t.description ?? ''}`);
}
console.log(`\n入账合计：${sum}\n`);

console.log('=== 按奖励类型计数 ===');
const byDesc = {};
for (const t of income) {
  const d = (t.description ?? '?').replace(/^Buzz Reward:\s*/, '');
  byDesc[d] = (byDesc[d] ?? 0) + 1;
}
for (const [d, c] of Object.entries(byDesc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(3)} ×  ${d}`);
}

console.log('\n=== 支出（amount<0）===');
for (const t of txs.filter((x) => x.amount < 0).slice(0, 8)) {
  console.log(`  ${String(t.amount).padEnd(7)} ${t.date}  ${t.fromAccountType}->${t.toAccountType}  ${t.description ?? ''}`);
}
