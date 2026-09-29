/**
 * civitai Blue Buzz 每日任务权威清单。
 *
 * 逐项取自 civitai 主仓 `src/server/rewards/*.reward.ts` 的 createBuzzEvent 定义
 * （type / awardAmount / cap / onDemand / triggerDescription），并与面板截图一一对应。
 *
 * 已与官方 `user.userRewardDetails` 交叉验证：11 项的单次金额、上限、description 原文
 * 全部逐字一致（见 README「与官方任务中心的交叉验证」）。
 *
 * 关于 `capInterval`：官方接口对 `onDemand: true` 的项**不返回 interval**（它们用单值 cap
 * 定义，而 interval 取自 caps[] 数组）。这些项按源码语义确实是**按 UTC 日**结算的 ——
 * getKey 用 `dayjs().startOf('day')` 当 forId、Redis 去重键按 UTC 日过期，所以这里标 day。
 *
 * `mode` 表示本工具对该任务的处置策略：
 *   auto     —— 纯 API 可完成，引擎直接执行
 *   assisted —— 有 API 路径，但依赖前置条件（如已有生成记录 / 已有人给你提交 remix）
 *   passive  —— 由他人行为触发，无自触发路径（工具只做展示与进度解释）
 *   locked   —— 需要产生真实内容（发图 / 举报），不自动化
 */

/** 每项：type 即源码里的 reward type（也是查询/日志的键）。 */
export const TASKS = [
  {
    type: 'dailyBoost',
    label: '每日在生成器领取',
    trigger: 'By claiming it daily in the Image generator',
    amount: 25,
    cap: 25,
    capInterval: 'day',
    onDemand: true,
    mode: 'auto',
    scope: 'BuzzRead',
    action: 'buzz.claimDailyBoostReward',
    note: '一条调用即得。UTC 零点后可再次领取。',
  },
  {
    type: 'encouragement',
    label: '给出独特反应',
    trigger: 'For each unique reaction you give',
    amount: 2,
    cap: 100,
    capInterval: 'day',
    onDemand: true,
    mode: 'auto',
    scope: 'SocialWrite',
    action: 'reaction.toggle',
    note: '每次 2，日上限 100 —— 需 50 次。同一对象重复反应不再奖励，故每次换一张图。',
  },
  {
    type: 'firstDailyFollow',
    label: '每日首次关注他人',
    trigger: 'For first 3 people that you follow each day',
    amount: 10,
    cap: 30,
    capInterval: 'day',
    onDemand: true,
    mode: 'auto',
    scope: 'Full',
    action: 'user.toggleFollow',
    note: '每天 3 人各 10。取关再关注同一人不重复奖励。',
  },
  {
    type: 'generation-feedback',
    label: '生成器反馈',
    trigger: 'For feedback given on the generator',
    amount: 4,
    cap: 40,
    capInterval: 'day',
    onDemand: true,
    mode: 'assisted',
    scope: 'Full',
    action: 'orchestrator.patchWorkflowSteps',
    note: '需先有生成记录，再对 step metadata 写入 feedback 补丁。链路较长。',
  },
  {
    type: 'firstDailyPost',
    label: '每日首图发帖',
    trigger: 'For the first image post you make each day',
    amount: 25,
    cap: 25,
    capInterval: 'day',
    onDemand: true,
    mode: 'locked',
    scope: 'MediaWrite',
    action: 'post.create',
    note: '需要真实上传一张图并发布为 post。',
  },
  {
    type: 'remixAccept',
    label: '接受 remix 提交',
    trigger: 'For each of the first 5 remix submissions you accept each day',
    amount: 20,
    cap: 100,
    capInterval: 'day',
    onDemand: true,
    mode: 'assisted',
    scope: 'Full',
    action: 'remixGallery.settlePlacement',
    note: '收益归 gallery 拥有者。需你开了 remix gallery 且有人提交。',
  },
  {
    type: 'stickerPlacementAccepted',
    label: '内容被贴上贴纸',
    trigger: 'For each sticker you get on your content, up to 10 a day',
    amount: 10,
    cap: 100,
    capInterval: 'day',
    onDemand: true,
    mode: 'passive',
    scope: '—',
    action: '—',
    note: '由贴纸提交方触发，自动通过的 gallery 内联结算，本人无操作入口。',
  },
  {
    type: 'collectedContent',
    label: '内容被收藏',
    trigger: 'For each time a user collects your content',
    amount: 2,
    cap: 100,
    capInterval: 'day',
    onDemand: false,
    mode: 'passive',
    scope: '—',
    action: '—',
    note: '他人把你发布的模型/图片/文章加入收藏夹时结算。',
  },
  {
    type: 'goodContent',
    label: '你的内容被他人反应',
    trigger: 'For each user that reacts to anything you created in the last 30 days',
    amount: 2,
    cap: 100,
    capInterval: 'day',
    onDemand: false,
    mode: 'passive',
    scope: '—',
    action: '—',
    note: '被动收益，取决于你已发布内容的受欢迎程度。',
  },
  {
    type: 'imagePostedToModel',
    label: '他人用你的模型发图',
    trigger: 'For each user that posts an image to your model',
    amount: 50,
    cap: 50000,
    capInterval: 'month',
    onDemand: false,
    mode: 'passive',
    scope: '—',
    action: '—',
    note: '单条上限 5000，月度 50000。取决于模型使用量。',
  },
  {
    type: 'reportAccepted',
    label: '举报被受理',
    trigger: 'For each report you make that is accepted',
    amount: 50,
    cap: 1500,
    capInterval: 'month',
    onDemand: false,
    mode: 'locked',
    scope: '—',
    action: '—',
    note: '需提交有效举报并经审核通过。',
  },
  {
    type: 'userReferred',
    label: '邀请他人注册',
    trigger: 'For each person you refer',
    amount: 500,
    cap: null,
    capInterval: null,
    onDemand: true,
    mode: 'assisted',
    scope: 'Full',
    action: '—',
    note: '需生成邀请码并有人以该码注册（双方各得 500）。官方 UI 不展示（源码里 visible: false），但奖励真实可得。',
  },
];

/**
 * 「站点侧今日已得」的识别表。
 *
 * buzz.getUserTransactions 的每笔奖励只带一句英文 description（reward 定义里的 `description`），
 * 没有可对的 type 字段，所以只能用 description 原文匹配。
 * 下面每个值都是**逐字抄自** src/server/rewards/*.reward.ts 的 `description:`，不是意译 ——
 * 差一个字符就归不了类，认不出会返回 null（宁可认不出，也不猜）。
 */
export const REWARD_DESCRIPTIONS = {
  dailyBoost: 'For claiming daily boost rewards',
  encouragement: 'For encouraging others to post content',
  firstDailyFollow: 'For first 3 people that you follow each day',
  'generation-feedback': 'For giving feedback to images created on the generator',
  firstDailyPost: 'You made your first post of the day',
  remixAccept: 'You accepted a remix into your gallery',
  stickerPlacementAccepted: 'You got a sticker on your content',
  collectedContent: 'Content that you posted was collected by someone else',
  goodContent: 'Content that you posted was liked by someone else',
  imagePostedToModel: 'Image posted to a model you own',
  reportAccepted: 'For each report you make that is accepted',
  userReferred: 'You have referred another user',
  refereeCreated: 'You have been referred by another user',
};

export const REWARD_BY_DESCRIPTION = new Map(
  Object.entries(REWARD_DESCRIPTIONS).map(([type, desc]) => [desc, type]),
);

/** 把流水里的一笔奖励归到任务类型；认不出返回 null。 */
export function classifyReward(description) {
  if (typeof description !== 'string') return null;
  const text = description.replace(/^Buzz Reward:\s*/, '').trim();
  return REWARD_BY_DESCRIPTION.get(text) ?? null;
}

/**
 * 把一批流水按任务类型汇总成「今日站点侧已得」。
 * @returns {{byType: Record<string, number>, byTypeCount: Record<string, number>, total: number, unknown: Array}}
 */
export function summarizeRewards(transactions) {
  const byType = {};
  const byTypeCount = {};
  const unknown = [];
  let total = 0;
  for (const t of transactions ?? []) {
    if (!(t?.amount > 0)) continue;          // 只看入账
    if (t.fromAccountType === t.toAccountType) continue; // 同账户间转移不算奖励
    total += t.amount;
    const type = classifyReward(t.description);
    if (!type) {
      unknown.push({ amount: t.amount, description: t.description ?? null, date: t.date });
      continue;
    }
    byType[type] = (byType[type] ?? 0) + t.amount;
    byTypeCount[type] = (byTypeCount[type] ?? 0) + 1;
  }
  return { byType, byTypeCount, total, unknown };
}

/** 引擎可自动执行的任务（按执行顺序：先零成本的领取，再做需要节奏控制的操作）。 */
export const AUTO_TYPES = ['dailyBoost', 'firstDailyFollow', 'encouragement'];

export const TASK_BY_TYPE = new Map(TASKS.map((t) => [t.type, t]));

/** 理论上限合计（仅 auto 项，按日）。 */
export function autoDailyCeiling() {
  return AUTO_TYPES.reduce((sum, type) => sum + (TASK_BY_TYPE.get(type)?.cap ?? 0), 0);
}
