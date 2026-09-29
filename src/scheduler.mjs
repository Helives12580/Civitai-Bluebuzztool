/**
 * 每日调度器。
 *
 * 只在 `settings.autoRun` 打开时排程；到达本地时间 `settings.runAt` 后，
 * 对每个启用中的账号依次跑一轮。用单次 setTimeout 链式重排，不累积定时器。
 */

export class Scheduler {
  #store;
  #engine;
  #timer = null;
  #nextAt = null;
  #onEvent;

  constructor({ store, engine, onEvent = () => {} }) {
    this.#store = store;
    this.#engine = engine;
    this.#onEvent = onEvent;
  }

  get nextRunAt() {
    return this.#nextAt ? this.#nextAt.toISOString() : null;
  }

  /** 设置变更后重排。 */
  reschedule() {
    this.stop();
    this.start();
  }

  start() {
    const s = this.#store.settings;
    if (!s.autoRun) {
      this.#nextAt = null;
      return;
    }
    const [h, m] = String(s.runAt || '09:30').split(':').map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(h) || !Number.isFinite(m)) {
      this.#store.log('error', `自动模式时刻格式非法：${s.runAt}，已停用排程`);
      this.#nextAt = null;
      return;
    }
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    this.#nextAt = next;
    const delay = next.getTime() - now.getTime();
    this.#timer = setTimeout(() => {
      void this.#fire();
    }, delay);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
    this.#store.log('info', `自动模式已排程：${next.toLocaleString()}（约 ${Math.round(delay / 60000)} 分钟后）`);
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #fire() {
    this.#timer = null;
    const accounts = this.#store.listAccounts().filter((a) => a.enabled);
    this.#onEvent({ kind: 'schedule-fire', accounts: accounts.length });
    this.#store.log('info', `自动模式触发，开始处理 ${accounts.length} 个账号`);
    try {
      // 走同一个批量入口：先扫描、有可做项才执行，并发数由 settings.concurrency 决定（默认串行）
      await this.#engine.runMany(accounts.map((a) => a.id), { emit: this.#onEvent });
    } catch (e) {
      this.#store.log('error', `自动运行失败：${String(e?.message ?? e)}`);
    }
    this.start(); // 排下一天
  }
}
