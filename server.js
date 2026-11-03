'use strict';

/**
 * 抽奖系统 · 服务端
 * - Node.js 内置 node:sqlite 持久化（无需额外数据库）
 * - 抽奖使用 crypto.randomInt（密码学安全、无模偏差）
 * - 每次抽奖记录：中奖人、奖品、时间、候选池快照、前序哈希，形成可校验的哈希链
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'lottery.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  dept       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_unique ON participants(name, dept);

CREATE TABLE IF NOT EXISTS prizes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT '幸运奖',
  icon       TEXT NOT NULL DEFAULT '🎁',
  quantity   INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draws (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  prize_id         INTEGER NOT NULL,
  prize_name       TEXT NOT NULL,
  prize_level      TEXT NOT NULL DEFAULT '',
  prize_icon       TEXT NOT NULL DEFAULT '',
  participant_id   INTEGER NOT NULL,
  participant_name TEXT NOT NULL,
  participant_dept TEXT NOT NULL DEFAULT '',
  pool_size        INTEGER NOT NULL,
  pool_hash        TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  prev_hash        TEXT NOT NULL,
  hash             TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draws_prize ON draws(prize_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);

const getMeta = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
};
const setMeta = (key, value) => {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
};

const allowRepeat = () => getMeta('allow_repeat', '0') === '1';

function withTx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function prizeWithProgress(prize) {
  const won = db.prepare('SELECT COUNT(*) AS c FROM draws WHERE prize_id = ?').get(prize.id).c;
  return {
    ...prize,
    won,
    remaining: Math.max(0, prize.quantity - won),
    finished: won >= prize.quantity,
  };
}

function listPrizes() {
  return db
    .prepare('SELECT * FROM prizes ORDER BY sort_order ASC, id ASC')
    .all()
    .map(prizeWithProgress);
}

function candidatesForDraw() {
  if (allowRepeat()) {
    return db.prepare('SELECT * FROM participants ORDER BY id ASC').all();
  }
  return db
    .prepare(
      'SELECT * FROM participants WHERE id NOT IN (SELECT participant_id FROM draws) ORDER BY id ASC'
    )
    .all();
}

function stats() {
  const prizes = listPrizes();
  const participants = db.prepare('SELECT COUNT(*) AS c FROM participants').get().c;
  const drawn = db.prepare('SELECT COUNT(*) AS c FROM draws').get().c;
  const winners = db.prepare('SELECT COUNT(DISTINCT participant_id) AS c FROM draws').get().c;
  const totalStock = prizes.reduce((sum, p) => sum + p.quantity, 0);
  return {
    participants,
    drawn,
    winners,
    prizeCount: prizes.length,
    totalStock,
    remainingStock: Math.max(0, totalStock - drawn),
    poolSize: candidatesForDraw().length,
    allowRepeat: allowRepeat(),
  };
}

function recentWinners(limit = 30) {
  return db
    .prepare('SELECT * FROM draws ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      id: row.id,
      prizeId: row.prize_id,
      prizeName: row.prize_name,
      prizeLevel: row.prize_level,
      prizeIcon: row.prize_icon,
      participantId: row.participant_id,
      participantName: row.participant_name,
      participantDept: row.participant_dept,
      createdAt: row.created_at,
      hash: row.hash,
      shortHash: row.hash.slice(0, 10),
    }));
}

/* ------------------------------- 抽奖核心 ------------------------------- */

function drawPrize(prizeId) {
  return withTx(() => {
    const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(prizeId);
    if (!prize) throw new HttpError(404, '奖品不存在，请先添加奖品');

    const wonCount = db.prepare('SELECT COUNT(*) AS c FROM draws WHERE prize_id = ?').get(prize.id).c;
    if (wonCount >= prize.quantity) {
      throw new HttpError(400, `「${prize.name}」的 ${prize.quantity} 个名额已抽完`);
    }

    const pool = candidatesForDraw();
    if (pool.length === 0) {
      throw new HttpError(400, '没有可参与抽奖的人员了，请检查名单或开启“允许重复中奖”');
    }

    // 候选池快照：可用于第三方复算
    const poolHash = sha256(pool.map((p) => `${p.id}:${p.name}:${p.dept}`).join('|'));

    // crypto.randomInt 为均匀分布（拒绝采样，无取模偏差）
    const index = crypto.randomInt(pool.length);
    const winner = pool[index];

    const createdAt = nowIso();
    const nonce = crypto.randomBytes(12).toString('hex');
    const prevHash = getMeta('chain_head', GENESIS);

    const payload = [
      prevHash,
      prize.id,
      prize.name,
      winner.id,
      winner.name,
      pool.length,
      poolHash,
      nonce,
      createdAt,
    ].join('|');
    const hash = sha256(payload);

    db.prepare(
      `INSERT INTO draws (prize_id, prize_name, prize_level, prize_icon, participant_id,
        participant_name, participant_dept, pool_size, pool_hash, nonce, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      prize.id, prize.name, prize.level, prize.icon, winner.id,
      winner.name, winner.dept, pool.length, poolHash, nonce, prevHash, hash, createdAt
    );

    setMeta('chain_head', hash);

    return {
      winner: { id: winner.id, name: winner.name, dept: winner.dept },
      prize: { id: prize.id, name: prize.name, level: prize.level, icon: prize.icon },
      poolSize: pool.length,
      poolHash,
      prevHash,
      hash,
      createdAt,
    };
  });
}

/* --------------------------------- 路由 --------------------------------- */

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

app.get('/api/overview', wrap((req, res) => {
  const latest = db.prepare('SELECT id FROM draws ORDER BY id DESC LIMIT 1').get();
  res.json({
    stats: stats(),
    prizes: listPrizes(),
    latestDrawId: latest ? latest.id : 0,
    winners: recentWinners(20),
  });
}));

app.get('/api/winners', wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({ winners: recentWinners(limit), total: db.prepare('SELECT COUNT(*) AS c FROM draws').get().c });
}));

app.get('/api/display', wrap((req, res) => {
  const winners = recentWinners(15);
  res.json({
    stats: stats(),
    prizes: listPrizes(),
    winners,
    latest: winners[0] || null,
  });
}));

app.get('/api/participants', wrap((req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM draws d WHERE d.participant_id = p.id) AS winCount
       FROM participants p ORDER BY p.id ASC`
    )
    .all();
  res.json({ participants: rows, total: rows.length });
}));

app.post('/api/participants', wrap((req, res) => {
  const raw = req.body && (req.body.names !== undefined ? req.body.names : req.body.text);
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, '请填写参赛人员名单');

  const lines = raw.split(/\r?\n/);
  const insert = db.prepare('INSERT OR IGNORE INTO participants(name, dept, created_at) VALUES(?,?,?)');
  let added = 0;
  let skipped = 0;

  withTx(() => {
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      const [name, ...rest] = text.split(/[,，\t;；|]+/).map((s) => s.trim());
      if (!name) continue;
      const dept = rest.join(' ').trim();
      const result = insert.run(name, dept, nowIso());
      if (result.changes > 0) added += 1;
      else skipped += 1;
    }
  });

  res.json({ added, skipped, total: db.prepare('SELECT COUNT(*) AS c FROM participants').get().c });
}));

app.delete('/api/participants/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT COUNT(*) AS c FROM draws WHERE participant_id = ?').get(id).c > 0) {
    throw new HttpError(400, '该人员已中奖，为保留审计记录不可删除');
  }
  db.prepare('DELETE FROM participants WHERE id = ?').run(id);
  res.json({ ok: true });
}));

app.post('/api/participants/clear', wrap((req, res) => {
  const drawn = db.prepare('SELECT COUNT(*) AS c FROM draws').get().c;
  if (drawn > 0 && !req.body?.force) {
    throw new HttpError(400, '已存在中奖记录，清空名单会破坏审计链，请先清空中奖记录');
  }
  withTx(() => {
    db.prepare('DELETE FROM participants').run();
    db.prepare('DELETE FROM draws').run();
    setMeta('chain_head', GENESIS);
  });
  res.json({ ok: true });
}));

app.post('/api/prizes', wrap((req, res) => {
  const { name, level = '幸运奖', icon = '🎁', quantity = 1 } = req.body || {};
  if (!name || !String(name).trim()) throw new HttpError(400, '请填写奖品名称');
  const qty = Math.max(1, Math.min(Number(quantity) || 1, 9999));
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prizes').get().m;
  const result = db
    .prepare('INSERT INTO prizes(name, level, icon, quantity, sort_order, created_at) VALUES(?,?,?,?,?,?)')
    .run(String(name).trim(), String(level).trim(), String(icon).trim() || '🎁', qty, maxSort + 1, nowIso());
  const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(Number(result.lastInsertRowid));
  res.json({ prize: prizeWithProgress(prize) });
}));

app.put('/api/prizes/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(id);
  if (!prize) throw new HttpError(404, '奖品不存在');

  const won = db.prepare('SELECT COUNT(*) AS c FROM draws WHERE prize_id = ?').get(id).c;
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : prize.name;
  const level = req.body?.level !== undefined ? String(req.body.level).trim() : prize.level;
  const icon = req.body?.icon !== undefined ? String(req.body.icon).trim() : prize.icon;
  const quantity =
    req.body?.quantity !== undefined
      ? Math.max(1, Math.min(Number(req.body.quantity) || 1, 9999))
      : prize.quantity;

  if (!name) throw new HttpError(400, '奖品名称不能为空');
  if (quantity < won) throw new HttpError(400, `已抽出 ${won} 个，数量不能小于 ${won}`);

  db.prepare('UPDATE prizes SET name = ?, level = ?, icon = ?, quantity = ? WHERE id = ?').run(
    name, level, icon || '🎁', quantity, id
  );
  res.json({ prize: prizeWithProgress(db.prepare('SELECT * FROM prizes WHERE id = ?').get(id)) });
}));

app.delete('/api/prizes/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const won = db.prepare('SELECT COUNT(*) AS c FROM draws WHERE prize_id = ?').get(id).c;
  if (won > 0) throw new HttpError(400, '该奖品已有中奖记录，不可删除');
  db.prepare('DELETE FROM prizes WHERE id = ?').run(id);
  res.json({ ok: true });
}));

app.get('/api/pool', wrap((req, res) => {
  const pool = candidatesForDraw();
  res.json({
    poolSize: pool.length,
    names: pool.map((p) => ({ name: p.name, dept: p.dept })),
    poolHash: sha256(pool.map((p) => `${p.id}:${p.name}:${p.dept}`).join('|')),
  });
}));

app.post('/api/draw', wrap((req, res) => {
  const prizeId = Number(req.body?.prizeId);
  if (!prizeId) throw new HttpError(400, '请先选择奖品');
  const result = drawPrize(prizeId);
  res.json({ ...result, stats: stats() });
}));

app.get('/api/audit', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM draws ORDER BY id ASC').all();
  let prev = GENESIS;
  const items = rows.map((row) => {
    const payload = [
      row.prev_hash,
      row.prize_id,
      row.prize_name,
      row.participant_id,
      row.participant_name,
      row.pool_size,
      row.pool_hash,
      row.nonce,
      row.created_at,
    ].join('|');
    const recomputed = sha256(payload);
    const linkedOk = row.prev_hash === prev;
    const hashOk = recomputed === row.hash;
    prev = row.hash;
    return {
      id: row.id,
      participantName: row.participant_name,
      participantDept: row.participant_dept,
      prizeName: row.prize_name,
      poolSize: row.pool_size,
      createdAt: row.created_at,
      prevHash: row.prev_hash,
      hash: row.hash,
      recomputed,
      linkedOk,
      hashOk,
      valid: linkedOk && hashOk,
    };
  });

  res.json({
    total: items.length,
    head: getMeta('chain_head', GENESIS),
    valid: items.every((i) => i.valid),
    items,
  });
}));

app.get('/api/settings', wrap((req, res) => {
  res.json({ allowRepeat: allowRepeat() });
}));

app.put('/api/settings', wrap((req, res) => {
  if (req.body?.allowRepeat !== undefined) {
    setMeta('allow_repeat', req.body.allowRepeat ? '1' : '0');
  }
  res.json({ allowRepeat: allowRepeat() });
}));

app.post('/api/reset', wrap((req, res) => {
  const target = req.body?.target;
  if (!['draws', 'prizes', 'participants', 'all'].includes(target)) {
    throw new HttpError(400, '未知的重置范围');
  }
  withTx(() => {
    if (target === 'draws' || target === 'all') {
      db.prepare('DELETE FROM draws').run();
      setMeta('chain_head', GENESIS);
    }
    if (target === 'prizes' || target === 'all') db.prepare('DELETE FROM prizes').run();
    if (target === 'participants' || target === 'all') db.prepare('DELETE FROM participants').run();
  });
  res.json({ ok: true });
}));

app.get('/api/export.csv', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM draws ORDER BY id ASC').all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['序号', '中奖时间', '奖品', '奖项等级', '姓名', '部门', '候选人数', '记录哈希'].join(',')];
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        esc(new Date(r.created_at).toLocaleString('zh-CN', { hour12: false })),
        esc(r.prize_name),
        esc(r.prize_level),
        esc(r.participant_name),
        esc(r.participant_dept),
        r.pool_size,
        r.hash,
      ].join(',')
    );
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lottery-winners.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
}));

app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器异常' });
});

app.listen(PORT, () => {
  console.log(`\n🎉 抽奖系统已启动`);
  console.log(`   控制台：  http://localhost:${PORT}/`);
  console.log(`   公共大屏：http://localhost:${PORT}/display.html\n`);
});
