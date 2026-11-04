// PM2 进程配置
//
// 用法（宝塔或纯命令行都适用）：
//   pm2 start deploy/ecosystem.config.js
//   pm2 save
//
// 宝塔的「Node 项目管理器」也可以直接添加这个文件作为项目。
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'lucky-draw',
      script: 'server.js',
      cwd: path.resolve(__dirname, '..'),

      // 单实例即可：应用用内置 SQLite，多实例会争抢同一个数据库文件
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // 只监听回环地址，外部流量由宝塔的 Nginx 反向代理进来
        HOST: '127.0.0.1',
      },

      // 内存超过 300M 自动重启，防止意外泄漏拖垮小内存服务器
      max_memory_restart: '300M',

      // 进程异常退出自动拉起
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,

      error_file: path.resolve(__dirname, '../logs/err.log'),
      out_file: path.resolve(__dirname, '../logs/out.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
