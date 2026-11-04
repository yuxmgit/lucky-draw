# 抽奖系统 · Windows 本地一键发布
#
# 服务器装了宝塔面板（推荐，需带 -Baota）：
#   .\deploy\publish.ps1 -ServerHost 1.2.3.4 -Baota
#
# 纯净服务器（没有宝塔）：
#   .\deploy\publish.ps1 -ServerHost 1.2.3.4
#
# 后续日常更新：命令与首次相同，会自动保留线上数据
#
# 想把本地现有数据一起搬上去（仅首次使用，会覆盖线上数据）：
#   .\deploy\publish.ps1 -ServerHost 1.2.3.4 -Baota -WithData
#
# 前提：本机有 OpenSSH（Win10+ 自带），且能免密 sudo 登录服务器。
# 腾讯云 Ubuntu 镜像的默认用户是 ubuntu；如果是 root 登录，加 -User root。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerHost,
    [string]$User = "ubuntu",
    [string]$AppDir = "",
    [int]$Port = 22,
    [switch]$WithData,
    [switch]$Baota,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

# 宝塔模式的代码目录是面板的网站根目录；
# 普通模式走 /opt，由 systemd 托管。
if ([string]::IsNullOrWhiteSpace($AppDir)) {
    $AppDir = if ($Baota) { "/www/wwwroot/lucky-draw" } else { "/opt/lucky-draw" }
}

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m" -ForegroundColor Red; exit 1 }

$projectRoot = Split-Path -Parent $PSScriptRoot
$remote = "$User@$ServerHost"

# ---------------------------------------------------------------- 0. 前置检查
Step "检查本机工具"
foreach ($c in @("tar", "scp", "ssh")) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
        Die "缺少命令 $c，请安装 OpenSSH 客户端"
    }
}
Ok "tar / scp / ssh 可用"

if (-not (Test-Path (Join-Path $projectRoot "server.js"))) {
    Die "找不到 server.js，请确认脚本位于 lucky-draw\deploy 目录下"
}

# ---------------------------------------------------------------- 1. 打包
Step "打包源码"
$pkg = Join-Path $env:TEMP "lucky-draw.tar.gz"
if (Test-Path $pkg) { Remove-Item $pkg -Force }

$excludes = @(
    "--exclude=node_modules",
    "--exclude=.git",
    "--exclude=backups",
    "--exclude=*.log",
    "--exclude=.DS_Store",
    "--exclude=.playwright-cli",
    "--exclude=.vscode",
    "--exclude=.idea"
)
if (-not $WithData) { $excludes += "--exclude=data" }

& tar -czf $pkg @excludes -C $projectRoot .
if ($LASTEXITCODE -ne 0) { Die "打包失败" }

$sizeMB = [math]::Round((Get-Item $pkg).Length / 1MB, 2)
Ok "已打包 ${sizeMB} MB$(if (-not $WithData) { '（不含 data 目录）' } else { '（含 data 目录）' })"

if ($WithData) {
    Warn "你选择了 -WithData：线上现有数据库会先自动备份，然后用本地数据覆盖"
}

# ---------------------------------------------------------------- 2. 生成远端脚本
Step "准备远端部署脚本"
$remoteScript = @'
set -Eeuo pipefail
APP_DIR="__APP_DIR__"
SERVICE="lucky-draw"
PKG="/tmp/lucky-draw.tar.gz"
WITH_DATA="__WITH_DATA__"
BAOTA="__BAOTA__"

echo "--> 解压到 $APP_DIR"
mkdir -p "$APP_DIR"

# 已上线且要覆盖数据时，先做一次安全备份
if [[ "$WITH_DATA" == "1" && -f "$APP_DIR/server.js" ]]; then
    if [[ -f "$APP_DIR/deploy/backup.sh" ]]; then
        bash "$APP_DIR/deploy/backup.sh" || echo "  [!] 备份失败，继续"
    fi
fi

if [[ "$WITH_DATA" == "1" ]]; then
    tar -xzf "$PKG" -C "$APP_DIR" --exclude='./backups' --exclude='./logs'
else
    # 关键：排除 data，绝不能用本地测试库覆盖线上中奖记录
    tar -xzf "$PKG" -C "$APP_DIR" --exclude='./data' --exclude='./backups' --exclude='./logs'
fi

echo "--> 修正换行符"
sed -i 's/\r$//' "$APP_DIR"/deploy/*.sh 2>/dev/null || true
chmod +x "$APP_DIR"/deploy/*.sh 2>/dev/null || true

# --- 宝塔模式：进程交给 PM2，Nginx 与防火墙由面板管理 ---
if [[ "$BAOTA" == "1" ]]; then
    echo "--> 宝塔模式：准备运行环境并重启 PM2 进程"
    bash "$APP_DIR/deploy/install-baota.sh" "$APP_DIR"
    exit $?
fi

if [[ ! -f /etc/systemd/system/$SERVICE.service ]]; then
    echo "--> 首次部署，执行服务器初始化"
    bash "$APP_DIR/deploy/install-server.sh"
    exit 0
fi

echo "--> 安装依赖"
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R lucky:lucky "$APP_DIR"
cd "$APP_DIR"
sudo -u lucky npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
    || sudo -u lucky npm install --omit=dev --no-audit --no-fund >/dev/null

echo "--> 重启服务"
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || echo 000)"
    echo "  服务正常，本地探测 HTTP $CODE"
else
    echo "  服务启动失败，最近日志："
    journalctl -u "$SERVICE" -n 30 --no-pager
    exit 1
fi
'@

$remoteScript = $remoteScript.Replace("__APP_DIR__", $AppDir)
$remoteScript = $remoteScript.Replace("__WITH_DATA__", $(if ($WithData) { "1" } else { "0" }))
$remoteScript = $remoteScript.Replace("__BAOTA__", $(if ($Baota) { "1" } else { "0" }))

$remoteScriptPath = Join-Path $env:TEMP "lucky-draw-remote.sh"
# 远端脚本必须是 LF 换行，否则 bash 会因 \r 报错
$remoteScript -replace "`r`n", "`n" | Set-Content -Path $remoteScriptPath -NoNewline -Encoding ascii
Ok "远端脚本已生成"

# ---------------------------------------------------------------- 3. 上传
Step "上传到 $ServerHost"
& scp -P $Port -o StrictHostKeyChecking=accept-new $pkg "${remote}:/tmp/lucky-draw.tar.gz"
if ($LASTEXITCODE -ne 0) { Die "上传失败，检查服务器地址、用户名与网络" }

& scp -P $Port -o StrictHostKeyChecking=accept-new $remoteScriptPath "${remote}:/tmp/lucky-draw-remote.sh"
if ($LASTEXITCODE -ne 0) { Die "上传部署脚本失败" }
Ok "文件已上传"

# ---------------------------------------------------------------- 4. 远端执行
Step "在服务器上执行部署"
& ssh -p $Port -o StrictHostKeyChecking=accept-new $remote "sudo bash /tmp/lucky-draw-remote.sh"
if ($LASTEXITCODE -ne 0) { Die "远端部署失败，请查看上面的输出" }
Ok "部署脚本执行完成"

# ---------------------------------------------------------------- 5. 验证
Step "从本机验证访问"
try {
    $resp = Invoke-WebRequest -Uri "http://$ServerHost/" -UseBasicParsing -TimeoutSec 10
    Ok "HTTP $($resp.StatusCode)，首页大小 $($resp.RawContentLength) 字节"
    if ($resp.StatusCode -eq 401) {
        Warn "返回 401 说明访问密码已生效，浏览器打开时会要求输入（用户名 lucky）"
    }
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Ok "返回 401：反向代理与访问密码均已生效"
    } else {
        Warn "本机访问失败（$($_.Exception.Message)）"
        if ($Baota) {
            Warn "宝塔模式：请先在面板里给站点添加反向代理（目标 http://127.0.0.1:3000）"
            Warn "同时确认云控制台「安全组」放行了 80 端口"
        } else {
            Warn "如果服务器在国内云上，请确认云控制台的「安全组」已放行 80 端口"
        }
    }
}

Write-Host "`n发布完成" -ForegroundColor Green

if ($Baota) {
    Write-Host "  代码目录：$AppDir（PM2 进程名 lucky-draw）"
    Write-Host ""
    Write-Host "  宝塔面板里还需要 3 步（只需配置一次）：" -ForegroundColor Yellow
    Write-Host "    1. 网站 → 添加站点，根目录填 $AppDir"
    Write-Host "    2. 站点设置 → 反向代理 → 目标 URL 填 http://127.0.0.1:3000"
    Write-Host "    3. 站点设置 → 访问限制 → 开启密码（这个应用没有登录功能，必须加）"
    Write-Host ""
    Write-Host "  详细步骤见 deploy/baota.md"
} else {
    Write-Host "  控制台：  http://$ServerHost/"
    Write-Host "  公共大屏：http://$ServerHost/display.html"
    Write-Host "  访问密码：ssh $remote 'sudo cat $AppDir/deploy/.access.txt'"
}
