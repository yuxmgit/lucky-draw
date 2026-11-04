#!/usr/bin/env bash
#
# 抽奖系统 · 数据备份
#
# 用法：
#   sudo bash /opt/lucky-draw/deploy/backup.sh
#   KEEP_DAYS=60 sudo bash /opt/lucky-draw/deploy/backup.sh
#
# 为什么不能直接 cp data/lottery.db？
#   数据库开启了 WAL 模式，最近的写入可能还在 lottery.db-wal 里没合并进主文件。
#   直接复制主文件会得到「少了一部分中奖记录」的库。
#   这里用 SQLite 的 VACUUM INTO 生成一致性快照，是官方推荐的在线备份方式。
#
set -Eeuo pipefail

if grep -q $'\r' "$0" 2>/dev/null; then
    sed -i 's/\r$//' "$0"
    exec bash "$0" "$@"
fi

APP_DIR="/opt/lucky-draw"
DB="${APP_DIR}/data/lottery.db"
BACKUP_DIR="${APP_DIR}/backups"
KEEP_DAYS="${KEEP_DAYS:-30}"
NODE_BIN="/usr/bin/node"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
die() { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请用 root 运行：sudo bash $0"
[[ -f "${DB}" ]] || die "数据库不存在：${DB}"
[[ -x "${NODE_BIN}" ]] || die "找不到 node：${NODE_BIN}"

mkdir -p "${BACKUP_DIR}"
STAMP="$(date '+%Y%m%d-%H%M%S')"
OUT="${BACKUP_DIR}/lottery-${STAMP}.db"

log "生成一致性快照"
"${NODE_BIN}" - "${DB}" "${OUT}" <<'NODE'
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const [src, dst] = process.argv.slice(2);
if (fs.existsSync(dst)) fs.unlinkSync(dst);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
db.close();
NODE

[[ -s "${OUT}" ]] || die "备份文件为空，请检查数据库状态"
gzip -f "${OUT}"
SIZE="$(du -h "${OUT}.gz" | cut -f1)"
ok "已备份：${OUT}.gz（${SIZE}）"

log "清理 ${KEEP_DAYS} 天前的旧备份"
DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'lottery-*.db.gz' -type f -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
ok "清理了 ${DELETED} 个旧文件"

printf '\n最近 5 份备份：\n'
ls -lh "${BACKUP_DIR}"/lottery-*.db.gz 2>/dev/null | tail -5 | awk '{print "  " $9 "  " $5 "  " $6 " " $7 " " $8}' || true
printf '\n恢复方法：\n'
printf '  sudo systemctl stop lucky-draw\n'
printf '  sudo gunzip -c %s/lottery-YYYYmmdd-HHMMSS.db.gz > /opt/lucky-draw/data/lottery.db\n' "${BACKUP_DIR}"
printf '  sudo rm -f /opt/lucky-draw/data/lottery.db-wal /opt/lucky-draw/data/lottery.db-shm\n'
printf '  sudo chown lucky:lucky /opt/lucky-draw/data/lottery.db\n'
printf '  sudo systemctl start lucky-draw\n\n'
