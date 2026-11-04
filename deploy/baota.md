# 宝塔面板部署指南（Ubuntu 22.04）

你的服务器已经装了宝塔，那就**不要用** `install-server.sh`——它会安装系统 Nginx、抢占 80 端口、改写 `/etc/nginx`，而宝塔的站点配置在 `/www/server/panel/vhost/nginx/`，两套 Nginx 会直接打架，面板里的网站全部失效。

正确路线只有一句：**Web 服务和防火墙交给宝塔，我们只负责把 Node 进程跑起来。**

---

## 0. 先确认三件事

| 检查项 | 怎么查 | 要求 |
|---|---|---|
| 宝塔版本 | 面板右下角版本号 | ≥ 8.0（才有「Node 项目」功能） |
| 已装 Nginx | 软件商店 → 已安装 | 有 Nginx（没装就先装，别装 Apache） |
| Node 版本 | 面板内终端执行 `node -v` | 必须 ≥ 23.4，推荐 24 |

> 为什么卡 Node 版本：项目用 Node 内置的 `node:sqlite`，22.5~23.3 需要额外的 `--experimental-sqlite` 参数才能用，直接 `node server.js` 会报 `Cannot find module 'node:sqlite'`。

---

## 1. 上传代码

### 方式 A：本地一键上传（推荐）

在 Windows 本地执行：

```powershell
cd I:\work-body-dir\lucky-draw
.\deploy\publish.ps1 -ServerHost 1.2.3.4 -User root -Baota
```

它会自动完成：

1. 打包源码（**排除 `node_modules` 和 `data`**，防止本地测试数据覆盖线上中奖记录）
2. 上传并解压到 `/www/wwwroot/lucky-draw`
3. 调用 `install-baota.sh`：装 Node 24 → 建目录 → `npm ci` → PM2 启动进程
4. **不会**碰 Nginx、防火墙、systemd

> 用 root 登录宝塔的服务器，`-User root`；如果平时用 `ubuntu` 账号登录，省略该参数（需要能免密 sudo）。

### 方式 B：面板文件管理器手动传

1. 本地把 `lucky-draw` 打成 zip（排除 `node_modules`、`data`、`.git`）
2. 面板 → 文件 → 进入 `/www/wwwroot/` → 上传
3. 右键解压到当前目录，确保路径是 `/www/wwwroot/lucky-draw/server.js`
4. 终端执行：`sudo bash /www/wwwroot/lucky-draw/deploy/install-baota.sh`

---

## 2. 装 Node 24

**方式 A（面板装）**：软件商店 → 搜索「Node.js版本管理器」→ 安装 → 打开 → 安装 v24.x

**方式 B（命令行装）**：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install -y nodejs
```

装完必须验证这一句，通过了才继续：

```bash
node -v                                # 应输出 v24.x
node -e "require('node:sqlite')" && echo "node:sqlite 可用"
```

---

## 3. 让进程跑起来

### 方式 A：宝塔「Node 项目」（最省事，自动配反代）

**网站 → Node 项目 → 添加 Node 项目**

| 字段 | 填写 |
|---|---|
| 项目名称 | `lucky-draw` |
| 项目目录 | `/www/wwwroot/lucky-draw` |
| 启动文件 | `server.js` |
| 项目端口 | `3000` |
| 运行方式 | 原生（node） |
| Node 版本 | v24.x |
| 环境变量 | `NODE_ENV=production`<br>`HOST=127.0.0.1`<br>`PORT=3000` |

勾选「自动启动」，确定。宝塔会自动创建反向代理，**可以直接跳到第 5 步**。

> `HOST=127.0.0.1` 这一项别漏。不设的话 Node 监听 `0.0.0.0`，如果有人误开了 3000 端口，就能绕过 Nginx 的密码直接访问后台。

### 方式 B：PM2 命令行

```bash
sudo npm install -g pm2
cd /www/wwwroot/lucky-draw
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root     # 开机自启，按提示执行它输出的命令
pm2 status                                  # 状态应为 online
```

`ecosystem.config.js` 里已经写好了 `PORT=3000`、`HOST=127.0.0.1` 和内存超限自动重启。

---

## 4. 建站点 + 反向代理

> 用了第 3 步的「Node 项目」方式，宝塔已自动完成，可跳过本节。

**网站 → 添加站点**

| 字段 | 填写 |
|---|---|
| 域名 | 有域名填域名；没有域名填服务器公网 IP（宝塔支持 IP 建站） |
| 根目录 | `/www/wwwroot/lucky-draw` |
| FTP / 数据库 / PHP | **全部不勾**（这个项目不需要） |

建好后：**点站点名 → 设置 → 反向代理 → 添加反向代理**

| 字段 | 填写 |
|---|---|
| 代理名称 | `lucky` |
| 目标 URL | `http://127.0.0.1:3000` |
| 发送域名 | `$host` |

保存后访问站点，应该能看到抽奖台页面。

---

## 5. 改掉默认登录密码（必做）

应用自带登录页，访问站点会先跳到 `/login`，**默认账号和密码都是 `admin`**。

在「Node 项目 → 设置 → 项目配置」的环境变量里加上这三项，然后重启项目：

| 变量名 | 值 |
|---|---|
| `ADMIN_USER` | `admin`（或你想要的账号） |
| `ADMIN_PASSWORD` | 你的强密码 |
| `SESSION_SECRET` | 一串随机字符（决定登录状态能维持多久） |

> 如果嫌 `SESSION_SECRET` 麻烦，不填也行——程序每次启动会随机生成一个，代价是服务重启后所有人都要重新登录。

**不需要再配宝塔的「访问限制」**。应用已经有登录页了，再叠一层 Nginx Basic Auth 会让浏览器连续要两次密码，体验很差。

---

## 6. HTTPS（有域名才做）

1. 域名 A 记录先解析到服务器 IP
2. **站点 → 设置 → SSL → Let's Encrypt → 申请**
3. 申请成功后打开「强制 HTTPS」

⚠️ 中国大陆地域的服务器，域名走 80/443 **需要 ICP 备案**，否则会被运营商拦截。没备案就用 IP + HTTP 访问，或者换香港/海外地域。

---

## 7. 放行端口（两层都要开）

| 层 | 位置 | 操作 |
|---|---|---|
| 服务器防火墙 | 宝塔 → 安全 | 放行 `80`、`443` |
| 云厂商 | 控制台 → 安全组 | 放行 `80`、`443`；`22` 只填自己的 IP |

只开一层是最常见的踩坑点：宝塔里放行了，云安全组没开，浏览器照样打不开。

**3000 端口不要放行。**

---

## 8. 每日自动备份

**计划任务 → 添加任务**

| 字段 | 填写 |
|---|---|
| 任务类型 | Shell 脚本 |
| 任务名称 | 抽奖数据备份 |
| 执行周期 | 每天 3:00 |
| 脚本内容 | `bash /www/wwwroot/lucky-draw/deploy/backup.sh` |

备份文件落在 `/www/wwwroot/lucky-draw/backups/`，默认保留 30 天。

> ⚠️ **不要用宝塔的「备份网站」功能备份数据库**。它直接拷文件，而 SQLite 开了 WAL 模式，最新记录还在 `lottery.db-wal` 里，拷出来的库会缺数据。`backup.sh` 用的是 SQLite 官方的 `VACUUM INTO`，能生成一致快照。

---

## 9. 日常更新

本地改完代码，还是一条命令：

```powershell
.\deploy\publish.ps1 -ServerHost 1.2.3.4 -User root -Baota
```

线上的 `data/`、`backups/`、`logs/` 都会保留，只覆盖代码，然后 PM2 重启，约 10 秒。

---

## 10. 常见问题

### 打开是 502 Bad Gateway

Node 进程没起来。面板终端执行：

```bash
pm2 status
pm2 logs lucky-draw --lines 50
```

常见原因：Node 版本太低（`node:sqlite` 报错）、依赖没装、`data/` 目录不存在。

### 打开是宝塔默认页 / 站点目录列表

站点根目录没指对，或者反向代理没配。检查「站点 → 根目录」是否为 `/www/wwwroot/lucky-draw`。

### 页面能开，但抽奖按钮没反应（接口 404）

反向代理的目标 URL 写错了。必须是 `http://127.0.0.1:3000`，注意是 `http` 不是 `https`，端口是 `3000`。

### `Cannot find module 'node:sqlite'`

`node -v` 版本不够。按第 2 步装 24，然后 `pm2 restart lucky-draw`。

### 改完密码但页面还是旧密码生效

宝塔的访问限制修改后需要重新保存一次站点配置，或者 `nginx -s reload`（面板 → 软件商店 → Nginx → 重载配置）。

### 上传代码后中奖记录没了

说明用 `-WithData` 或手动把本地 `data/` 传上去了，覆盖了线上库。先看 `backups/` 里有没有可用备份：

```bash
ls -lh /www/wwwroot/lucky-draw/backups/
```

恢复步骤见 `deploy/README.md` 第 5 节。

---

## 附：文件位置对照

| 内容 | 位置 |
|---|---|
| 代码 | `/www/wwwroot/lucky-draw` |
| 数据库 | `/www/wwwroot/lucky-draw/data/lottery.db` |
| 备份 | `/www/wwwroot/lucky-draw/backups` |
| PM2 日志 | `/www/wwwroot/lucky-draw/logs` |
| 宝塔站点配置 | `/www/server/panel/vhost/nginx/`（**不要手改**） |
| 宝塔 Nginx 主程序 | `/www/server/nginx/` |
