# 词影竞技场（Ciying Arena）

网页版「词影」抢答对战：全房共享一张 6 行笔画棋盘，猜四字成语，第一个猜中者 +1 分。

- **1v1**：小局先到 **11 分且领先 2 分**；私有房可设 1/3/5/7 局，快速匹配固定一局定胜负
- **3 人混战**：默认先到 **7 分**，目标分可由房主自定义
- **团队战**：A/B 两队，**每队人数不限**且支持手动选队（3v1、2v3 等）；赛制同 1v1
- **个人练习**：单人练习一张棋盘，不限时；不计天梯与总统计，练习数据单独累计
- 快速匹配默认自由猜词、常见词库；匹配成功后房主先发规则协商弹框，对方可同意或修改，达成一致后开始
- 每轮：共享 6 行棋盘；**1 秒**提交间隔；**1 分钟无人作答**本轮结束
- 第 6 行仍未猜中：1v1 对手 +1 / 团队战对方队伍 +1 / 三人战另外两人各 +1
- 建房/协商可选 **标准猜词**（默认常见词库，可切全量）或 **自由猜词**（任意 4 个汉字，需在笔画字库）
- 目标分可选 **7/11/15/21**，默认 11，也支持房主自定义（1~99）
- **词库**：默认 common（7,208 条常见成语）；all 为 29,406 条可用成语
- 房主无需准备；对局中离开/断线保留座位 **3 分钟**，超时判对手胜
- 房间：房号、公开房列表、快速匹配；观战、房间/队伍聊天
- 账号：游客可玩；注册后可改头像/唯一昵称、查天梯与个人战绩（对手、大比分、小局比分、分数变化）
- 首页显示注册人数与当前在线人数；底部展示 ICP 备案号
- 右上角 **帮助** 页与 **更新日志** 页；帮助含原作者致谢与 [cy.surprising.studio](https://cy.surprising.studio/)、[Steam 词影](https://store.steampowered.com/app/2331660/)
- 输入框不再截断超过 4 字的内容；非法提交不清空；标准模式差 1 字时只提示一个最接近成语
- 服务端权威：答案不下发客户端，只下发已经揭示的笔画线索；小局/大局都有结算页面
- 房间顶部有红/蓝（三人战红/绿/蓝）比分条，长度随当前小局分变化，分数写在条内；进入赛点会切换发光脉冲风格
- 前端棋盘为 **一屏 6 行** 适配（桌面/手机短屏自动压缩）；移动端输入框悬浮底部；界面使用小圆角，不使用中点与竖线作可见分隔符

详细规则与 WebSocket 协议见 [SPEC.md](./SPEC.md)。

## 技术栈

- Node.js 24+，直接运行 TypeScript（Node 原生 type stripping，无 tsx / esbuild / 打包器）
- 后端：Fastify + `ws` + JSON 文件持久化
- 前端：原生 HTML / CSS / ES Modules，服务端静态托管，无构建步骤
- 数据复用 `koishi-plugin-wordle-game` v4.4.0 的 `strokes.json`、成语词库与笔画比较算法

## 目录

```
apps/server        后端（REST + WebSocket + 静态托管）
apps/web/public    前端静态文件
packages/engine    词影引擎（笔画比较、回合反馈、校验、Elo）
packages/shared    共享类型与协议
datasets           笔画数据、成语词库
scripts            数据校验等脚本
```

## 本地运行

要求 Node.js 24+（`node --version` 应 >= 24）。

```bash
corepack enable
pnpm install --ignore-scripts --node-linker=hoisted
node scripts/verify-data.mjs
node apps/server/src/index.ts
```

打开 http://localhost:3000 。

开发时可以直接用两个浏览器标签页（或两个浏览器）模拟两名玩家：

1. 各自输入昵称进入大厅；
2. 一方创建 1v1 房间（可选大比分/标准或自由猜词），把 5 位房号发给另一方；
3. 非房主点准备，房主直接开始；
4. 抢答四字成语；小局先到 11 分且领先 2 分，按大比分决出胜负。

## 测试

```bash
node scripts/run-tests.mjs
node scripts/verify-data.mjs
```

> 说明：沙箱/CI 环境若不允许 Node 再 spawn 子进程，不要用 `node --test <目录>`（它会为每个测试文件 spawn），本仓库的 `run-tests.mjs` 在单进程内依次 import 测试文件。

启动服务后，可以再跑一次真实链路冒烟（需要服务端已运行）：

```bash
# Linux/macOS
BASE=http://127.0.0.1:3000 node scripts/e2e-smoke.mjs
# PowerShell
$env:BASE="http://127.0.0.1:3000"; node scripts/e2e-smoke.mjs
```


## Docker 部署

完整的服务器选型、上传、Nginx/HTTPS、systemd 备选方案、更新/备份/回滚和常见问题见 [DEPLOY.md](./DEPLOY.md)。腾讯云 + 宝塔面板的逐步操作见 [DEPLOY-TENCENT-BT.md](./DEPLOY-TENCENT-BT.md)。已有服务器更新且保留数据见 [UPDATE.md](./UPDATE.md)。

```bash
docker compose up -d --build
```

默认只映射到本机 `127.0.0.1:3000`（供 Nginx 反代），数据持久化在 `./data`。如果暂时想用公网 IP 直接访问，可临时把 compose 的端口改成 `"3000:3000"` 并在安全组放行 3000。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / WebSocket 端口 |
| `DATA_DIR` | `./data` | `store.json` 持久化目录 |
| `PUBLIC_ORIGIN` | 空 | 可选，公开访问地址，用于 README/日志提示 |

### Nginx 反向代理示例

```nginx
server {
  listen 443 ssl http2;
  server_name ciying.example.com;

  ssl_certificate     /etc/letsencrypt/live/ciying.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ciying.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

WebSocket 走同域 `/ws`，Nginx 必须转发 `Upgrade` / `Connection` 头。

## 数据与授权

- `datasets/strokes.json` 来自 Koishi 插件 `koishi-plugin-wordle-game` v4.4.0 的 `lib/assets/词影/strokes.json`（9,574 个汉字，含笔画轮廓与中心线）。
- `datasets/idioms.json`、`datasets/common-idioms.json` 来自同一插件的汉兜词库。
- 当前答案/标准猜测词库为 **29,406 条可用成语**：29,957 条全量成语中过滤掉 550 条含笔画库缺失字的条目；`common-idioms.json` 的 7,208 条常见成语保留作参考。
- 插件代码为 MIT / Apache-2.0；但笔画数据与楷体字体的第三方授权未在插件 THIRD_PARTY_NOTICES 中列明，**公网运营前请自行核实数据/字体授权，或替换为有明确授权的数据**。
- “词影”是 Steam 游戏名；公开运营建议改用独立名称，避免商标与混淆风险。

## 上线前检查

- [ ] 设置 HTTPS 与域名，反代 WebSocket 正常
- [ ] 修改默认昵称/聊天限制，按需加敏感词过滤
- [ ] 确认数据与名称授权
- [ ] 备份 `DATA_DIR/store.json`
- [ ] 如并发较大，把房间状态迁到 Redis、用户/战绩迁到 Postgres（当前 MVP 为单进程内存房间）
