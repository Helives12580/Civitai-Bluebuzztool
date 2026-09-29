/**
 * Blue Buzz 任务引擎 —— 两阶段模型。
 *
 *   阶段一 scan()：**只读**。调用的全是 query 类端点（me / buzz.getUserAccount /
 *                  user.getFollowingUsers / 公开图片接口），不产生任何副作用。
 *                  输出「当前可做的任务 + 依据 + 计划次数 + 预计收益」，等人确认。
 *   阶段二 run()： 按确认后的计划执行。只做 plan 里标了 doable 的项。
 *
 * 四项安全设计（都是刻意的，改动前请先读完）：
 *   1. 扫描与执行分离 —— 用户点「开始完成」之前，不会发出任何写操作。
 *   2. follow 是 toggle 语义（再调一次就是取关），所以执行前必须拿到已关注列表；
 *      取不到就整项跳过，绝不在盲状态下调用。
 *   3. 认证失败立即中止整轮，不做无谓重试；命中 429 自动退避 30 秒再续。
 *   4. 每完成一次就落盘，并记录执行前后的余额差值，用于核对真实到账。
 */

import { CivitaiClient, describeError, extractBuzzAccounts } from './civitai.mjs';
import { AUTO_TYPES, TASK_BY_TYPE, summarizeRewards } from './tasks.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

/** 多数「已领取 / 已达上限」类响应是正常状态，不该报成失败。 */
const BENIGN = /already|claimed|cap|limit reached|too many|duplicate|exceed/i;

function normalizeFollowing(res) {
  const arr = Array.isArray(res)
    ? res
    : (res?.items ?? res?.users ?? res?.following ?? []);
  if (!Array.isArray(arr)) return null;
  return new Set(
    arr
      .map((x) => (typeof x === 'string' ? x : x?.username))
      .filter((x) => typeof x === 'string' && x.length > 0)
      .map((x) => x.toLowerCase()),
  );
}

/**
 * 把请求留痕汇总成「端点 → 方法/状态码分布/次数」。
 * 用于权限侦测与站点行为核对；不包含 key、请求体与响应体。
 */
function summarizeCalls(calls) {
  const map = new Map();
  for (const c of calls ?? []) {
    const key = `${c.method} ${c.path}`;
    const cur = map.get(key) ?? { method: c.method, path: c.path, count: 0, statuses: {} };
    cur.count += 1;
    cur.statuses[c.status] = (cur.statuses[c.status] ?? 0) + 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

export class BuzzEngine {
  #store;
  #running = new Map();
  /** 最近一次扫描结果，供 run 与面板复用（按账号）。 */
  #scans = new Map();

  constructor({ store }) {
    this.#store = store;
  }

  isRunning(accountId) {
    return this.#running.has(accountId);
  }

  runningIds() {
    return [...this.#running.keys()];
  }

  cancel(accountId) {
    const ctl = this.#running.get(accountId);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  lastScan(accountId) {
    return this.#scans.get(accountId) ?? null;
  }

  // ═══════════════════ 阶段一：扫描（只读） ═══════════════════

  /**
   * 读取站点侧可得的事实 + 本地当日记录，推断当前可做的任务。
   * 不做任何写操作；不改变账号状态。
   */
  async scan(accountId) {
    const account = this.#store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');

    const settings = this.#store.settings;
    const day = this.#store.dayState(accountId);
    const client = new CivitaiClient({ apiKey: account.apiKey, host: account.host });

    const result = {
      ok: false,
      accountId,
      username: account.profile?.username ?? null,
      tier: null,
      scannedAt: new Date().toISOString(),
      utcDay: day.day,
      baselineBuzz: null,
      tasks: [],
      doableCount: 0,
      plannedEarn: 0,
      notes: [],
    };

    // 1) 认证与账号信息 —— 顺便拿到 scope，判断后续只读调用是否会有权限问题
    try {
      const me = await client.me();
      result.username = me.username;
      result.tier = me.tier;
      result.tokenScope = me.tokenScope ?? null;
      this.#store.updateAccount(accountId, {
        profile: { ...(account.profile ?? {}), id: me.id, username: me.username, tier: me.tier, status: me.status, isMember: !!me.isMember, tokenScope: me.tokenScope ?? null, verifiedAt: new Date().toISOString() },
      });
    } catch (e) {
      result.authError = describeError(e);
      result.notes.push('API key 未通过认证，无法扫描。请先确认 key 有效且已启用。');
      this.#scans.set(accountId, result);
      return result;
    }

    // 2) blue 钱包余额 —— 作为执行后核对真实到账的基线。
    //    Blue Buzz 奖励入的是 blue 账户，与 yellow 是独立钱包；blue 账户首次获得时才创建，
    //    所以「调用成功但没有 blue 账户」= 余额 0，而不是「未知」。只有调用失败才是未知。
    try {
      const accs = extractBuzzAccounts(await client.getBuzzAccount());
      result.baselineBuzz = accs.blue ?? 0;
      result.buzzAccounts = accs.accounts.map((a) => ({
        type: a?.accountType ?? a?.type ?? '?',
        balance: a?.balance ?? null,
      }));
      result.hasBlueAccount = accs.blue !== null;
    } catch (e) {
      result.notes.push(`读不到 buzz 余额（${describeError(e)}）——不影响执行，但本轮无法核对真实到账。`);
    }

    // 3) 已关注列表 —— follow 的安全闸，读不到就不做该项
    let following = null;
    try {
      following = normalizeFollowing(await client.query('user.getFollowingUsers'));
    } catch (e) {
      result.notes.push(`读不到已关注列表（${describeError(e)}）——为避免误取关，本轮跳过「关注他人」。`);
    }

    // 4) 反应目标池 —— 只读公开接口，确认可做次数
    let pool = [];
    try {
      const list = await client.listImages({ limit: 100, sort: 'Most Reactions', period: 'Month' });
      const me = (result.username ?? '').toLowerCase();
      pool = (Array.isArray(list?.items) ? list.items : []).filter(
        (i) => i?.id && (!me || i.username?.toLowerCase() !== me),
      );
    } catch (e) {
      result.notes.push(`拉取图片池失败（${describeError(e)}）——本轮无法执行反应任务。`);
    }

    // 5) 站点侧今日真实收益 —— 用流水核对。
    //    这是整套逻辑的地基：本地计数只知道「本工具今天做没做」，而奖励额度是站点侧按 UTC 日
    //    结算的，用户手动点过的赞同样占用额度。只信本地计数就会超发 ——
    //    超发的那部分既拿不到 buzz，又对别人的内容留下了真实的点赞/关注痕迹。
    let siteRewards = null;
    try {
      const txs = await client.transactionsOfDay(day.day);
      const sum = summarizeRewards(txs);
      siteRewards = sum;
      result.siteRewards = {
        total: sum.total,
        byType: sum.byType,
        byTypeCount: sum.byTypeCount,
        txCount: txs.length,
        unknownCount: sum.unknown.length,
      };
    } catch (e) {
      result.notes.push(
        `读不到今日流水（${describeError(e)}）——将退化为按本地记录估算剩余额度，可能超发；建议检查 BuzzRead 权限。`,
      );
      result.siteRewards = null;
    }

    // 5.5) 官方任务定义 —— 采信官方返回的 awardAmount / cap，覆盖本地常量。
    //      理由：本地常量是抄的，官方调额后就会过时。调高时沿用旧值只是保守（少做）；
    //      调低时沿用旧值会**超发** —— 而超发是有副作用的（对别人的内容留下真实痕迹）。
    //      注意官方对 onDemand 项**不返回 interval**（那些 reward 用单值 cap 定义，
    //      intervalCap 取自 caps 数组，取不到即 undefined），所以周期仍以本地为准。
    let officialDefs = null;
    try {
      const rows = await client.query('user.userRewardDetails');
      if (Array.isArray(rows) && rows.length) {
        officialDefs = new Map(rows.map((r) => [r.type, r]));
        result.officialDefs = rows.map((r) => ({
          type: r.type,
          awardAmount: r.awardAmount,
          cap: r.cap ?? null,
          onDemand: !!r.onDemand,
        }));
      }
    } catch (e) {
      result.notes.push(
        `读不到官方任务定义（${describeError(e)}）——沿用本地常量；若官方已调低额度，可能超发。`,
      );
    }

    /** 取任务定义：以官方为准，官方没返回该项时回退本地常量。 */
    const defOf = (type) => {
      const local = TASK_BY_TYPE.get(type);
      const off = officialDefs?.get(type);
      if (!local || !off) return local;
      return {
        ...local,
        amount: off.awardAmount ?? local.amount,
        cap: off.cap ?? local.cap,
      };
    };

    // ── 逐项判定 ──
    const mk = (type, patch) => ({
      ...defOf(type),
      autoRunnable: AUTO_TYPES.includes(type),
      doable: false,
      plannedCount: 0,
      plannedEarn: 0,
      reason: '',
      ...patch,
    });

    /** 站点侧今日该任务已得金额；无流水时为 null（未知）。 */
    const siteEarn = (type) => (siteRewards ? (siteRewards.byType[type] ?? 0) : null);
    /** 站点侧今日该任务已发放笔数；无流水时退化为本地计数。 */
    const usedCount = (type) =>
      siteRewards ? (siteRewards.byTypeCount[type] ?? 0) : (day.counters[type] ?? 0);

    const tasks = [];

    // dailyBoost：站点流水说没领过才领
    {
      const amount = defOf('dailyBoost').amount;
      const claimed = siteEarn('dailyBoost') === null
        ? (day.counters.dailyBoost ?? 0) > 0
        : siteEarn('dailyBoost') > 0;
      tasks.push(
        mk('dailyBoost', {
          doable: !claimed,
          plannedCount: claimed ? 0 : 1,
          plannedEarn: claimed ? 0 : amount,
          reason: claimed
            ? '站点流水显示今日已领取（本地或站点侧已领过）'
            : siteRewards
              ? '站点流水显示今日未领取'
              : '今日未领取（读不到流水，按本地记录推断）',
        }),
      );
    }

    // firstDailyFollow：3 人/日，每次 10
    {
      const def = defOf('firstDailyFollow');
      const ceilingCount = Math.floor((def.cap ?? 30) / def.amount);
      const used = usedCount('firstDailyFollow');
      let need = Math.min(settings.followTarget, Math.max(0, ceilingCount - used));
      if (!following) need = 0;
      tasks.push(
        mk('firstDailyFollow', {
          doable: need > 0,
          plannedCount: need,
          plannedEarn: need * def.amount,
          reason: !following
            ? '已关注列表不可读，为免误取关已跳过'
            : used >= ceilingCount
              ? `今日关注额度已满（站点侧已得 ${used}/${ceilingCount} 次）`
              : `站点侧今日已得 ${used}/${ceilingCount} 次，计划新增 ${need} 人（已关注 ${following.size} 人）`,
        }),
      );
    }

    // encouragement：2/次，日上限 100 → 50 次
    {
      const def = defOf('encouragement');
      const ceilingCount = Math.floor((def.cap ?? 100) / def.amount);
      const used = usedCount('encouragement');
      const remainCount = Math.max(0, ceilingCount - used);
      const need = Math.min(settings.reactionTarget, remainCount, pool.length);
      tasks.push(
        mk('encouragement', {
          doable: need > 0,
          plannedCount: need,
          plannedEarn: need * def.amount,
          reason: remainCount === 0
            ? `今日反应额度已满（站点侧已得 ${used}/${ceilingCount} 次，含手动操作）`
            : pool.length === 0
              ? '没有可用的目标内容'
              : `站点侧今日已得 ${used}/${ceilingCount} 次，计划 ${need} 次（目标池 ${pool.length} 条）`,
        }),
      );
    }

    // 其余项：只做如实说明，不产生计划
    for (const t of [defOf('generation-feedback'), defOf('firstDailyPost'),
      defOf('remixAccept'), defOf('reportAccepted'),
      defOf('userReferred'), defOf('stickerPlacementAccepted'),
      defOf('collectedContent'), defOf('goodContent'),
      defOf('imagePostedToModel')]) {
      if (!t) continue;
      tasks.push({
        ...t,
        autoRunnable: false,
        doable: false,
        plannedCount: 0,
        plannedEarn: 0,
        reason: t.mode === 'passive' ? '由他人行为触发，无自触发入口'
          : t.mode === 'locked' ? '需产生真实内容，不自动化'
            : '需要前置条件或不在本工具执行范围内',
      });
    }

    // 按奖励额度排序，让收益高的排前面
    tasks.sort((a, b) => (b.plannedEarn ?? 0) - (a.plannedEarn ?? 0) || (b.amount ?? 0) - (a.amount ?? 0));

    result.tasks = tasks;
    result.doableCount = tasks.filter((t) => t.doable).length;
    result.plannedEarn = tasks.reduce((s, t) => s + t.plannedEarn, 0);
    result.ok = true;
    // 扫描实际触达的端点 —— 权限侦测的第一手证据
    result.apiCalls = summarizeCalls(client.calls);
    result.settings = {
      concurrency: settings.concurrency,
      reactionDelayMs: settings.reactionDelayMinMs,
      reactionTarget: settings.reactionTarget,
      followTarget: settings.followTarget,
    };

    this.#scans.set(accountId, result);
    this.#store.log(
      'info',
      `[${account.name}] 扫描完成：可做 ${result.doableCount} 项，预计 +${result.plannedEarn} buzz`,
      { accountId },
    );
    return result;
  }

  // ═══════════════════ 阶段二：执行 ═══════════════════

  /**
   * 按扫描计划执行。未传 plan 时内部先扫描一次（自动模式走这条路）。
   * @param {string} accountId
   * @param {{ plan?: object, types?: string[], emit?: Function }} opts
   */
  async run(accountId, { plan, types, emit = () => {} } = {}) {
    if (this.#running.has(accountId)) throw new Error('该账号已有任务在运行');
    const account = this.#store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');

    const scan = plan ?? this.lastScan(accountId) ?? (await this.scan(accountId));
    const allowed = types?.length ? new Set(types) : null;
    const todo = (scan.tasks ?? []).filter(
      (t) => t.autoRunnable && t.doable && (t.plannedCount ?? 0) > 0 && (!allowed || allowed.has(t.type)),
    );

    if (!todo.length) {
      const summary = {
        accountId,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        ok: true,
        aborted: false,
        earned: 0,
        buzzDelta: null,
        results: [],
        note: '扫描结果里没有可执行的任务',
      };
      this.#store.markRun(accountId, summary);
      emit({ kind: 'run-done', ...summary });
      return summary;
    }

    const ctl = new AbortController();
    this.#running.set(accountId, ctl);

    const settings = this.#store.settings;
    const client = new CivitaiClient({ apiKey: account.apiKey, host: account.host });
    const ctx = {
      client,
      account,
      settings,
      signal: ctl.signal,
      store: this.#store,
      accountId,
      emit,
      plan: scan,
      accountId2: accountId,
    };

    const startedAt = new Date().toISOString();
    const results = [];
    let earned = 0;
    let aborted = false;

    try {
      for (const item of todo) {
        if (ctl.signal.aborted) { aborted = true; break; }
        emit({ kind: 'task-start', type: item.type, label: item.label });
        let r;
        try {
          // 把扫描确定的那一项整份传进去：额度以扫描（官方校正后）的值为准，
          // 做到「面板显示什么就执行什么」，不在 runner 里再回退到本地常量。
          if (item.type === 'dailyBoost') r = await this.#dailyBoost(ctx, item);
          else if (item.type === 'encouragement') r = await this.#encouragement(ctx, item);
          else if (item.type === 'firstDailyFollow') r = await this.#firstDailyFollow(ctx, item);
          else r = { earned: 0, skipped: '未实现该任务的自动化' };
        } catch (e) {
          if (e?.isAuth) {
            r = { earned: 0, error: `认证失败：${describeError(e)}` };
            results.push({ ...r, type: item.type });
            emit({ kind: 'task-error', type: item.type, message: r.error });
            this.#store.log('error', `[${account.name}] ${r.error}`, { accountId, type: item.type });
            aborted = true;
            break;
          }
          r = { earned: 0, error: describeError(e) };
        }
        r.type = item.type;
        earned += r.earned ?? 0;
        results.push(r);
        emit({ kind: 'task-done', ...r });
        this.#store.log(
          r.error ? 'error' : r.skipped ? 'info' : 'ok',
          `[${account.name}] ${item.label}：${r.error ?? r.skipped ?? `+${r.earned} buzz`}`,
          { accountId, type: item.type, ...r },
        );
      }
    } catch (e) {
      // 兜底：单点异常不该让整轮结果丢失
      aborted = true;
      results.push({ type: 'internal', earned: 0, error: String(e?.message ?? e) });
      this.#store.log('error', `[${account.name}] 执行中断：${String(e?.message ?? e)}`, { accountId });
    }

    // ── 收尾：核对真实到账 → 落盘结果 → 最后才摘 running 标志 ──
    // 顺序是刻意的：先摘标志的话，面板会有一瞬间「已结束但没有结果」。

    // 权威口径：站点流水里今日奖励入账的合计差额。
    // 不用余额差，是因为 buzz.getUserAccount 读不到 blue 钱包（Blue Buzz 全进 blue 账户），
    // 且余额会被用户自己的消费直接污染。
    let rewardDelta = null;
    let rewardAfter = null;
    try {
      const sum = summarizeRewards(await client.transactionsOfDay(scan.utcDay));
      rewardAfter = sum.total;
      if (typeof scan.siteRewards?.total === 'number') {
        rewardDelta = sum.total - scan.siteRewards.total;
      }
    } catch { /* 读不到就留 null，不编造 */ }

    // 辅助口径：blue 钱包余额（读不到是常态，仅作参考）
    let afterBuzz = null;
    try {
      afterBuzz = extractBuzzAccounts(await client.getBuzzAccount()).blue ?? 0;
    } catch { /* ignore */ }

    const summary = {
      accountId,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: !aborted && results.every((r) => !r.error),
      aborted,
      earned,                    // 按任务定义推算的理论值
      rewardDelta,               // 站点流水实测差额（真实到账，权威）
      rewardBefore: scan.siteRewards?.total ?? null,
      rewardAfter,
      balanceAfterBlue: afterBuzz,
      apiCalls: summarizeCalls(client.calls),
      results,
    };
    this.#store.markRun(accountId, summary);
    this.#running.delete(accountId);
    emit({ kind: 'run-done', ...summary });
    return summary;
  }

  // ═══════════════════ 多账号批量 ═══════════════════

  /**
   * 批量处理多个账号。并发数取 settings.concurrency，默认 1 —— 即**严格串行**
   * （一个账号做完才做下一个）。调大只影响账号之间的重叠度；账号内部永远串行。
   * 每个账号进入执行前都会先保证有一份可用的扫描结果。
   */
  async runMany(accountIds, { emit = () => {} } = {}) {
    const settings = this.#store.settings;
    const list = [...accountIds];
    if (!list.length) return { kind: 'batch-done', total: 0, outcomes: [] };

    const limit = Math.max(1, Math.min(Number(settings.concurrency) || 1, list.length));
    const queue = [...list];
    const outcomes = [];
    emit({ kind: 'batch-start', total: list.length, concurrency: limit });
    this.#store.log('info', `批量开始：${list.length} 个账号，并发 ${limit}${limit === 1 ? '（串行）' : ''}`);

    const worker = async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) break;
        const acc = this.#store.getAccount(id);
        try {
          let plan = this.lastScan(id);
          if (!plan || plan.authError) plan = await this.scan(id);
          if (plan.authError) {
            outcomes.push({ accountId: id, error: plan.authError });
            emit({ kind: 'batch-item', accountId: id, name: acc?.name, error: plan.authError });
          } else {
            const r = await this.run(id, { plan, emit });
            outcomes.push(r);
            emit({
              kind: 'batch-item',
              accountId: id,
              name: acc?.name,
              earned: r.earned,
              rewardDelta: r.rewardDelta,
              doableCount: plan.doableCount,
            });
          }
        } catch (e) {
          const msg = String(e?.message ?? e);
          outcomes.push({ accountId: id, error: msg });
          emit({ kind: 'batch-item', accountId: id, name: acc?.name, error: msg });
        }
        // 账号之间的间隔：降低多账号同一时刻打点被关联的概率
        if (queue.length) await sleep(Math.max(0, Number(settings.accountGapMs) || 0));
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
    const done = { kind: 'batch-done', total: list.length, outcomes };
    this.#store.log('info', `批量结束：处理 ${outcomes.length} 个账号`);
    emit(done);
    return done;
  }

  // ═══════════════════ 各任务实现 ═══════════════════

  /** dailyBoost：一条调用拿满当日额度。 */
  async #dailyBoost(ctx, item) {
    const { client, store, accountId, emit } = ctx;
    emit({ kind: 'step', type: 'dailyBoost', message: '调用 buzz.claimDailyBoostReward' });
    try {
      await client.claimDailyBoostReward();
    } catch (e) {
      if (e?.isAuth) throw e;
      if (BENIGN.test(String(e?.message ?? ''))) {
        return { earned: 0, skipped: `站点侧不可领取：${describeError(e)}` };
      }
      return { earned: 0, error: describeError(e) };
    }
    const earned = item?.amount ?? 25;
    store.bump(accountId, 'dailyBoost', { count: 1, earned });
    emit({ kind: 'step', type: 'dailyBoost', message: `领取成功 +${earned}` });
    return { earned };
  }

  /** encouragement：对他人图片逐个给反应，每次 2 buzz。 */
  async #encouragement(ctx, item) {
    const { client, store, accountId, settings, signal, account, emit } = ctx;
    const def = { amount: item?.amount ?? 2 };
    const need = item?.plannedCount ?? 0;
    if (need <= 0) return { earned: 0, skipped: '无计划次数' };

    emit({ kind: 'step', type: 'encouragement', message: `拉取目标图片（需要 ${need} 张）` });
    const list = await client.listImages({ limit: Math.min(100, need * 2), sort: 'Most Reactions', period: 'Month' });
    const items = Array.isArray(list?.items) ? list.items : [];
    const me = account.profile?.username?.toLowerCase();
    const pool = items.filter((i) => i?.id && (!me || i.username?.toLowerCase() !== me));
    if (!pool.length) return { earned: 0, error: '图片池为空，无法取得反应目标' };

    let earned = 0;
    let count = 0;
    const errors = [];
    for (const img of pool) {
      if (signal.aborted) break;
      if (count >= need) break;
      try {
        await client.toggleReaction({ entityId: img.id, entityType: 'image', reaction: 'Like' });
        count += 1;
        earned += def.amount ?? 2;
        store.bump(accountId, 'encouragement', { count: 1, earned: def.amount ?? 2 });
        emit({
          kind: 'step',
          type: 'encouragement',
          message: `反应 image#${img.id}（${count}/${need}）`,
          progress: { count, need },
        });
      } catch (e) {
        if (e?.isAuth) throw e;
        errors.push(`image#${img.id}: ${describeError(e)}`);
        if (e?.isRateLimit) {
          emit({ kind: 'step', type: 'encouragement', message: '命中站点限速，退避 30 秒' });
          await sleep(30000);
        }
      }
      if (count < need) {
        await sleep(randInt(settings.reactionDelayMinMs, settings.reactionDelayMaxMs));
      }
    }
    return {
      earned,
      detail: { reacted: count, target: need },
      ...(errors.length ? { warnings: errors.slice(0, 5) } : {}),
    };
  }

  /** firstDailyFollow：关注 3 个新的人，每次 10 buzz。 */
  async #firstDailyFollow(ctx, item) {
    const { client, store, accountId, settings, signal, account, emit } = ctx;
    const def = { amount: item?.amount ?? 10 };
    const need = item?.plannedCount ?? 0;
    if (need <= 0) return { earned: 0, skipped: '无计划次数' };

    // 安全闸：follow 是 toggle，拿不到已关注列表就不动。
    let following;
    try {
      following = normalizeFollowing(await client.query('user.getFollowingUsers'));
    } catch (e) {
      if (e?.isAuth) throw e;
      following = null;
    }
    if (!following) {
      return { earned: 0, skipped: '无法读取已关注列表，已跳过以避免误取关' };
    }
    emit({ kind: 'step', type: 'firstDailyFollow', message: `已关注 ${following.size} 人，需新增 ${need} 人` });

    const list = await client.listImages({ limit: 60, sort: 'Most Reactions', period: 'Week' });
    const items = Array.isArray(list?.items) ? list.items : [];
    const me = account.profile?.username?.toLowerCase();
    const candidates = [...new Set(items.map((i) => i?.username).filter(Boolean))].filter(
      (u) => u.toLowerCase() !== me && !following.has(u.toLowerCase()),
    );
    if (!candidates.length) return { earned: 0, skipped: '没有可关注的新用户' };

    let earned = 0;
    let count = 0;
    const errors = [];
    for (const username of candidates) {
      if (signal.aborted) break;
      if (count >= need) break;
      try {
        const creator = await client.query('user.getCreator', { username });
        const targetUserId = creator?.id;
        if (!targetUserId) { errors.push(`${username}: 解析不到 userId`); continue; }
        await client.toggleFollow({ targetUserId, username });
        count += 1;
        earned += def.amount ?? 10;
        store.bump(accountId, 'firstDailyFollow', { count: 1, earned: def.amount ?? 10 });
        emit({
          kind: 'step',
          type: 'firstDailyFollow',
          message: `已关注 ${username}（${count}/${need}）`,
          progress: { count, need },
        });
      } catch (e) {
        if (e?.isAuth) throw e;
        errors.push(`${username}: ${describeError(e)}`);
      }
      if (count < need) {
        await sleep(randInt(settings.followDelayMinMs, settings.followDelayMaxMs));
      }
    }
    return {
      earned,
      detail: { followed: count, target: need },
      ...(errors.length ? { warnings: errors.slice(0, 5) } : {}),
    };
  }
}
