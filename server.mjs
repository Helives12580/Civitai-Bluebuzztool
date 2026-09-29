/**
 * civitai Blue Buzz 每日任务助手 —— HTTP 服务。
 *
 * 形态对齐 workbuddy2api 的 panel：单进程、本机端口、内嵌面板、JSON API。
 * 只监听 127.0.0.1，不对外暴露；密钥仅存本机 data/config.json。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

import { Store, utcDayKey, msToUtcReset } from './src/store.mjs';
import { BuzzEngine } from './src/engine.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { TASKS, AUTO_TYPES, TASK_BY_TYPE } from './src/tasks.mjs';
import { CivitaiClient, describeError, HOSTS } from './src/civitai.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');
const PORT = Number(process.env.CIVITAI_BUZZ_PORT || 7864);
const HOST = '127.0.0.1';

const store = new Store(DATA_DIR);

// ───────────────── SSE 事件总线 ─────────────────

const sseClients = new Set();

function broadcast(evt) {
  const payload = `data: ${JSON.stringify({ ...evt, ts: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

const engine = new BuzzEngine({ store });
const scheduler = new Scheduler({ store, engine, onEvent: broadcast });

// ───────────────── 工具 ─────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

/** 取该账号的当日快照（含任务清单与完成度）。 */
function daySnapshot(accountId) {
  const day = store.dayState(accountId);
  const tasks = TASKS.map((t) => {
    const count = day.counters[t.type] ?? 0;
    const earned = t.capInterval === 'day' ? count * t.amount : count * t.amount;
    const done = t.cap && t.capInterval === 'day' ? earned >= t.cap : false;
    return {
      ...t,
      count,
      earned,
      done,
      autoRunnable: AUTO_TYPES.includes(t.type),
    };
  });
  const byType = Object.fromEntries(tasks.map((t) => [t.type, t]));
  return {
    day: day.day,
    earned: day.earned ?? 0,
    lastRunAt: day.lastRunAt ?? null,
    lastResult: day.lastResult ?? null,
    utcResetInMs: msToUtcReset(),
    tasks,
    autoCeiling: AUTO_TYPES.reduce((s, t) => s + (byType[t]?.cap ?? 0), 0),
  };
}

function fullState() {
  const accounts = store.listAccounts().map((a) => ({
    ...a,
    day: daySnapshot(a.id),
    running: engine.isRunning(a.id),
    // 扫描结果随状态下发，面板刷新后不丢
    scan: engine.lastScan(a.id),
  }));
  return {
    accounts,
    // 任务定义随状态一起下发：无账号时面板仍要展示完整能力清单。
    taskDefs: TASKS,
    settings: store.settings,
    hosts: Object.keys(HOSTS),
    autoTypes: AUTO_TYPES,
    runningIds: engine.runningIds(),
    scheduler: { nextRunAt: scheduler.nextRunAt },
    utcResetInMs: msToUtcReset(),
    utcNow: new Date().toISOString(),
  };
}

// ───────────────── 路由 ─────────────────

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method ?? 'GET';

  // GET /api/state
  if (method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, fullState());
  }

  // GET /api/logs
  if (method === 'GET' && url.pathname === '/api/logs') {
    const limit = Number(url.searchParams.get('limit') || 200);
    return sendJson(res, 200, { logs: store.recentLogs(limit) });
  }

  // GET /api/events （SSE）
  if (method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ kind: 'hello', ts: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 断线由 close 处理 */ }
    }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return undefined;
  }

  // PATCH /api/settings
  if (method === 'PATCH' && url.pathname === '/api/settings') {
    const patch = await readBody(req);
    const settings = store.patchSettings(patch);
    scheduler.reschedule();
    broadcast({ kind: 'settings', settings });
    return sendJson(res, 200, { settings, scheduler: { nextRunAt: scheduler.nextRunAt } });
  }

  // /api/accounts ...
  if (seg[0] === 'api' && seg[1] === 'accounts') {
    const id = seg[2];

    if (!id && method === 'POST') {
      const body = await readBody(req);
      const acc = store.addAccount({
        name: body.name,
        host: body.host,
        apiKey: body.apiKey,
      });
      store.log('info', `新增账号：${acc.name}`);
      broadcast({ kind: 'accounts' });
      return sendJson(res, 200, { account: acc });
    }

    if (id && method === 'PATCH') {
      const body = await readBody(req);
      const acc = store.updateAccount(id, body);
      if (body.profile !== undefined) store.dayState(id); // 触发落盘
      broadcast({ kind: 'accounts' });
      return sendJson(res, 200, { account: acc });
    }

    if (id && method === 'DELETE') {
      const ok = store.removeAccount(id);
      broadcast({ kind: 'accounts' });
      return sendJson(res, 200, { removed: ok });
    }

    // POST /api/accounts/:id/verify —— 用 /api/v1/me 验证 key 并缓存 profile
    if (id && seg[3] === 'verify' && method === 'POST') {
      const account = store.getAccount(id);
      if (!account) return sendJson(res, 404, { error: '账号不存在' });
      const client = new CivitaiClient({ apiKey: account.apiKey, host: account.host });
      try {
        const me = await client.me();
        const buzz = await client.getBuzzAccount().catch(() => null);
        const profile = {
          id: me.id,
          username: me.username,
          tier: me.tier,
          status: me.status,
          isMember: !!me.isMember,
          emailVerified: me.emailVerified ?? null,
          tokenScope: me.tokenScope ?? null,
          buzzLimit: me.buzzLimit ?? null,
          buzz,
          verifiedAt: new Date().toISOString(),
        };
        store.updateAccount(id, { profile });
        store.log('ok', `[${account.name}] key 验证通过：${me.username}（tier=${me.tier}）`);
        broadcast({ kind: 'accounts' });
        return sendJson(res, 200, { profile });
      } catch (e) {
        const message = describeError(e);
        store.log('error', `[${account.name}] key 验证失败：${message}`);
        return sendJson(res, 200, { error: message, isAuth: !!e?.isAuth });
      }
    }

    // POST /api/accounts/:id/scan —— 阶段一：只读扫描，不产生任何副作用
    if (id && seg[3] === 'scan' && method === 'POST') {
      const account = store.getAccount(id);
      if (!account) return sendJson(res, 404, { error: '账号不存在' });
      if (engine.isRunning(id)) return sendJson(res, 409, { error: '该账号有任务在运行，无法扫描' });
      try {
        const scan = await engine.scan(id);
        broadcast({ kind: 'scan', accountId: id, summary: { doableCount: scan.doableCount, plannedEarn: scan.plannedEarn } });
        broadcast({ kind: 'accounts' });
        return sendJson(res, 200, { scan });
      } catch (e) {
        return sendJson(res, 200, { error: describeError(e) });
      }
    }

    // POST /api/accounts/:id/run —— 阶段二：按扫描计划执行
    if (id && seg[3] === 'run' && method === 'POST') {
      const account = store.getAccount(id);
      if (!account) return sendJson(res, 404, { error: '账号不存在' });
      if (engine.isRunning(id)) return sendJson(res, 409, { error: '该账号已有任务在运行' });
      const body = await readBody(req).catch(() => ({}));

      // 没有扫描结果就先扫一次 —— 保证「先扫描、有可做项才执行」这一前置条件
      let plan = engine.lastScan(id);
      let scanned = false;
      if (!plan) {
        plan = await engine.scan(id);
        scanned = true;
      }
      if (plan.authError) {
        return sendJson(res, 200, { error: `扫描失败：${plan.authError}` });
      }
      // 不 await：立刻回执，进度通过 SSE 推。
      engine
        .run(id, { plan, types: Array.isArray(body.types) && body.types.length ? body.types : undefined, emit: broadcast })
        .catch((e) => store.log('error', `[${account.name}] 运行异常：${String(e?.message ?? e)}`));
      return sendJson(res, 200, { started: true, scannedFresh: scanned, plannedEarn: plan.plannedEarn, doableCount: plan.doableCount });
    }

    // POST /api/accounts/:id/cancel
    if (id && seg[3] === 'cancel' && method === 'POST') {
      return sendJson(res, 200, { cancelled: engine.cancel(id) });
    }

    // POST /api/accounts/:id/reset —— 清当日本地计数（站点侧额度不受影响）
    if (id && seg[3] === 'reset' && method === 'POST') {
      store.resetDay(id);
      broadcast({ kind: 'accounts' });
      return sendJson(res, 200, { day: daySnapshot(id) });
    }

    // GET /api/accounts/:id/tasks —— 当日任务快照
    if (id && seg[3] === 'tasks' && method === 'GET') {
      return sendJson(res, 200, daySnapshot(id));
    }
  }

  // POST /api/run-all —— 批量：先扫描全部启用账号，再按 concurrency 执行（默认串行）
  if (method === 'POST' && url.pathname === '/api/run-all') {
    const accounts = store.listAccounts().filter((a) => a.enabled);
    if (!accounts.length) return sendJson(res, 200, { error: '没有启用中的账号' });
    const busy = accounts.filter((a) => engine.isRunning(a.id));
    if (busy.length) return sendJson(res, 409, { error: `有 ${busy.length} 个账号正在运行` });
    const ids = accounts.map((a) => a.id);
    engine
      .runMany(ids, { emit: broadcast })
      .catch((e) => store.log('error', `批量运行异常：${String(e?.message ?? e)}`));
    return sendJson(res, 200, { started: true, accounts: ids.length, concurrency: store.settings.concurrency });
  }

  // GET /api/tasks —— 任务定义总表
  if (method === 'GET' && url.pathname === '/api/tasks') {
    return sendJson(res, 200, { tasks: TASKS, autoTypes: AUTO_TYPES, utcResetInMs: msToUtcReset(), utcDay: utcDayKey() });
  }

  return sendJson(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const done = (e) => {
    if (e) {
      store.log('error', `请求处理失败 ${url.pathname}: ${String(e?.message ?? e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: String(e?.message ?? e) });
      else res.end();
    }
  };
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(done);
  } else {
    serveStatic(req, res, url).catch(done);
  }
});

/**
 * 用系统默认浏览器打开 URL（只用于本机 loopback 面板地址）。
 *
 * 默认不弹窗，需要 CIVITAI_BUZZ_OPEN=1 —— start.bat 会设它，手动 `node server.mjs` 不会。
 * 调用点刻意放在 listen 回调里：那一刻端口已经在监听，打开必然连得上；
 * 换成 bat 里定时抢跑就会偶发「连接被拒绝」。
 */
function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  let opts = { detached: true, stdio: 'ignore' };
  if (platform === 'win32') {
    // 这里有个 Windows 老坑，实测踩到过：
    //   `start` 的第一个带引号参数是「窗口标题」，必须显式给一个空的 `""` 占位。
    //   而 Node 会把参数里的空串自动转义成 `""`，转义后的结果与 start 的解析规则对不上，
    //   结果 start 把 URL 当成本地路径 → 弹出来的是资源管理器而不是浏览器。
    //   解法：传字面量 '""' 并关掉 Node 的参数转义（windowsVerbatimArguments），
    //   让命令行就是标准写法 `cmd /c start "" <url>`。
    cmd = 'cmd.exe';
    args = ['/c', 'start', '""', url];
    opts = { ...opts, windowsVerbatimArguments: true };
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, opts);
    child.on('error', () => { /* 打不开就安静退回，下面提示手动访问 */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  store.log('info', `服务已启动：${url}`);
  scheduler.start();
  const s = store.settings;
  console.log('');
  console.log('  civitai Blue Buzz 助手');
  console.log(`  面板地址   ${url}`);
  console.log(`  数据目录   ${DATA_DIR}`);
  console.log(`  自动模式   ${s.autoRun ? `开（每日 ${s.runAt}）` : '关'}`);
  console.log(`  账号数     ${store.listAccounts().length}`);
  if (process.env.CIVITAI_BUZZ_OPEN === '1') {
    const ok = openBrowser(url);
    console.log(`  浏览器     ${ok ? '已打开' : '打开失败，请手动访问上面的地址'}`);
    store.log('info', `自动打开浏览器：${ok ? '成功' : '失败'}`);
  } else {
    console.log('  （设 CIVITAI_BUZZ_OPEN=1 可在服务就绪时自动打开浏览器）');
  }
  console.log('');
});

// 端口被占用时给一句人话，而不是把 EADDRINUSE 的栈糊到用户脸上
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  端口 ${PORT} 已被占用。`);
    console.error(`  若本工具已在运行，直接访问 http://${HOST}:${PORT}/ 即可。`);
    console.error('  要换端口：编辑 start.bat 里的 CIVITAI_BUZZ_PORT，或先关掉占用该端口的程序。');
    console.error('');
  } else {
    console.error(`  服务启动失败：${e?.message ?? e}`);
  }
  store.log('error', `服务启动失败：${e?.message ?? e}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.log('info', '服务停止');
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
