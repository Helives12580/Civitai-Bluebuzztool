/**
 * 面板前端逻辑。原生 JS，无依赖。
 * 状态来自 GET /api/state；实时进度走 SSE /api/events。
 */

const $ = (id) => document.getElementById(id);

let STATE = null;
let selectedId = null;
const stepMsg = new Map();   // type -> 正在进行的步骤文案
let resetTimer = null;

// ───────────────── 基础请求 ─────────────────

async function j(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    ...(opts.body && typeof opts.body !== 'string'
      ? { body: JSON.stringify(opts.body) }
      : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ───────────────── toast ─────────────────

let toastTimer = null;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

// ───────────────── 日志 ─────────────────

const logEl = () => $('logs');

function appendLog(level, message, ts) {
  const box = logEl();
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const line = document.createElement('div');
  line.className = `ln ${level}`;
  const time = (ts ? new Date(ts) : new Date()).toLocaleTimeString('zh-CN', { hour12: false });
  line.innerHTML = `<span class="t">${time}</span><span class="m"></span>`;
  line.querySelector('.m').textContent = message;
  box.appendChild(line);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ───────────────── 渲染 ─────────────────

const MODE_TEXT = {
  auto: '可自动',
  assisted: '需前置',
  passive: '被动',
  locked: '手动',
};

function selected() {
  return STATE?.accounts.find((a) => a.id === selectedId) ?? STATE?.accounts[0] ?? null;
}

function fmtEarned(n) {
  return `${n > 0 ? '+' : ''}${n} buzz`;
}

/**
 * 顶栏「今日收益」——显示**站点流水实测值**，不是本地累加的理论值。
 *
 * 为什么必须这样：`day.earned` 只是本工具按任务定义累加的「我做了多少」。
 * 一旦撞上站点去重、日上限、或用户自己手动做过一部分，两者就会明显分叉
 * （实测出现过理论 155 / 实际只到账 83）。顶栏显示理论值就是在虚报。
 * 站点真值只在扫描/执行后可得，所以没扫过时如实显示「未扫描」。
 */
function renderEarned(acc) {
  const el = $('stat-earned');
  if (!acc) {
    el.textContent = '—';
    el.title = '';
    return;
  }
  const site = acc.day.siteEarned;
  const local = acc.day.earned ?? 0;
  const stale = acc.day.siteEarnedDay && acc.day.siteEarnedDay !== acc.day.day;
  if (typeof site === 'number' && !stale) {
    el.textContent = `${site} buzz（站点）`;
    el.title =
      `站点交易流水实测，权威口径。\n` +
      `本工具本地累计（理论）+${local} buzz —— 两者不一致通常是因为：\n` +
      `· 站点对同一内容当天只算一次，重复操作不再给奖励\n` +
      `· 日上限里已被你手动操作占掉一部分\n` +
      `数据来源：${acc.day.siteEarnedAt ? new Date(acc.day.siteEarnedAt).toLocaleString('zh-CN') : '—'}`;
  } else {
    el.textContent = '未扫描';
    el.title = `点「扫描当前可做任务」后可读到站点真值。\n（本地理论累计 +${local} buzz，仅供参考）`;
  }
}

function render() {
  if (!STATE) return;
  const acc = selected();
  if (acc) selectedId = acc.id;

  // 顶栏
  // 顶栏收益：站点真值优先
  renderEarned(acc);
  $('stat-account').textContent = acc
    ? (acc.profile?.username ? `${acc.profile.username}` : acc.name)
    : '未添加';
  $('stat-account').title = acc?.profile
    ? `tier: ${acc.profile.tier} · scope: ${acc.profile.tokenScope ?? '—'}`
    : '';

  // 账号下拉
  const sel = $('account-select');
  sel.innerHTML = '';
  for (const a of STATE.accounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.profile?.username ? `${a.profile.username} (${a.name})` : a.name;
    sel.appendChild(o);
  }
  if (acc) sel.value = acc.id;
  sel.disabled = STATE.accounts.length === 0;

  // 运行按钮 —— 「开始完成」必须在扫描且确实有可做项之后才可用
  const running = !!acc && (acc.running || STATE.runningIds.includes(acc.id));
  const scan = acc?.scan ?? null;
  const ready = !!scan?.ok && (scan.doableCount ?? 0) > 0;
  $('btn-run').disabled = !acc || running || !ready;
  $('btn-cancel').disabled = !running;
  $('btn-verify').disabled = !acc;
  $('btn-scan').disabled = !acc || running;
  $('scan-summary').textContent = !acc
    ? ''
    : !scan
      ? '尚未扫描'
      : scan.ok
        ? `可做 ${scan.doableCount} 项 · 预计 +${scan.plannedEarn} buzz`
        : '扫描失败';

  renderScanBar(acc, scan);
  renderTasks(acc, scan);
  renderAccounts();
  renderSettings();
}

/** 扫描结果面板：只读扫描产出的「可做任务 + 依据 + 计划」，等人确认。 */
function renderScanBar(acc, scan) {
  const bar = $('scan-bar');
  if (!acc || !scan) { bar.hidden = true; return; }
  bar.hidden = false;
  $('scan-meta').textContent =
    `扫描于 ${new Date(scan.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })} · UTC 日 ${scan.utcDay}`;

  const body = $('scan-body');
  body.innerHTML = '';

  if (scan.authError) {
    const p = document.createElement('p');
    p.className = 'note bad';
    p.textContent = `扫描失败：${scan.authError}`;
    body.appendChild(p);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'scan-grid';
  const site = scan.siteRewards;
  for (const [k, v, title] of [
    ['可做任务', `${scan.doableCount} 项`, ''],
    ['预计收益', `+${scan.plannedEarn} buzz`, '按任务定义推算的理论上限'],
    [
      '站点侧今日已得',
      site ? `${site.total} buzz（${site.txCount} 笔）` : '流水不可读',
      '来源：今日 buzz 交易流水。剩余额度以此为准，本地记录不参与计算',
    ],
    ['账号', scan.username ?? '—', ''],
    [
      '任务定义来源',
      scan.officialDefs?.length ? `官方接口（${scan.officialDefs.length} 项）` : '本地常量（官方接口不可读）',
      '单次额度与上限优先采信官方接口 user.userRewardDetails，官方调额后自动跟上',
    ],
    ['并发 / 反应间隔', `${scan.settings?.concurrency ?? 1} 账号 · ${(scan.settings?.reactionDelayMs ?? 1000) / 1000}s`, ''],
  ]) {
    const d = document.createElement('div');
    d.innerHTML = '<span class="k"></span><span class="v mono"></span>';
    d.querySelector('.k').textContent = k;
    d.querySelector('.v').textContent = String(v);
    if (title) d.title = title;
    grid.appendChild(d);
  }
  body.appendChild(grid);

  // 站点侧今日明细（含你手动操作的贡献）
  if (site && Object.keys(site.byTypeCount ?? {}).length) {
    const detail = document.createElement('div');
    detail.className = 'scan-site';
    detail.innerHTML = '<span class="k">站点侧今日明细</span> ';
    const parts = Object.entries(site.byTypeCount)
      .map(([type, count]) => `${type} ${count} 次 / ${site.byType[type] ?? 0} buzz`)
      .join(' · ');
    const sp = document.createElement('span');
    sp.className = 'v';
    sp.textContent = parts;
    detail.appendChild(sp);
    body.appendChild(detail);
  }

  const doable = (scan.tasks ?? []).filter((t) => t.doable);
  if (!doable.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = '当前没有可执行的自动任务。被动项要等他人行为，手动项需你自己操作。';
    body.appendChild(p);
  }
  for (const t of doable) {
    const row = document.createElement('div');
    row.className = 'scan-row';
    row.innerHTML = '<span class="t-name"></span><span class="t-plan mono"></span><span class="t-why"></span>';
    row.querySelector('.t-name').textContent = t.label;
    row.querySelector('.t-plan').textContent = `+${t.plannedEarn} · ${t.plannedCount} 次`;
    row.querySelector('.t-why').textContent = t.reason;
    body.appendChild(row);
  }
  for (const n of scan.notes ?? []) {
    const p = document.createElement('p');
    p.className = 'note warn';
    p.textContent = `⚠ ${n}`;
    body.appendChild(p);
  }
}

/** 任务定义（无账号时也要展示完整能力清单，不能是空白页）。 */
function taskDefs() {
  return (STATE?.taskDefs ?? []).map((t) => ({
    ...t,
    count: 0,
    earned: 0,
    done: false,
    autoRunnable: STATE.autoTypes.includes(t.type),
  }));
}

function renderTasks(acc, scan) {
  const box = $('tasks');
  box.innerHTML = '';
  const hasAccount = !!acc;
  const tasks = hasAccount ? acc.day.tasks : taskDefs();
  const scanByType = new Map((scan?.tasks ?? []).map((t) => [t.type, t]));
  const ceiling = tasks
    .filter((t) => t.autoRunnable)
    .reduce((s, t) => s + (t.cap ?? 0), 0);

  $('tasks-hint').textContent = !hasAccount
    ? `共 ${tasks.length} 项任务 · 可自动 ${ceiling} buzz/日 · 添加账号后可扫描`
    : scan?.ok
      ? `扫描可做 ${scan.doableCount} 项 · 计划 +${scan.plannedEarn} buzz · UTC 日 ${scan.utcDay}`
      : `共 ${tasks.length} 项任务 · 可自动 ${ceiling} buzz/日 · 点「扫描当前可做任务」获取进度`;

  for (const t of tasks) {
    const s = scanByType.get(t.type);
    const running = hasAccount && acc.running && t.autoRunnable && !!s?.doable;
    const el = document.createElement('div');
    el.className = `task ${t.mode}${running ? ' running' : ''}${s?.doable ? ' doable' : ''}`;
    el.dataset.type = t.type;

    // 未扫描时不假装知道进度：显示「未扫描」，进度条留空。
    const planned = s?.plannedEarn ?? 0;
    const meterText = !s ? '未扫描' : s.doable ? `计划 +${planned} · ${s.plannedCount} 次` : '跳过';

    // 站点侧该项今日已得（来自流水）——与「计划」是两回事，分开显示，
    // 免得把「这一轮打算做多少」误读成「已经到手多少」。
    const siteAmt = (acc?.day?.siteEarnedByType ?? {})[t.type];
    const siteNote =
      typeof siteAmt === 'number' && t.capInterval === 'day' && t.cap
        ? `站点 ${siteAmt}/${t.cap}`
        : '';

    // 进度条：有站点真值时用真值占上限的比例，否则用本轮计划
    const shown = typeof siteAmt === 'number' ? siteAmt : planned;
    const pct = t.cap ? Math.min(100, Math.round((shown / t.cap) * 100)) : 0;
    const msg = stepMsg.get(t.type);
    const detail = msg ?? s?.reason ?? '';

    el.innerHTML = `
      <div class="amt">${t.amount}</div>
      <div class="body">
        <div class="title">
          <span></span>
          <span class="badge ${t.mode}">${MODE_TEXT[t.mode] ?? t.mode}</span>
          ${t.capInterval === 'month' ? '<span class="badge">月上限</span>' : ''}
          ${s?.doable ? '<span class="badge ok">可做</span>' : ''}
        </div>
        <div class="trigger"></div>
        ${detail ? `<div class="stepmsg${msg ? ' live' : ''}"></div>` : ''}
      </div>
      <div class="meter">
        <div class="num">${meterText}</div>
        ${siteNote ? `<div class="sub mono"></div>` : ''}
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>`;

    el.querySelector('.title > span').textContent = t.label;
    el.querySelector('.trigger').textContent = t.trigger + (t.note ? ` — ${t.note}` : '');
    if (detail) el.querySelector('.stepmsg').textContent = detail;
    if (siteNote) el.querySelector('.meter .sub').textContent = siteNote;
    box.appendChild(el);
  }
}

/** 把 buzz 账户数组渲染成一行可读文本；累计获得单独标出（不受消费干扰）。 */
function fmtBuzzLine(buzz) {
  if (!Array.isArray(buzz) || !buzz.length) return '';
  return buzz
    .map((b) => {
      const type = b?.accountType ?? '?';
      const bal = b?.balance;
      const life = b?.lifetimeBalance;
      return typeof life === 'number' && life !== bal
        ? `${type} ${bal}（累计 ${life}）`
        : `${type} ${bal}`;
    })
    .join(' · ');
}

function renderAccounts() {
  const box = $('account-list');
  box.innerHTML = '';
  if (!STATE.accounts.length) {
    box.innerHTML = '<p class="note">还没有账号。添加后点「验证 Key」即可读到用户名与权限。</p>';
    return;
  }
  for (const a of STATE.accounts) {
    const el = document.createElement('div');
    el.className = 'acc';
    const p = a.profile;
    const statusLine = p
      ? `${a.host} · tier ${p.tier || 'free'} · scope ${p.tokenScope ?? '—'}${p.emailVerified === false ? ' · 邮箱未验证' : ''}`
      : `${a.host} · 未验证`;
    const buzzLine = p?.buzz ? fmtBuzzLine(p.buzz) : '';
    el.innerHTML = `
      <div class="top">
        <span class="nm"></span>
        <span class="acts">
          <button class="btn tiny" data-act="verify">验证</button>
          <button class="btn tiny ghost" data-act="del">删</button>
        </span>
      </div>
      <div class="meta"></div>
      ${buzzLine ? '<div class="meta"></div>' : ''}`;
    const nm = el.querySelector('.nm');
    nm.textContent = p?.username ?? a.name;
    nm.className = p ? 'nm ok' : 'nm';
    el.querySelector('.meta').textContent = statusLine;
    if (buzzLine) el.querySelectorAll('.meta')[1].textContent = buzzLine;

    el.querySelector('[data-act="verify"]').onclick = async () => {
      toast('正在验证…');
      try {
        const r = await j(`/api/accounts/${a.id}/verify`, { method: 'POST', body: {} });
        if (r.error) toast(r.error, true);
        else toast(`验证通过：${r.profile.username}`);
        await refresh();
      } catch (e) { toast(String(e.message), true); }
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`删除账号「${a.name}」？`)) return;
      await j(`/api/accounts/${a.id}`, { method: 'DELETE' });
      if (selectedId === a.id) selectedId = null;
      await refresh();
    };
    box.appendChild(el);
  }
}

function renderSettings() {
  const s = STATE.settings;
  $('s-auto').checked = !!s.autoRun;
  $('s-runat').value = s.runAt ?? '09:30';
  $('s-concurrency').value = s.concurrency ?? 1;
  $('s-reactions').value = s.reactionTarget ?? 50;
  $('s-follows').value = s.followTarget ?? 3;
  $('s-delay-min').value = (s.reactionDelayMinMs ?? 1000) / 1000;
  $('s-delay-max').value = (s.reactionDelayMaxMs ?? 1000) / 1000;
  $('s-next').textContent = STATE.scheduler?.nextRunAt
    ? new Date(STATE.scheduler.nextRunAt).toLocaleString('zh-CN')
    : '未排程';
}

function tickReset() {
  if (!STATE) return;
  const acc = selected();
  const ms = acc?.day?.utcResetInMs ?? STATE.utcResetInMs;
  if (typeof ms !== 'number') { $('stat-reset').textContent = '—'; return; }
  const left = Math.max(0, ms - (Date.now() - lastStateAt));
  const h = String(Math.floor(left / 3600000)).padStart(2, '0');
  const m = String(Math.floor((left % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  $('stat-reset').textContent = `${h}:${m}:${sec}`;
}

// ───────────────── 状态刷新 ─────────────────

let lastStateAt = Date.now();
let refreshTimer = null;

async function refresh() {
  try {
    const data = await j('/api/state');
    STATE = data;
    lastStateAt = Date.now();
    render();
  } catch (e) {
    appendLog('error', `状态获取失败：${e.message}`);
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 400);
}

// ───────────────── SSE ─────────────────

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    $('stat-conn').innerHTML = '<i class="dot on"></i> 已连接';
  };
  es.onerror = () => {
    $('stat-conn').innerHTML = '<i class="dot off"></i> 已断开';
  };
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handleEvent(e);
  };
}

function handleEvent(e) {
  switch (e.kind) {
    case 'step':
      stepMsg.set(e.type, e.message);
      appendLog('evt', e.message);
      scheduleRefresh();
      break;
    case 'task-start':
      stepMsg.set(e.type, '开始…');
      appendLog('info', `▶ ${e.label}`);
      scheduleRefresh();
      break;
    case 'task-done': {
      stepMsg.delete(e.type);
      const tail = e.error
        ? `✗ ${e.error}`
        : e.skipped
          ? `· 跳过：${e.skipped}`
          : `✓ +${e.earned} buzz`;
      appendLog(e.error ? 'error' : 'info', `  ${tail}`);
      if (e.warnings?.length) for (const w of e.warnings) appendLog('info', `  ⚠ ${w}`);
      scheduleRefresh();
      break;
    }
    case 'task-error':
      appendLog('error', e.message);
      break;
    case 'run-done': {
      stepMsg.clear();
      // 理论值按任务定义推算；实测到账取站点流水差额（权威口径）
      const actual = typeof e.rewardDelta === 'number'
        ? `，流水实测 ${e.rewardDelta > 0 ? '+' : ''}${e.rewardDelta}`
        : '';
      const tail = `${e.aborted ? '（已中止）' : ''}`;
      toast(`本轮完成，理论 +${e.earned} buzz${actual}${tail}`);
      appendLog('ok', `══ 结束：理论 +${e.earned} buzz${actual}${tail}`);
      scheduleRefresh();
      break;
    }
    case 'scan':
      appendLog('info', `扫描结果：可做 ${e.summary?.doableCount ?? 0} 项，预计 +${e.summary?.plannedEarn ?? 0} buzz`);
      break;
    case 'batch-start':
      appendLog('info', `批量开始：${e.total} 个账号，并发 ${e.concurrency}${e.concurrency === 1 ? '（串行）' : ''}`);
      break;
    case 'batch-item':
      appendLog(
        e.error ? 'error' : 'ok',
        e.error
          ? `[${e.name ?? e.accountId}] 失败：${e.error}`
          : `[${e.name ?? e.accountId}] 完成：可做 ${e.doableCount ?? 0} 项，理论 +${e.earned ?? 0}${typeof e.rewardDelta === 'number' ? ` · 流水实测 ${e.rewardDelta > 0 ? '+' : ''}${e.rewardDelta}` : ''}`,
      );
      scheduleRefresh();
      break;
    case 'batch-done':
      toast(`批量结束：处理 ${e.total} 个账号`);
      scheduleRefresh();
      break;
    case 'schedule-fire':
      toast(`自动模式触发，处理 ${e.accounts} 个账号`);
      appendLog('info', `⏰ 自动模式触发（${e.accounts} 个账号）`);
      break;
    case 'accounts':
    case 'settings':
      scheduleRefresh();
      break;
    default:
      break;
  }
}

// ───────────────── 交互绑定 ─────────────────

$('account-select').onchange = (ev) => {
  selectedId = ev.target.value;
  stepMsg.clear();
  render();
};

$('btn-scan').onclick = async () => {
  const acc = selected();
  if (!acc) return;
  $('btn-scan').disabled = true;
  toast('正在扫描（只读，不产生任何操作）…');
  appendLog('info', '开始扫描当前可做任务');
  try {
    const r = await j(`/api/accounts/${acc.id}/scan`, { method: 'POST', body: {} });
    if (r.error) toast(r.error, true);
    else toast(`扫描完成：可做 ${r.scan.doableCount} 项，预计 +${r.scan.plannedEarn} buzz`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('btn-scan').disabled = false;
  }
};

$('btn-run').onclick = async () => {
  const acc = selected();
  if (!acc) return;
  try {
    const r = await j(`/api/accounts/${acc.id}/run`, { method: 'POST', body: {} });
    if (r.error) { toast(r.error, true); return; }
    toast(`开始执行 ${r.doableCount} 项，预计 +${r.plannedEarn} buzz`);
    appendLog('info', `开始完成（计划 +${r.plannedEarn} buzz）`);
    scheduleRefresh();
  } catch (e) { toast(e.message, true); }
};

$('btn-cancel').onclick = async () => {
  const acc = selected();
  if (!acc) return;
  await j(`/api/accounts/${acc.id}/cancel`, { method: 'POST', body: {} });
  toast('已请求中止');
};

$('btn-verify').onclick = async () => {
  const acc = selected();
  if (!acc) return;
  toast('正在验证…');
  try {
    const r = await j(`/api/accounts/${acc.id}/verify`, { method: 'POST', body: {} });
    toast(r.error ? r.error : `验证通过：${r.profile.username}`, !!r.error);
    await refresh();
  } catch (e) { toast(e.message, true); }
};

$('form-account').onsubmit = async (ev) => {
  ev.preventDefault();
  const apiKey = $('f-key').value.trim();
  if (!apiKey) return;
  try {
    const r = await j('/api/accounts', {
      method: 'POST',
      body: { name: $('f-name').value, host: $('f-host').value, apiKey },
    });
    $('f-key').value = '';
    $('f-name').value = '';
    selectedId = r.account.id;
    await refresh();
    toast('账号已添加，正在验证…');
    const v = await j(`/api/accounts/${r.account.id}/verify`, { method: 'POST', body: {} });
    toast(v.error ? v.error : `验证通过：${v.profile.username}`, !!v.error);
    await refresh();
  } catch (e) { toast(e.message, true); }
};

$('btn-save-settings').onclick = async () => {
  try {
    await j('/api/settings', {
      method: 'PATCH',
      body: {
        autoRun: $('s-auto').checked,
        runAt: $('s-runat').value,
        concurrency: Number($('s-concurrency').value) || 1,
        reactionTarget: Number($('s-reactions').value),
        followTarget: Number($('s-follows').value),
        reactionDelayMinMs: Number($('s-delay-min').value) * 1000,
        reactionDelayMaxMs: Number($('s-delay-max').value) * 1000,
      },
    });
    await refresh();
    toast('设置已保存');
  } catch (e) { toast(e.message, true); }
};

$('btn-run-all').onclick = async () => {
  try {
    const r = await j('/api/run-all', { method: 'POST', body: {} });
    if (r.error) { toast(r.error, true); return; }
    toast(`批量启动：${r.accounts} 个账号，并发 ${r.concurrency}`);
    appendLog('info', `批量启动 ${r.accounts} 个账号（并发 ${r.concurrency}）`);
    scheduleRefresh();
  } catch (e) { toast(e.message, true); }
};

$('btn-clear-log').onclick = () => { logEl().innerHTML = ''; };

// ───────────────── 启动 ─────────────────

// 注意：这里必须用 IIFE 包住，不能用顶层 await —— 本脚本以经典 <script> 加载，
// 顶层 await 会直接让整份文件语法错误、一行都不执行。
(async function boot() {
  setInterval(tickReset, 1000);
  setInterval(() => { if (STATE) void refresh(); }, 15000);
  await refresh();
  connectEvents();
  appendLog('info', '面板已就绪');
})();
