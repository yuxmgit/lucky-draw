'use strict';

/**
 * 公开抽奖页逻辑（无需登录）
 * - 只能抽取、查看；人员与奖品由 /admin 后台维护
 * - 多人同时打开时通过轮询保持同步
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  prizes: [],
  stats: null,
  selectedPrizeId: null,
  pool: { poolSize: 0, names: [] },
  rolling: false,
  records: [],
};

/* --------------------------------- 工具 --------------------------------- */

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

const fmtTime = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
const fmtShortTime = (iso) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------- 抽奖台 -------------------------------- */

function renderPrizes() {
  const list = $('#prizeList');
  if (!state.prizes.length) {
    list.innerHTML = `<div class="prize-empty">还没有奖品<br />请联系管理员在后台添加 🎁</div>`;
    return;
  }
  list.innerHTML = state.prizes
    .map((p) => {
      const active = p.id === state.selectedPrizeId ? 'active' : '';
      const done = p.remaining <= 0 ? 'done' : '';
      return `<button class="prize-item ${active} ${done}" data-prize="${p.id}">
        <span class="pi-icon">${p.icon}</span>
        <span class="pi-body">
          <span class="pi-name">${escapeHtml(p.name)}</span>
          <span class="pi-meta">${escapeHtml(p.level)} · 共 ${p.quantity} 个</span>
        </span>
        <span class="pi-count">${p.remaining > 0 ? `剩 ${p.remaining}` : '已抽完'}</span>
      </button>`;
    })
    .join('');

  $$('.prize-item', list).forEach((btn) => {
    btn.addEventListener('click', () => selectPrize(Number(btn.dataset.prize)));
  });
}

function renderStage() {
  const prize = state.prizes.find((p) => p.id === state.selectedPrizeId);
  if (!prize) {
    $('#stageIcon').textContent = '🎁';
    $('#stagePrizeName').textContent = '请选择奖品';
    $('#stagePrizeMeta').textContent = '准备好名单后即可开抽';
    $('#poolCount').textContent = state.pool.poolSize || 0;
    $('#drawBtn').disabled = true;
    return;
  }
  $('#stageIcon').textContent = prize.icon;
  $('#stagePrizeName').textContent = prize.name;
  $('#stagePrizeMeta').textContent = `${prize.level} · 共 ${prize.quantity} 个 · 已抽 ${prize.won} 个 · 剩余 ${prize.remaining} 个`;
  $('#poolCount').textContent = state.pool.poolSize;
  $('#drawBtn').disabled = state.rolling || prize.remaining <= 0 || state.pool.poolSize === 0;
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('#statPeople').textContent = s.participants;
  $('#statWinners').textContent = s.winners;
  $('#statStock').textContent = s.remainingStock;
  $('#statTotal').textContent = s.totalStock;
}

function renderFeed() {
  const feed = $('#feed');
  if (!state.records.length) {
    feed.innerHTML = `<li class="feed-empty" style="background:none;border:none">还没有中奖记录<br />快抽出第一位幸运儿</li>`;
    return;
  }
  feed.innerHTML = state.records
    .slice(0, 30)
    .map(
      (r) => `<li>
        <span class="f-icon">${r.prizeIcon || '🎁'}</span>
        <span class="f-body">
          <span class="f-name">${escapeHtml(r.participantName)}</span>
          <span class="f-prize">${escapeHtml(r.prizeName)}</span>
        </span>
        <span class="f-time">${fmtShortTime(r.createdAt)}</span>
      </li>`
    )
    .join('');
}

async function refresh({ keepRoller = true } = {}) {
  const data = await api('/api/overview');
  state.stats = data.stats;
  state.prizes = data.prizes;
  state.records = data.winners;

  if (!state.selectedPrizeId || !state.prizes.some((p) => p.id === state.selectedPrizeId)) {
    const next = state.prizes.find((p) => p.remaining > 0) || state.prizes[0];
    state.selectedPrizeId = next ? next.id : null;
  }
  renderPrizes();
  renderStats();
  renderFeed();
  await loadPool();
  if (!state.rolling && keepRoller) renderStage();
}

async function loadPool() {
  try {
    state.pool = await api('/api/pool');
  } catch {
    state.pool = { poolSize: 0, names: [] };
  }
}

async function selectPrize(id) {
  if (state.rolling) return;
  state.selectedPrizeId = id;
  $('#roller').classList.remove('win');
  $('#rollName').textContent = '🎯';
  $('#rollDept').textContent = '';
  $('#rollTip').textContent = '点击下方按钮开始抽奖';
  await loadPool();
  renderPrizes();
  renderStage();
}

async function doDraw() {
  if (state.rolling) return;
  const prize = state.prizes.find((p) => p.id === state.selectedPrizeId);
  if (!prize) return toast('请先选择一个奖品', 'err');
  if (prize.remaining <= 0) return toast(`${prize.name} 已经抽完啦`, 'err');

  let pool;
  try {
    pool = await api('/api/pool');
  } catch (err) {
    return toast(err.message, 'err');
  }
  if (pool.poolSize === 0) return toast('当前没有可参与抽奖的人员了', 'err');

  state.rolling = true;
  $('#drawBtn').disabled = true;
  const roller = $('#roller');
  const nameEl = $('#rollName');
  const deptEl = $('#rollDept');
  roller.classList.remove('win');
  roller.classList.add('rolling');
  $('#rollTip').textContent = '正在抽取，结果由服务器生成…';
  $('#poolCount').textContent = pool.poolSize;

  const spin = setInterval(() => {
    const item = pool.names[Math.floor(Math.random() * pool.names.length)];
    if (!item) return;
    nameEl.textContent = item.name;
    deptEl.textContent = item.dept || '';
  }, 55);

  let result = null;
  let error = null;
  try {
    await sleep(1900);
    result = await api('/api/draw', { method: 'POST', body: { prizeId: state.selectedPrizeId } });
  } catch (err) {
    error = err;
  } finally {
    clearInterval(spin);
    state.rolling = false;
  }

  roller.classList.remove('rolling');

  if (error) {
    $('#rollName').textContent = '😢';
    $('#rollDept').textContent = '';
    $('#rollTip').textContent = error.message;
    toast(error.message, 'err');
    await refresh();
    return;
  }

  roller.classList.add('win');
  nameEl.textContent = result.winner.name;
  deptEl.textContent = [result.winner.dept, result.prize.name].filter(Boolean).join(' · ');
  $('#rollTip').textContent = `🎉 恭喜！第 ${result.poolSize} 位候选人中抽出 · 记录指纹 ${result.hash.slice(0, 8)}`;
  burstConfetti();
  await refresh();
  renderStage();
}

/* -------------------------------- 中奖记录 -------------------------------- */

async function loadRecords() {
  const data = await api('/api/winners?limit=1000');
  state.records = data.winners;
  renderRecords();
}

function renderRecords() {
  const keyword = ($('#recordSearch')?.value || '').trim().toLowerCase();
  const rows = state.records.filter(
    (r) =>
      !keyword ||
      r.participantName.toLowerCase().includes(keyword) ||
      r.prizeName.toLowerCase().includes(keyword) ||
      (r.participantDept || '').toLowerCase().includes(keyword)
  );
  const tbody = $('#recordTable tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${state.records.length ? '没有匹配的记录' : '还没有中奖记录'}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r, i) => `<tr>
        <td class="mono">${i + 1}</td>
        <td class="muted">${fmtTime(r.createdAt)}</td>
        <td>${r.prizeIcon || '🎁'} ${escapeHtml(r.prizeName)}</td>
        <td><span class="pill">${escapeHtml(r.prizeLevel || '—')}</span></td>
        <td><b>${escapeHtml(r.participantName)}</b></td>
        <td class="muted">${escapeHtml(r.participantDept || '—')}</td>
        <td class="mono" title="sha256: ${r.hash}">${r.shortHash}…</td>
      </tr>`
    )
    .join('');
}

/* ------------------------------- 撒花动效 -------------------------------- */

const canvas = $('#confetti');
const ctx = canvas.getContext('2d');
let particles = [];
let confettiRaf = null;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function burstConfetti(count = 160) {
  const colors = ['#ffcb5c', '#ff8a3c', '#ff5c8a', '#7b61ff', '#34d399', '#ffffff'];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 220,
      y: window.innerHeight * 0.5,
      vx: (Math.random() - 0.5) * 15,
      vy: -Math.random() * 15 - 4,
      size: Math.random() * 8 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 1,
    });
  }
  if (!confettiRaf) loopConfetti();
}

function loopConfetti() {
  confettiRaf = requestAnimationFrame(loopConfetti);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  particles.forEach((p) => {
    p.vy += 0.32;
    p.vx *= 0.995;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.life -= 0.006;
  });
  particles = particles.filter((p) => p.life > 0 && p.y < window.innerHeight + 40);
  particles.forEach((p) => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    ctx.restore();
  });
  if (!particles.length) {
    cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

/* --------------------------------- 交互 --------------------------------- */

function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view === 'records') loadRecords().catch((err) => toast(err.message, 'err'));
}

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#drawBtn').addEventListener('click', doDraw);

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if ($('#view-draw').classList.contains('hidden')) return;
    e.preventDefault();
    doDraw();
  });

  $('#recordSearch').addEventListener('input', renderRecords);

  window.addEventListener('resize', resizeCanvas);

  // 多人同时在线时保持同步（抽奖进行中不打断动画）
  setInterval(async () => {
    if (state.rolling) return;
    if ($('#view-draw').classList.contains('hidden')) return;
    try {
      await refresh();
    } catch { /* 忽略轮询错误 */ }
  }, 6000);
}

(async function init() {
  resizeCanvas();
  bindEvents();
  try {
    await refresh();
    renderStage();
  } catch (err) {
    toast(`加载失败：${err.message}`, 'err');
  }
})();
