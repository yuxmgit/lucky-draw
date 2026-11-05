# 抽奖系统

奖品可自定义、中奖结果全程留痕、公平公正可校验的抽奖 Web 应用，适用于团建、展会、门店促销、直播抽奖等各种场景。

## 功能

- **公开抽奖页**（`/`）：**无需登录**，任何人打开即可抽奖、查看中奖榜与中奖记录
- **管理后台**（`/admin`）：登录后维护奖品与参与名单、导出记录、执行公平核验；默认账号 / 密码均为 `admin`，7 天免登录
- **抽奖台**：滚动名字动画、空格键抽奖、中奖撒花、实时中奖榜
- **奖品设置**：自定义图标 / 名称 / 奖项等级 / 数量，行内编辑、超额拦截
- **参与名单**：批量粘贴导入（支持「姓名,部门」或直接从 Excel 复制两列）
- **中奖记录**：谁在什么时间抽中了什么，可搜索、可导出 CSV
- **防刷限流**：公开抽奖接口同一 IP 默认 3 秒冷却，可用 `DRAW_COOLDOWN_MS` 调整
- **公共大屏**（`/display.html`）：2 秒轮询实时同步中奖结果、奖品进度、全屏揭晓动画，适合投屏
- **公平核验**：
  - 使用 `crypto.randomInt`（密码学安全随机、拒绝采样无偏差）
  - 每次抽奖记录候选池快照哈希，事后无法替换参赛者
  - 所有记录构成 SHA-256 哈希链，任何篡改都会校验失败
  - 默认一人一奖，已中奖者自动退出候选池

## 运行

要求 Node.js ≥ 22.5（推荐 24+，内置 SQLite，无需数据库服务）。

```bash
npm install
npm start
```

- 公开抽奖页：<http://localhost:3000/>（免登录，发给参与者即可）
- 管理后台：<http://localhost:3000/admin>（未登录会跳 `/login`，默认账号 `admin`、密码 `admin`）
- 公共大屏：<http://localhost:3000/display.html>（免登录，直接投屏）

公网部署前必须改掉默认密码：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_USER` | `admin` | 登录账号 |
| `ADMIN_PASSWORD` | `admin` | 登录密码，**公网必须修改** |
| `SESSION_SECRET` | 每次启动随机生成 | 会话签名密钥；不设置则重启后需要重新登录 |

```bash
# Linux / macOS
ADMIN_PASSWORD='你的强密码' SESSION_SECRET='一串随机字符' npm start

# Windows PowerShell
$env:ADMIN_PASSWORD='你的强密码'; $env:SESSION_SECRET='一串随机字符'; npm start
```

同事在局域网内访问 `http://<你的IP>:3000/` 即可投屏 / 观看。自定义端口：`set PORT=8080 && npm start`。

## 数据

- 数据保存在 `data/lottery.db`（SQLite），重启不丢失
- 「公平核验」页可一键校验全部记录是否被篡改，并可导出 CSV 存档

## 部署到服务器

```powershell
# 服务器装了宝塔面板
.\deploy\publish.ps1 -ServerHost 1.2.3.4 -Baota

# 纯净服务器（没有宝塔，自动装 Nginx + systemd + 随机访问密码）
.\deploy\publish.ps1 -ServerHost 1.2.3.4
```

一条命令完成打包、上传、安装 Node 运行时、托管进程，并且始终保留线上数据。

- 宝塔环境：见 [`deploy/baota.md`](deploy/baota.md)（在面板里加反代、加密码、申 SSL）
- 纯净环境：见 [`deploy/README.md`](deploy/README.md)（含安全组、备份恢复、排障）

> ⚠️ 抽奖页与公共大屏是公开的，但奖品 / 名单 / 记录等管理接口都需要登录，公网部署请务必修改默认密码。
