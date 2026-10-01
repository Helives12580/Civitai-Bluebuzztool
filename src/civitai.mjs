/**
 * civitai API 客户端（tRPC + REST）。
 *
 * 认证：`Authorization: Bearer <apiKey>`
 * 端点、入参 schema、所需 TokenScope 全部取自 civitai 主仓源码：
 *   - src/server/routers/buzz.router.ts      -> buzz.*
 *   - src/server/routers/reaction.router.ts  -> reaction.toggle
 *   - src/server/routers/user.router.ts      -> user.toggleFollow
 *   - src/pages/api/v1/me.ts                 -> GET /api/v1/me
 *
 * 实测确认（2026-09，civitai.com）：以上 tRPC 过程在未认证时返回 401 UNAUTHORIZED，
 * 而非 404 —— 端点全部存在。
 */

/** 支持的站点。civitai.red 与 civitai.com 返回同一份内容（镜像）。 */
export const HOSTS = {
  com: 'https://civitai.com',
  red: 'https://civitai.red',
};

/** TokenScope 位（摘自 @civitai/auth 的 token-scope 常量语义）。 */
export const SCOPE_HINT = {
  Full: '完整权限',
  BuzzRead: 'Buzz 读取',
  SocialWrite: '社交写入（reaction / 关注）',
  UserRead: '用户资料读取',
  MediaRead: '媒体读取',
};

export class CivitaiError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'CivitaiError';
    this.status = meta.status ?? 0;
    this.code = meta.code ?? null;
    this.path = meta.path ?? null;
    this.body = meta.body ?? null;
  }
  /** 认证失败（key 无效 / 权限不足）。 */
  get isAuth() {
    return this.status === 401 || this.status === 403 || this.code === -32001;
  }
  /** 命中限速（civitai 的 tRPC rateLimit 中间件）。 */
  get isRateLimit() {
    return this.status === 429;
  }
}

export class CivitaiClient {
  #apiKey;
  #base;
  #timeoutMs;
  #fetch;
  #onCall;
  /** 本次客户端实例产生的全部请求留痕（权限侦测的证据来源）。 */
  calls = [];

  constructor({ apiKey, host = 'com', timeoutMs = 30000, fetchImpl, onCall } = {}) {
    if (!apiKey) throw new CivitaiError('缺少 API key');
    this.#apiKey = apiKey;
    this.#base = HOSTS[host] ?? host ?? HOSTS.com;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#onCall = onCall ?? null;
  }

  get base() {
    return this.#base;
  }

  /** 单次请求；超时用 AbortSignal.timeout，不挂全局定时器。 */
  async #request(url, init) {
    const method = init?.method ?? 'GET';
    const path = String(url).replace(this.#base, '');
    const startedAt = Date.now();
    let status = 0;
    try {
      const res = await this.#fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'civitai-buzz-tool/1.0',
          ...(init?.headers ?? {}),
        },
      });
      status = res.status;

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (!res.ok) {
        const err = body?.error?.json ?? body ?? {};
        throw new CivitaiError(
          err.message ?? `HTTP ${res.status}`,
          { status: res.status, code: err.code ?? null, path: err.data?.path ?? null, body },
        );
      }
      return body;
    } catch (e) {
      if (!status) status = e instanceof CivitaiError ? e.status : -1;
      throw e;
    } finally {
      // 只留「端点 + 方法 + 状态 + 耗时」，不含请求体与认证头
      const rec = { method, path, status, ms: Date.now() - startedAt, at: new Date().toISOString() };
      this.calls.push(rec);
      this.#onCall?.(rec);
    }
  }

  /** 解开 tRPC 的 { result: { data: { json } } } 信封。 */
  #unwrap(body) {
    if (body && typeof body === 'object' && 'error' in body) {
      const err = body.error?.json ?? {};
      throw new CivitaiError(err.message ?? 'tRPC error', {
        status: err.data?.httpStatus ?? 0,
        code: err.code ?? null,
        path: err.data?.path ?? null,
        body,
      });
    }
    // 批量模式下是数组；此处统一取第一项。
    const one = Array.isArray(body) ? body[0] : body;
    if (one && typeof one === 'object' && 'error' in one) {
      const err = one.error?.json ?? {};
      throw new CivitaiError(err.message ?? 'tRPC error', {
        status: err.data?.httpStatus ?? 0,
        code: err.code ?? null,
        path: err.data?.path ?? null,
        body: one,
      });
    }
    return one?.result?.data?.json ?? null;
  }

  /** tRPC query（GET）。 */
  async query(path, input = {}) {
    const qs = new URLSearchParams({ input: JSON.stringify({ json: input ?? {} }) });
    const body = await this.#request(`${this.#base}/api/trpc/${path}?${qs}`, {
      method: 'GET',
    });
    return this.#unwrap(body);
  }

  /** tRPC mutation（POST）。无 input 的过程传 null。 */
  async mutate(path, input = null) {
    const body = await this.#request(`${this.#base}/api/trpc/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: input }),
    });
    return this.#unwrap(body);
  }

  /**
   * tRPC query，**入参含 z.date() 时使用**。
   *
   * civitai 走 superjson transformer，Date 必须在 `meta.values` 里标注类型，
   * zod 才能把它还原成 Date 实例。实测：不带 meta 直接传 ISO 字符串会被拒，
   * 报 `expected date, received string`（buzz.getUserTransactions 即如此）。
   */
  async queryWithDates(path, input, dateKeys = []) {
    const meta = { values: {} };
    for (const k of dateKeys) meta.values[k] = ['Date'];
    const qs = new URLSearchParams({ input: JSON.stringify({ json: input, meta }) });
    const body = await this.#request(`${this.#base}/api/trpc/${path}?${qs}`, { method: 'GET' });
    return this.#unwrap(body);
  }

  /**
   * 某个 UTC 日内的 buzz 流水。
   * 这是唯一可靠的「站点侧真实收益」来源 —— 余额读不到 blue 钱包（见 README 的坑记），
   * 而流水直接给出每一笔奖励的类型与金额。
   */
  async transactionsOfDay(utcDay) {
    return this.transactionsOfRange(`${utcDay}T00:00:00.000Z`, `${utcDay}T23:59:59.999Z`);
  }

  /**
   * 任意区间的 buzz 流水（单次上限 200 条）。
   * 回溯历史用 —— 站点的奖励去重是**永久**的，所以要能查更早的记录。
   */
  async transactionsOfRange(startIso, endIso, limit = 200) {
    const res = await this.queryWithDates(
      'buzz.getUserTransactions',
      { start: startIso, end: endIso, limit },
      ['start', 'end'],
    );
    return Array.isArray(res?.transactions) ? res.transactions : [];
  }

  /** 最近 N 天的流水。 */
  async recentTransactions(days = 30) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    return this.transactionsOfRange(start.toISOString(), end.toISOString());
  }

  // ───────────────────────── 账号 ─────────────────────────

  /**
   * GET /api/v1/me —— 验证 key 并取账号信息。
   * 返回 { id, username, tier, status, isMember, subscriptions, tokenScope, buzzLimit, subject... }
   */
  async me() {
    return this.#request(`${this.#base}/api/v1/me`, { method: 'GET' });
  }

  /** buzz 账户与余额（需要 BuzzRead scope）。 */
  async getBuzzAccount() {
    return this.query('buzz.getUserAccount');
  }

  // ───────────────────────── 任务动作 ─────────────────────────

  /**
   * 每日 boost 领取 —— 对应 reward `dailyBoost`（25/日）。
   * 源码：buzz.router.ts `claimDailyBoostReward`，无输入，需 BuzzRead。
   */
  async claimDailyBoostReward() {
    return this.mutate('buzz.claimDailyBoostReward', null);
  }

  /**
   * 反应 —— 对应 reward `encouragement`（2/次，100/日）。
   * entityType ∈ question|answer|comment|commentOld|image|post|resourceReview|article|bountyEntry
   * reaction   ∈ Like|Dislike|Laugh|Cry|Heart
   * 需 SocialWrite。注意：对自己拥有的内容不奖励（ownerId === reactorId -> false）。
   */
  async toggleReaction({ entityId, entityType, reaction }) {
    return this.mutate('reaction.toggle', { entityId, entityType, reaction });
  }

  /**
   * 关注 —— 对应 reward `firstDailyFollow`（10/次，30/日）。
   * 源码：user.router.ts `toggleFollow`（verifiedProcedure，无 requiredScope
   * -> 隐含要求 TokenScope.Full）。重复关注同一人不再奖励。
   */
  async toggleFollow({ targetUserId, username }) {
    const input = { targetUserId };
    if (username) input.username = username;
    return this.mutate('user.toggleFollow', input);
  }

  /** 领取状态查询（部分奖励类型）。 */
  async getClaimStatus(id) {
    return this.query('buzz.getClaimStatus', { id });
  }

  // ───────────────────── 数据源（公开接口） ─────────────────────

  /**
   * 简单退避重试。只对 5xx 与网络抖动重试；4xx 是请求本身的问题，重试没有意义。
   */
  async #retry(fn, attempts = 3, baseDelayMs = 1500) {
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const status = e?.status ?? 0;
        if (status >= 400 && status < 500) throw e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
      }
    }
    throw lastErr;
  }

  /**
   * 热门图片，作为 reaction 的目标池。
   *
   * 带退避重试，因为这个接口会**高频**返回 503：
   *   {"error":"Image search is temporarily overloaded — please retry."}
   * 实测连续 6 次里有 3 次 503（约 50%），且同一请求紧接着重试通常就 200 ——
   * 站点侧过载限流，不是请求本身的问题（它自己的文案就在说 please retry）。
   *
   * 重试次数不能小气：按 50% 失败率算，重试 4 次仍有 ~6% 概率全军覆没，
   * 那一轮的反应任务（当天 100 buzz 的主力项）就白白丢了。这里给 6 次 +
   * 递增退避，全失败概率降到 ~1.6%，且失败时能明确报出是站点过载。
   */
  async listImages({ limit = 100, sort = 'Most Reactions', period = 'Month' } = {}) {
    const qs = new URLSearchParams({
      limit: String(limit),
      sort,
      period,
      nsfw: 'false',
    });
    const url = `${this.#base}/api/v1/images?${qs}`;
    return this.#retry(() => this.#request(url, { method: 'GET' }), 6, 2000);
  }

  /** 通过用户名取用户 id（follow 的目标解析）。 */
  async getCreatorIdByUsername(username) {
    const res = await this.query('user.getCreator', { username });
    return res?.id ?? null;
  }
}

/**
 * 从 buzz.getUserAccount 的返回里按账户类型取出余额。
 *
 * 站点返回的是「账户数组」，形如
 *   [{ id, balance, lifetimeBalance, accountType: 'yellow' }, ...]
 * 关键：Blue Buzz 任务的奖励入的是 **blue** 账户（reward 定义里 `toAccountType: 'blue'`），
 * 与 yellow 账户是两个独立钱包。因此核对到账必须盯 blue，而不是"数组第一项"。
 * blue 账户是首次获得 blue buzz 时才创建的，所以它的缺席是正常状态，代表余额 0。
 *
 * @returns {{blue: number|null, yellow: number|null, accounts: Array}} 取不到的项为 null（未知，不猜）
 */
export function extractBuzzAccounts(res) {
  const arr = Array.isArray(res)
    ? res
    : (res?.accounts ?? res?.items ?? (res && typeof res === 'object' ? [res] : []));
  const out = { blue: null, yellow: null, accounts: Array.isArray(arr) ? arr : [] };
  if (!Array.isArray(arr)) return out;
  for (const a of arr) {
    const type = a?.accountType ?? a?.type ?? null;
    const v = a?.balance ?? a?.amount ?? a?.buzz ?? null;
    const n = typeof v === 'number' ? v : v == null ? null : Number(v);
    if (!Number.isFinite(n)) continue;
    if (type === 'blue') out.blue = n;
    else if (type === 'yellow') out.yellow = n;
  }
  return out;
}

/** 向后兼容：只取 blue 余额（无 blue 账户时返回 null）。 */
export function extractBuzzBalance(res) {
  return extractBuzzAccounts(res).blue;
}

/** 把任意异常收成可读字符串。 */
export function describeError(e) {
  if (e instanceof CivitaiError) {
    const bits = [e.message];
    // 站点在消息里已经带了状态码时不再重复（tRPC 的 message 常就是 "HTTP 401"）。
    if (e.status && !/HTTP\s*\d{3}/i.test(e.message)) bits.push(`HTTP ${e.status}`);
    if (e.code) bits.push(`code ${e.code}`);
    if (e.path) bits.push(e.path);
    // 这条文案出现在 key 未通过认证时，很容易被误读成"端点不可用"。
    // 源码依据：createContext.ts 里 `acceptableOrigin = !isProd || isBearerAuth || isAllowedOriginRequest(req)`，
    // 携带有效 API key 的 Bearer 请求直接放行；只有 key 无效（apiKeyId 为 null）才会落到来源校验分支。
    if (/public API instead/i.test(e.message)) {
      bits.push('【该提示=key 未通过认证，并非端点不可用；请检查 key 是否有效、是否已启用】');
    }
    return bits.join(' | ');
  }
  return String(e?.message ?? e);
}
