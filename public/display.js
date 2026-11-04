'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (url) => {
  const res = await fetch(url);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('登录已失效');
  }
  if (!res.ok) throw new Error('加载失败');
  return res.json();
};

let lastDrawId = null;
let hideTimer = null;
let pollTimer = null;
let online = true;

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderStats(stats) {
  $('#sPeople').textContent = stats.participants;
  $('#sWinners').textContent = stats.winners;
  $('#sStock').textContent = stats.remainingStock;
  $('#sPool').textContent = stats.poolSize;
}

function renderFeed(winners) {
  const feed = $('#winnerFeed');
  if (!winners.length) {
    feed.innerHTML = `<li style="background:none;border:none;color:#8b95bb;font-size:14px">等待第一位幸运儿诞生…</li>`;
    return;
  }
  feed.innerHTML = winners
    .map((w, index) => {
      const canShow = index < Math.max(5, Math.floor((window.innerHeight - 260) / 62));
      if (!canShow) return '';
      return `<li class="${index === 0 ? 'new' : ''}">
        <span class="wf-icon">${w.prizeIcon || '🎁'}</span>
        <span>
          <span class="wf-name">${escapeHtml(w.participantName)}</span>
          <span class="wf-dept">${escapeHtml(w.participantDept || '')}</span>
        </span>
        <span class="wf-prize">${escapeHtml(w.prizeName)}</span>
        <span class="wf-time">${fmtTime(w.createdAt)}</span>
      </li>`;
    })
    .join('');
}

function renderBoard(prizes) {
  const board = $('#prizeBoard');
  if (!prizes.length) {
    board.innerHTML = `<div style="color:#8b95bb;font-size:14px">管理员尚未配置奖品</div>`;
    return;
  }
  board.innerHTML = prizes
    .map((p) => {
      const pct = p.quantity ? Math.round((p.won / p.quantity) * 100) : 0;
      return `<div class="pb-item ${p.remaining <= 0 ? 'done' : ''}">
        <div class="pb-top">
          <span>${p.icon}</span>
          <span class="pb-name">${escapeHtml(p.name)}</span>
          <span class="pb-num"><b>${p.won}</b> / ${p.quantity} ${p.remaining <= 0 ? '已抽完' : ''}</span>
        </div>
        <div class="pb-bar"><i style="width:${pct}%"></i></div>
      </div>`;
    })
    .join('');
}

function showReveal(winner) {
  $('#revealPrize').textContent = `${winner.prizeIcon || '🎁'} ${winner.prizeName}`;
  $('#revealName').textContent = winner.participantName;
  $('#revealDept').textContent = winner.participantDept || '';
  $('#revealTime').textContent = `中奖时间 ${new Date(winner.createdAt).toLocaleString('zh-CN', { hour12: false })}`;

  const reveal = $('#reveal');
  reveal.classList.add('show');
  burstConfetti(120);

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => reveal.classList.remove('show'), 7000);
}

async function poll() {
  try {
    const data = await api('/api/display');
    if (!online) {
      online = true;
      $('#fairNote').textContent = '抽奖结果由服务器加密随机生成 · 每条记录含上一条哈希，可公开校验';
    }
    renderStats(data.stats);
    renderFeed(data.winners);
    renderBoard(data.prizes);
    $('#chainHead').textContent = data.latest ? `${data.latest.hash.slice(0, 20)}…` : '—';

    if (data.latest && data.latest.id !== lastDrawId) {
      const isFirstLoad = lastDrawId === null;
      lastDrawId = data.latest.id;
      if (!isFirstLoad) showReveal(data.latest);
    }
  } catch {
    if (online) {
      online = false;
      $('#fairNote').textContent = '与服务器连接中断，正在重试…';
    }
  }
}

/* -------------------------------- 撒花 -------------------------------- */
const canvas = $('#confetti');
const ctx = canvas.getContext('2d');
let particles = [];
let raf = null;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function burstConfetti(count = 140) {
  const colors = ['#ffcb5c', '#ff8a3c', '#ff5c8a', '#7b61ff', '#34d399', '#ffffff'];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 320,
      y: window.innerHeight * 0.5,
      vx: (Math.random() - 0.5) * 18,
      vy: -Math.random() * 17 - 5,
      size: Math.random() * 10 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 1,
    });
  }
  if (!raf) loop();
}

function loop() {
  raf = requestAnimationFrame(loop);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  particles.forEach((p) => {
    p.vy += 0.34;
    p.vx *= 0.995;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.life -= 0.005;
  });
  particles = particles.filter((p) => p.life > 0 && p.y < window.innerHeight + 60);
  particles.forEach((p) => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
    ctx.restore();
  });
  if (!particles.length) {
    cancelAnimationFrame(raf);
    raf = null;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

/* -------------------------------- 启动 -------------------------------- */
function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

window.addEventListener('resize', () => {
  resize();
  poll();
});

resize();
tickClock();
setInterval(tickClock, 1000);
poll();
pollTimer = setInterval(poll, 2000);
