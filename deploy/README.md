# 抽奖系统 · 部署指南

从一台空白服务器到公网可访问，全程约 10 分钟。

> **服务器装了宝塔面板？** 请先看 [宝塔部署指南](baota.md)。
> 本文的 `install-server.sh` 会安装系统 Nginx 并抢占 80 端口，在宝塔机器上会导致面板里的站点全部失效。
> 宝塔环境只需要一条命令：`.\deploy\publish.ps1 -ServerHost 你的IP -Baota`

---

## 0. 动手前必须知道的 3 个事实

**① 抽奖页公开，管理后台需要登录，默认账号密码都是 `admin`**

`/` 与 `/display.html` 任何人可访问（只能抽奖和查看）；奖品、名单、记录等管理操作在 `/admin`，未登录会跳转到 `/login`。默认值只适合内网演示，**公网部署必须改掉**，在 systemd / PM2 的环境变量或 `.env` 里设置：

```bash
Environment=ADMIN_USER=admin
Environment=ADMIN_PASSWORD=换成强密码
Environment=SESSION_SECRET=一串随机字符
```

`install-server.sh` 会顺带生成一份 Nginx Basic Auth 密码文件（用户名 `lucky`），但**默认不启用**——抽奖页要公开放给参与者，整站加密码会把所有人都拦在门外。需要额外一层防护时，取消 `nginx-lucky-draw.conf` 里 `location = /admin` 那段的注释即可。

**② Node.js 必须 ≥ 23.4**

项目用的是 Node 内置的 `node:sqlite`：

| Node 版本 | 能否直接用 |
|---|---|
| 22.5 ~ 23.3 | 需要加 `--experimental-sqlite` 启动参数，`npm start` 会直接报错 |
| **≥ 23.4（推荐 24 LTS）** | 开箱可用 |

服务器上装错版本，症状是 `Cannot find module 'node:sqlite'`。`install-server.sh` 会自动检查并拦截。

**③ 数据是单文件 SQLite，且开了 WAL**

`data/lottery.db` 是主文件，但**最近的写入可能还在 `lottery.db-wal` 里**。
直接 `cp lottery.db` 备份会丢最新记录——必须用本方案提供的 `backup.sh`（内部用 `VACUUM INTO` 生成一致性快照）。

---

## 1. 准备服务器

### 配置建议

| 项目 | 建议 | 说明 |
|---|---|---|
| CPU / 内存 | 2 核 2G 起 | 单进程 Node，2 核 2G 足够几十人同时用 |
| 系统 | Ubuntu 22.04 / 24.04 | 脚本基于 `apt` 和 `systemd` |
| 带宽 | 3~5 Mbps | 页面很轻，主要开销是大屏轮询 |
| 磁盘 | 40G 起 | 数据库增长极慢，主要是日志和备份 |

### 安全组（云控制台里配置，和服务器防火墙是两层）

| 端口 | 来源 | 用途 |
|---|---|---|
| 22 | **只填你的公网 IP** | SSH 登录，不要对 0.0.0.0/0 开放 |
| 80 | 0.0.0.0/0 | HTTP |
| 443 | 0.0.0.0/0 | HTTPS（配了域名才用） |

> **3000 端口绝对不要放行**。应用只监听回环地址，外部流量统一走 Nginx。

---

## 2. 首次部署

### 只需要在本地执行一条命令

```powershell
cd I:\work-body-dir\lucky-draw
.\deploy\publish.ps1 -ServerHost 1.2.3.4
```

> 腾讯云 Ubuntu 镜像默认用户名是 `ubuntu`；如果是 root 直接登录，加 `-User root`。

这条命令会自动完成：

1. 打包源码（**排除 `node_modules` 和 `data`**，防止本地测试数据覆盖线上）
2. 上传到服务器 `/tmp`
3. 解压到 `/opt/lucky-draw`
4. 检测到是首次部署 → 自动执行 `install-server.sh`：
   - 安装 Node.js 24
   - 创建专用用户 `lucky`（不用 root 跑服务）
   - 注册 systemd 服务，开机自启 + 崩溃自动拉起
   - 安装 Nginx 反向代理
   - 生成随机访问密码
   - 开启防火墙，只放行 22/80/443
5. 从本机验证能否访问

### 拿到访问密码

```powershell
ssh ubuntu@1.2.3.4 "sudo cat /opt/lucky-draw/deploy/.access.txt"
```

输出类似：

```
用户名: lucky
密码:   K7mQ2xR9pT4w
```

### 打开看看

- 抽奖页（公开，发给参与者）：`http://1.2.3.4/`
- 管理后台（需登录）：`http://1.2.3.4/admin`
- 公共大屏（公开，直接投屏）：`http://1.2.3.4/display.html`

管理后台首次登录用 `.env` 或环境变量里设置的 `ADMIN_USER` / `ADMIN_PASSWORD`（默认都是 `admin`）。

---

## 3. 验证清单

| 检查 | 命令 | 期望 |
|---|---|---|
| 服务在跑 | `systemctl status lucky-draw` | `active (running)` |
| 端口只在内网 | `ss -lntp \| grep 3000` | `127.0.0.1:3000`，不是 `0.0.0.0:3000` |
| Nginx 正常 | `sudo nginx -t` | `syntax is ok` |
| 访问有密码 | 浏览器访问 IP | 弹出登录框 |
| 数据持久化 | 抽一次奖 → `systemctl restart lucky-draw` → 刷新 | 记录还在 |

---

## 4. 日常更新

改完代码，还是一条命令：

```powershell
.\deploy\publish.ps1 -ServerHost 1.2.3.4
```

它会保留线上的 `data/` 和 `backups/`，只覆盖代码，然后重启服务。整个过程约 10 秒，正在看大屏的人刷新一下就好。

---

## 5. 备份与恢复

### 手动备份

```bash
ssh ubuntu@1.2.3.4
sudo bash /opt/lucky-draw/deploy/backup.sh
```

备份文件在 `/opt/lucky-draw/backups/`，自动保留最近 30 天。

### 设成每天自动备份

```bash
sudo crontab -e
```

加一行（每天凌晨 3 点）：

```
0 3 * * * /usr/bin/bash /opt/lucky-draw/deploy/backup.sh >> /var/log/lucky-backup.log 2>&1
```

### 恢复

```bash
sudo systemctl stop lucky-draw
sudo gunzip -c /opt/lucky-draw/backups/lottery-20261104-030000.db.gz \
  | sudo tee /opt/lucky-draw/data/lottery.db > /dev/null
# WAL 和 SHM 必须删掉，否则会和旧数据混在一起
sudo rm -f /opt/lucky-draw/data/lottery.db-wal /opt/lucky-draw/data/lottery.db-shm
sudo chown lucky:lucky /opt/lucky-draw/data/lottery.db
sudo systemctl start lucky-draw
```

### 把本地数据搬到线上（迁移场景）

如果你本地已经录好了名单和奖品，想原样搬上去：

```powershell
.\deploy\publish.ps1 -ServerHost 1.2.3.4 -WithData
```

⚠️ 会**覆盖线上数据库**。脚本会先自动备份一份到 `backups/`，但仍建议首次部署时使用。

---

## 6. 配域名 + HTTPS（可选）

没有域名也能用，但公网明文传输密码不太好。

### 6.1 解析域名

在域名服务商处添加 A 记录，指向服务器公网 IP。

### 6.2 一行命令申请证书

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d draw.example.com
```

certbot 会自动改写 Nginx 配置、加上 443 监听和证书续期任务。

### 6.3 改一句话

申请完成后，把 `/etc/nginx/conf.d/lucky-draw.conf` 里的 `server_name _;` 改成你的域名，然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> 中国大陆地域的服务器，域名走 80/443 **需要先完成 ICP 备案**，否则会被拦截。没备案就先用 IP 访问，或用香港/海外地域。

---

## 7. 常见问题

### `Cannot find module 'node:sqlite'`

Node 版本太低。检查 `node -v`，必须 ≥ 23.4：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install -y nodejs
sudo systemctl restart lucky-draw
```

### 浏览器打开是 502 Bad Gateway

后端没起来：

```bash
sudo systemctl status lucky-draw
sudo journalctl -u lucky-draw -n 50 --no-pager
```

常见原因：依赖没装（`npm ci` 失败）或 `data/` 目录权限不对（属主必须是 `lucky`）。

### 访问超时，但服务器上 `curl localhost` 正常

99% 是**云控制台的安全组没放行 80 端口**。服务器内部 `ufw` 和云安全组是两层，都要开。

### 大屏 / 控制台提示 401 但又不知道密码

```bash
sudo cat /opt/lucky-draw/deploy/.access.txt
```

重置密码：

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-lucky lucky
sudo systemctl reload nginx
```

### 想彻底去掉密码（仅限内网使用）

编辑 `/etc/nginx/conf.d/lucky-draw.conf`，注释掉这两行：

```nginx
# auth_basic "Lucky Draw";
# auth_basic_user_file /etc/nginx/.htpasswd-lucky;
```

然后 `sudo nginx -t && sudo systemctl reload nginx`。

### 中奖记录想导出存档

页面右上角有「导出 CSV」，或直接调 `http://你的地址/api/export.csv`。

> 建议每次活动结束后导出一次 CSV，作为独立于数据库的存档。

---

## 8. 目录与文件说明

```
lucky-draw/
├── server.js                    应用入口（Express + 内置 SQLite）
├── public/                      纯静态前端，无构建步骤
├── data/                        运行时数据（不进版本库）
│   ├── lottery.db               主数据库
│   ├── lottery.db-wal           预写日志（备份时必须一起处理）
│   └── lottery.db-shm           共享内存索引
├── backups/                     自动备份目录
└── deploy/
    ├── install-server.sh        服务器环境初始化（只需跑一次）
    ├── publish.ps1              Windows 本地一键发布
    ├── backup.sh                SQLite 安全备份（WAL 兼容）
    ├── lucky-draw.service       systemd 单元
    ├── nginx-lucky-draw.conf    反向代理 + 访问密码
    └── .access.txt              首次部署生成的访问凭据（不进版本库）
```

服务器上的实际路径：`/opt/lucky-draw`（代码）+ `/etc/systemd/system/lucky-draw.service` + `/etc/nginx/conf.d/lucky-draw.conf`。
