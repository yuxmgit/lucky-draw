#!/usr/bin/env bash
#
# 抽奖系统 · 服务器环境初始化（只需执行一次）
#
# 用法（在服务器上，代码已经上传到 /opt/lucky-draw 之后）：
#   sudo bash /opt/lucky-draw/deploy/install-server.sh
#
# 它会完成：
#   1. 安装 Node.js 24（项目依赖 node:sqlite，低版本直接起不来）
#   2. 创建专用系统用户 lucky，避免用 root 跑 Web 服务
#   3. 安装 systemd 单元，开机自启 + 崩溃自动拉起
#   4. 安装 Nginx 反向代理，并生成随机访问密码
#   5. 开启防火墙，只放行 22 / 80 / 443
#
set -Eeuo pipefail

# --- 兼容从 Windows 传上来的 CRLF 换行（否则会报 $'\r': command not found）---
if grep -q $'\r' "$0" 2>/dev/null; then
    sed -i 's/\r$//' "$0"
    exec bash "$0" "$@"
fi

APP_DIR="/opt/lucky-draw"
APP_USER="lucky"
SERVICE="lucky-draw"
HTPASSWD="/etc/nginx/.htpasswd-lucky"
CRED_FILE="${APP_DIR}/deploy/.access.txt"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请用 root 运行：sudo bash $0"
[[ -f "${APP_DIR}/server.js" ]] || die "${APP_DIR}/server.js 不存在，请先用 publish.ps1 上传代码"
[[ -f "${APP_DIR}/deploy/lucky-draw.service" ]] || die "缺少 deploy/lucky-draw.service"

# --- 宝塔面板拦截 ---
# 宝塔自己管理 Nginx（编译安装、站点配置在 /www/server/panel/vhost）、
# 防火墙和 systemd 服务。本脚本会安装系统 nginx 并改写 /etc/nginx，
# 在宝塔机器上会抢占 80 端口、导致面板里的站点全部失效。
if [[ -d /www/server/panel ]] || command -v bt >/dev/null 2>&1; then
    die "检测到宝塔面板，请勿使用本脚本。
  改用宝塔专用脚本：sudo bash ${APP_DIR}/deploy/install-baota.sh
  或按 ${APP_DIR}/deploy/baota.md 在面板里操作"
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- 1. 系统依赖
log "安装系统依赖（nginx / curl / openssl / ufw）"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg nginx apache2-utils openssl ufw >/dev/null
ok "系统依赖就绪"

# ---------------------------------------------------------------- 2. Node.js
# 关键：node:sqlite 在 22.5 引入时还需要 --experimental-sqlite 开关，
# 直到 23.4 才默认可用。所以这里要求 >= 23.4，推荐 24 LTS。
node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    local v major minor
    v="$(node -v)"; v="${v#v}"
    major="${v%%.*}"
    minor="$(printf '%s' "$v" | cut -d. -f2)"
    [[ "${major}" -ge 24 ]] || { [[ "${major}" -eq 23 && "${minor}" -ge 4 ]]; }
}

if node_ok && node -e "require('node:sqlite')" >/dev/null 2>&1; then
    ok "已安装 $(node -v)，满足要求"
else
    log "安装 Node.js 24 LTS"
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh \
        || die "下载 NodeSource 源失败，请检查服务器网络"
    bash /tmp/nodesource_setup.sh >/dev/null 2>&1 || die "添加 NodeSource 源失败"
    apt-get install -y -qq nodejs >/dev/null
    node_ok || die "Node 安装后版本仍不满足（当前 $(node -v 2>/dev/null || echo 无)），需要 >= 23.4"
    ok "已安装 $(node -v)"
fi

node -e "require('node:sqlite')" >/dev/null 2>&1 \
    || die "当前 Node 不支持内置 sqlite（node:sqlite），请升级到 24 LTS"

# ---------------------------------------------------------------- 3. 运行用户
if id -u "${APP_USER}" >/dev/null 2>&1; then
    ok "用户 ${APP_USER} 已存在"
else
    log "创建系统用户 ${APP_USER}"
    useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
    ok "用户 ${APP_USER} 已创建"
fi

log "整理目录与权限"
mkdir -p "${APP_DIR}/data" "${APP_DIR}/backups"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 750 "${APP_DIR}/data"
ok "目录权限已设置"

# ---------------------------------------------------------------- 4. 依赖
log "安装生产依赖（npm ci）"
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then
    sudo -u "${APP_USER}" npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
        || sudo -u "${APP_USER}" npm install --omit=dev --no-audit --no-fund >/dev/null
else
    sudo -u "${APP_USER}" npm install --omit=dev --no-audit --no-fund >/dev/null
fi
ok "依赖安装完成"

# ---------------------------------------------------------------- 5. 访问密码
if [[ -f "${HTPASSWD}" ]]; then
    ok "访问密码已存在，保持不变（如需重置：sudo htpasswd -c ${HTPASSWD} lucky）"
else
    log "生成随机访问密码"
    PASS="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"
    htpasswd -bc "${HTPASSWD}" lucky "${PASS}" >/dev/null
    chmod 640 "${HTPASSWD}"
    chown root:www-data "${HTPASSWD}" 2>/dev/null || true
    {
        echo "抽奖系统访问凭据（生成于 $(date '+%Y-%m-%d %H:%M:%S')）"
        echo "用户名: lucky"
        echo "密码:   ${PASS}"
        echo
        echo "修改密码: sudo htpasswd -c ${HTPASSWD} lucky"
        echo "关闭密码: 编辑 /etc/nginx/conf.d/lucky-draw.conf，注释 auth_basic 两行后 nginx -s reload"
    } > "${CRED_FILE}"
    chmod 600 "${CRED_FILE}"
    ok "密码已生成，保存在 ${CRED_FILE}"
fi

# ---------------------------------------------------------------- 6. systemd
log "安装 systemd 服务"
install -m 644 "${APP_DIR}/deploy/lucky-draw.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1
ok "服务已注册并设为开机自启"

# ---------------------------------------------------------------- 7. Nginx
log "安装 Nginx 配置"
install -m 644 "${APP_DIR}/deploy/nginx-lucky-draw.conf" /etc/nginx/conf.d/lucky-draw.conf
# Ubuntu 默认站点会抢占 80 端口，导致我们的 server 块不生效
[[ -L /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "Nginx 配置校验失败，执行 nginx -t 查看详情"
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx
ok "Nginx 已加载新配置"

# ---------------------------------------------------------------- 8. 防火墙
log "配置防火墙"
ufw allow 22/tcp  >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ok "防火墙已放行 22 / 80 / 443（3000 端口不对外开放）"

# ---------------------------------------------------------------- 9. 收尾
log "启动服务"
systemctl restart "${SERVICE}"
sleep 2
if systemctl is-active --quiet "${SERVICE}"; then
    ok "服务运行中"
else
    warn "服务未能启动，查看日志：journalctl -u ${SERVICE} -n 50 --no-pager"
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
printf '\n\033[1;32m部署完成\033[0m\n'
printf '  控制台：  http://%s/\n' "${IP}"
printf '  公共大屏：http://%s/display.html\n' "${IP}"
if [[ -f "${CRED_FILE}" ]]; then
    printf '  访问密码：\n'
    sed 's/^/    /' "${CRED_FILE}"
fi
printf '\n  别忘了在云厂商控制台的「安全组」里同样放行 80 端口。\n\n'
