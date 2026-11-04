#!/usr/bin/env bash
#
# 抽奖系统 · 宝塔面板专用安装脚本
#
# 只做三件事：装 Node 运行时、装依赖、用 PM2 把进程跑起来。
# 不碰 Nginx、不碰防火墙、不改 systemd —— 这些宝塔面板自己管，
# 硬改会和面板打架（80 端口抢占、站点配置被覆盖）。
#
# 用法（代码已上传到 /www/wwwroot/lucky-draw 之后）：
#   sudo bash /www/wwwroot/lucky-draw/deploy/install-baota.sh
#
# 装完之后还需要在宝塔面板里做 3 步（见 deploy/baota.md）：
#   1. 建站点，把网站目录指到 /www/wwwroot/lucky-draw
#   2. 设置反向代理到 http://127.0.0.1:3000
#   3. 开启「访问限制」设置密码 + 申请 SSL
#
set -Eeuo pipefail

if grep -q $'\r' "$0" 2>/dev/null; then
    sed -i 's/\r$//' "$0"
    exec bash "$0" "$@"
fi

APP_DIR="${1:-/www/wwwroot/lucky-draw}"
SERVICE_NAME="lucky-draw"
NODE_BIN="/usr/bin/node"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请用 root 运行：sudo bash $0"
[[ -f "${APP_DIR}/server.js" ]] || die "${APP_DIR}/server.js 不存在，请先上传代码"
[[ -f "${APP_DIR}/deploy/ecosystem.config.js" ]] || die "缺少 deploy/ecosystem.config.js"

if [[ -d /www/server/panel ]]; then
    ok "已检测到宝塔面板（Nginx 与防火墙交给面板管理）"
else
    warn "未检测到宝塔面板，本脚本仍可继续（只是不会用到面板功能）"
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- 1. Node.js
node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    local v major minor
    v="$(node -v)"; v="${v#v}"
    major="${v%%.*}"
    minor="$(printf '%s' "$v" | cut -d. -f2)"
    [[ "${major}" -ge 24 ]] || { [[ "${major}" -eq 23 && "${minor}" -ge 4 ]]; }
}

if node_ok && node -e "require('node:sqlite')" >/dev/null 2>&1; then
    ok "已安装 $(node -v)，满足要求（node:sqlite 可用）"
else
    log "安装 Node.js 24 LTS（项目依赖 node:sqlite，低版本直接启动失败）"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh \
        || die "下载 NodeSource 源失败，请检查服务器网络"
    bash /tmp/nodesource_setup.sh >/dev/null 2>&1 || die "添加 NodeSource 源失败"
    apt-get install -y -qq nodejs >/dev/null
    node_ok || die "Node 版本仍不满足（当前 $(node -v 2>/dev/null || echo 无)），需要 >= 23.4"
    ok "已安装 $(node -v)"
fi

[[ -x "${NODE_BIN}" ]] || NODE_BIN="$(command -v node)"

# ---------------------------------------------------------------- 2. 目录与权限
log "准备目录"
mkdir -p "${APP_DIR}/data" "${APP_DIR}/backups" "${APP_DIR}/logs"
# 宝塔的文件默认属主是 www，保持一致，方便面板里查看和编辑
chown -R www:www "${APP_DIR}" 2>/dev/null || warn "无法设置 www 属主（当前系统可能没有 www 用户）"
chmod 755 "${APP_DIR}"
ok "目录就绪：${APP_DIR}"

# ---------------------------------------------------------------- 3. 依赖
log "安装生产依赖"
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
        || npm install --omit=dev --no-audit --no-fund >/dev/null
else
    npm install --omit=dev --no-audit --no-fund >/dev/null
fi
ok "依赖安装完成"

# ---------------------------------------------------------------- 4. PM2
if ! command -v pm2 >/dev/null 2>&1; then
    log "安装 PM2 进程守护"
    npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1 || die "PM2 安装失败"
fi
ok "PM2 $(pm2 -v 2>/dev/null | tail -1)"

# ---------------------------------------------------------------- 5. 启动
log "启动应用"
pm2 delete "${SERVICE_NAME}" >/dev/null 2>&1 || true
pm2 start "${APP_DIR}/deploy/ecosystem.config.js" --update-env >/dev/null 2>&1 \
    || die "PM2 启动失败，执行 pm2 logs ${SERVICE_NAME} 查看原因"
pm2 save >/dev/null 2>&1
# 开机自启（失败不影响当前运行）
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || warn "开机自启未配置成功，可手动执行 pm2 startup"

sleep 2
if curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
    ok "进程运行中，本地探测 http://127.0.0.1:3000/ 返回 200"
else
    warn "本地探测失败，查看日志：pm2 logs ${SERVICE_NAME} --lines 50"
fi

pm2 status

# ---------------------------------------------------------------- 6. 收尾提示
cat <<EOF

────────────────────────────────────────────────────────
后端进程已就绪，接下来在宝塔面板里完成 3 步：

 1. 网站 → 添加站点
    域名填你的域名（没有域名可先填服务器 IP）
    根目录填：${APP_DIR}
    不要勾选 PHP、不要创建数据库

 2. 该站点 → 设置 → 反向代理 → 添加反向代理
    代理名称：api
    目标 URL：http://127.0.0.1:3000
    发送域名：\$host

 3. 该站点 → 设置 → 访问限制 → 开启密码访问
    这个应用没有登录功能，不加密码等于把抽奖后台交给所有人

 可选：该站点 → SSL → Let's Encrypt → 申请（需要域名已解析）
       申请后开启「强制 HTTPS」

详细图文步骤见：${APP_DIR}/deploy/baota.md
────────────────────────────────────────────────────────
EOF
