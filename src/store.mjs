/**
 * 持久化层：账号凭据、设置、每日执行状态、运行日志。
 *
 * 全部落盘在 `data/` 下，进程重启不丢：
 *   data/config.json   账号与设置（含 API key，文件权限收紧到 600）
 *   data/state.json    每个账号的当日计数与收益
 *   data/run.log       追加式运行日志
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** civitai 的每日上限按 UTC 结算，day key 也按 UTC 取。 */
export function utcDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** 距下一个 UTC 零点的毫秒数。 */
export function msToUtcReset(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  );
  return next - now.getTime();
}

const DEFAULT_CONFIG = {
  version: 1,
  settings: {
    /** 自动模式：每天到点自动跑一轮（仍遵守「先扫描、有可做项才执行」）。 */
    autoRun: false,
    /** 自动模式的触发时刻（本地时间 HH:MM）。 */
    runAt: '09:30',
    /**
     * 同时处理的账号数。1 = 严格串行（一个账号做完才做下一个），即默认。
     * 调大只在多账号时才有意义；单个账号内部的操作始终串行。
     */
    concurrency: 1,
    /**
     * reaction 之间的间隔（毫秒）。默认 1000。
     * 注意 civitai 的 reactionRateLimits 第一档就是 60/分钟 —— 1 秒 1 次正好压在该上限上，
     * 命中 429 时引擎会自动退避 30 秒再续。
     */
    reactionDelayMinMs: 1000,
    reactionDelayMaxMs: 1000,
    /** follow 之间的间隔（毫秒）。站点未给 follow 独立限速，取得比 reaction 保守。 */
    followDelayMinMs: 1500,
    followDelayMaxMs: 2500,
    /** 单轮 reaction 目标次数（每次 2 buzz，50 次 = 100 满额）。 */
    reactionTarget: 50,
    /** 单轮 follow 目标次数（每次 10 buzz，3 次 = 30 满额）。 */
    followTarget: 3,
    /** 相邻账号之间的间隔（毫秒），避免多账号同时打点被关联。 */
    accountGapMs: 3000,
  },
  accounts: [],
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

export class Store {
  #dir;
  #configPath;
  #statePath;
  #logPath;
  #config;
  #state;
  #logs = [];
  #logCap = 500;

  constructor(dir) {
    this.#dir = dir;
    this.#configPath = join(dir, 'config.json');
    this.#statePath = join(dir, 'state.json');
    this.#logPath = join(dir, 'run.log');
    mkdirSync(dir, { recursive: true });
    const firstRun = !existsSync(this.#configPath);
    this.#config = this.#readJson(this.#configPath, DEFAULT_CONFIG);
    this.#config = deepMerge(DEFAULT_CONFIG, this.#config);
    this.#state = this.#readJson(this.#statePath, { accounts: {} });
    if (!this.#state.accounts) this.#state.accounts = {};
    // 首次运行就把默认配置落盘：否则用户拉开 data/ 只看到 run.log，
    // 找不到「配置在哪、key 存哪」——而这正是最需要他看得见的文件。
    if (firstRun) this.#writeJson(this.#configPath, this.#config);
  }

  #readJson(path, fallback) {
    try {
      if (!existsSync(path)) return structuredClone(fallback);
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return structuredClone(fallback);
    }
  }

  #writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
    // 配置含密钥，收权限（Windows 上为尽力而为）。
    try { chmodSync(path, 0o600); } catch { /* Windows 上无实际作用，忽略 */ }
  }

  // ───────────── 配置 ─────────────

  get settings() {
    return this.#config.settings;
  }

  patchSettings(patch) {
    this.#config.settings = deepMerge(this.#config.settings, patch);
    this.#writeJson(this.#configPath, this.#config);
    return this.#config.settings;
  }

  /** 账号列表；API key 默认脱敏，只有 `reveal: true` 才回明文。 */
  listAccounts({ reveal = false } = {}) {
    return this.#config.accounts.map((a) => {
      const { apiKey, ...rest } = a;
      return {
        ...rest,
        keyMask: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
        ...(reveal ? { apiKey } : {}),
      };
    });
  }

  getAccount(id) {
    return this.#config.accounts.find((a) => a.id === id) ?? null;
  }

  addAccount({ name, host = 'com', apiKey }) {
    if (!apiKey || typeof apiKey !== 'string') throw new Error('API key 必填');
    const account = {
      id: randomUUID(),
      name: name?.trim() || `账号 ${this.#config.accounts.length + 1}`,
      host: host === 'red' ? 'red' : 'com',
      apiKey: apiKey.trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
      profile: null,
    };
    this.#config.accounts.push(account);
    this.#writeJson(this.#configPath, this.#config);
    const { apiKey: _k, ...safe } = account;
    return { ...safe, keyMask: `${account.apiKey.slice(0, 4)}...${account.apiKey.slice(-4)}` };
  }

  updateAccount(id, patch) {
    const acc = this.getAccount(id);
    if (!acc) throw new Error('账号不存在');
    for (const k of ['name', 'host', 'enabled', 'profile']) {
      if (k in patch) acc[k] = patch[k];
    }
    if (patch.apiKey) acc.apiKey = String(patch.apiKey).trim();
    this.#writeJson(this.#configPath, this.#config);
    const { apiKey: _k, ...safe } = acc;
    return safe;
  }

  removeAccount(id) {
    const before = this.#config.accounts.length;
    this.#config.accounts = this.#config.accounts.filter((a) => a.id !== id);
    delete this.#state.accounts[id];
    this.#writeJson(this.#configPath, this.#config);
    this.#writeJson(this.#statePath, this.#state);
    return this.#config.accounts.length < before;
  }

  // ───────────── 每日状态 ─────────────

  /** 取某账号当天的状态；跨 UTC 日自动归零。 */
  dayState(accountId) {
    const day = utcDayKey();
    let s = this.#state.accounts[accountId];
    if (!s || s.day !== day) {
      s = {
        day,
        counters: {},
        earned: 0,            // 本工具按任务定义累加的「我做了多少」（理论值）
        siteEarned: null,     // 站点流水实测的「站点给了多少」（权威值），未扫描过则为 null
        siteEarnedByType: {},
        lastRunAt: null,
        lastResult: null,
      };
      this.#state.accounts[accountId] = s;
      this.#writeJson(this.#statePath, this.#state);
    }
    return s;
  }

  bump(accountId, type, { count = 1, earned = 0 } = {}) {
    const s = this.dayState(accountId);
    s.counters[type] = (s.counters[type] ?? 0) + count;
    s.earned = (s.earned ?? 0) + earned;
    this.#writeJson(this.#statePath, this.#state);
    return s;
  }

  /**
   * 记下「站点侧今日已得」——来自交易流水，是权威口径。
   *
   * 为什么要单独存：`earned` 是本工具按任务定义累加的「我做了多少」，
   * 不等于「站点给了多少」。撞上站点去重、日上限、或用户手动操作时，
   * 两者会明显分叉（实测出现过理论 155 / 实到 83）。
   * 面板顶栏必须显示站点真值，否则就是在虚报。
   */
  setSiteEarned(accountId, total, byType, day) {
    const s = this.dayState(accountId);
    s.siteEarned = total;
    s.siteEarnedByType = byType ?? {};
    s.siteEarnedDay = day ?? s.day;
    s.siteEarnedAt = new Date().toISOString();
    this.#writeJson(this.#statePath, this.#state);
    return s;
  }

  markRun(accountId, result) {
    const s = this.dayState(accountId);
    s.lastRunAt = new Date().toISOString();
    s.lastResult = result;
    this.#writeJson(this.#statePath, this.#state);
    return s;
  }

  resetDay(accountId) {
    delete this.#state.accounts[accountId];
    this.#writeJson(this.#statePath, this.#state);
  }

  // ───────────── 日志 ─────────────

  log(level, message, meta) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {}),
    };
    this.#logs.push(entry);
    if (this.#logs.length > this.#logCap) this.#logs.splice(0, this.#logs.length - this.#logCap);
    try {
      appendFileSync(this.#logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* 日志写失败不影响主流程 */ }
    return entry;
  }

  recentLogs(limit = 200) {
    return this.#logs.slice(-limit);
  }
}
