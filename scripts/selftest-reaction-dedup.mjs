/**
 * 自检：验证「排除今日已点过的图」这条逻辑，不需联网、不碰账号。
 * 用法：node scripts/selftest-reaction-dedup.mjs
 */
import { reactedImageIds } from '../src/engine.mjs';
import { TASKS, summarizeRewards } from '../src/tasks.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
};

console.log('\n=== 1. 从流水里提取「今天点过的图片 ID」 ===');

// 真实流水的形状（取自 2026-09-30 的实测样本，已脱敏）
const tx = (forId, type = 'encouragement:image', amount = 2) => ({
  amount,
  description: 'Buzz Reward: For encouraging others to post content',
  details: { byUserId: 1, forId, type },
});

const txs = [
  tx(141670819),
  tx(141670817),
  tx(141670168),
  tx(141670819),                                   // 重复项，应去重
  { amount: 25, description: 'Buzz Reward: For claiming daily boost rewards', details: { forId: 1, type: 'dailyBoost' } },
  { amount: -200, details: { type: 'encouragement:image', forId: 999 } },  // 支出不算
  { amount: 2, details: { type: 'encouragement:model', forId: 777 } },     // 非 image 不算
  { amount: 2, details: {} },                                              // 缺字段
];

const ids = reactedImageIds(txs);
check('只收 encouragement:image 的 forId', ids.size === 3, `实际 ${ids.size}`);
check('包含 141670819', ids.has(141670819));
check('支出（amount<0）不计入', !ids.has(999));
check('非 image 类型不计入', !ids.has(777));

console.log('\n=== 2. 排除逻辑：候选池过滤后不应含已点过的 ===');
const pool = [141670819, 141670817, 141670168, 141670000, 141669999].map((id) => ({ id }));
const fresh = pool.filter((i) => !ids.has(i.id));
check('剩 2 张未点过', fresh.length === 2, `实际 ${fresh.length}`);
check('过滤结果里没有已点过的', fresh.every((i) => !ids.has(i.id)));

console.log('\n=== 3. 流水归类（description 原文匹配）===');
// 按真实构成造样本：50 笔反应 + 3 笔关注 + 1 笔领取 + 1 笔同账户转移
const rewardTx = (amount, description, from = 'yellow', to = 'blue') => ({
  amount, fromAccountType: from, toAccountType: to, description,
});
const full = [];
for (let i = 0; i < 50; i += 1) {
  full.push(rewardTx(2, 'Buzz Reward: For encouraging others to post content'));
}
for (let i = 0; i < 3; i += 1) {
  full.push(rewardTx(10, 'Buzz Reward: For first 3 people that you follow each day'));
}
full.push(rewardTx(25, 'Buzz Reward: For claiming daily boost rewards'));
full.push(rewardTx(200, 'Gain access to model: X', 'blue', 'blue')); // 同账户转移，不算奖励

const sum = summarizeRewards(full);
check('encouragement = 100（50 笔 × 2）', sum.byType.encouragement === 100, String(sum.byType.encouragement));
check('firstDailyFollow = 30（3 笔 × 10）', sum.byType.firstDailyFollow === 30, String(sum.byType.firstDailyFollow));
check('dailyBoost = 25', sum.byType.dailyBoost === 25, String(sum.byType.dailyBoost));
check('合计 155（同账户转移被排除）', sum.total === 155, String(sum.total));
check('无未识别项', sum.unknown.length === 0, JSON.stringify(sum.unknown));

console.log('\n=== 4. 任务定义自洽性 ===');
check('共 12 项任务', TASKS.length === 12, String(TASKS.length));
check('每项都有 amount', TASKS.every((t) => typeof t.amount === 'number'));
check('日限额项都有 cap', TASKS.filter((t) => t.capInterval === 'day').every((t) => t.cap > 0));
const auto = TASKS.filter((t) => ['dailyBoost', 'firstDailyFollow', 'encouragement'].includes(t.type));
check('可自动三项合计 155', auto.reduce((s, t) => s + t.cap, 0) === 155, String(auto.reduce((s, t) => s + t.cap, 0)));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
