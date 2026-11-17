# 词影竞技场（Ciying Arena）—— 网页版抢答对战 MVP 规格

## 1. 产品形态

公网网页小游戏。浏览器进入大厅，游客填昵称即可玩；可注册登录，登录后参与天梯。
一局比赛由服务端创建，所有玩家共享**一张棋盘**，抢答猜四字成语，先猜中者得分。

## 2. 核心规则（2026-11 修订）

- 模式：
  - `duel`：1v1，2 名玩家。**主推模式**。
  - `ffa3`：3 人混战，3 名玩家，各自计分；**先到 7 分获胜**，不设小局。
  - `team2v2`：团队战（保留旧 key），分 A/B 两队，**每队人数不限**（不强制 2v2）；赛制同 1v1。
  - `practice`：个人练习，1 人；单人一张 6 行棋盘，猜中或 6 行用完即结束；可“再练一局”；不计天梯、不计入总统计，练习数据单独累计。
- 团队战手动选队：
  - 玩家可在等待房间中自选 A/B 队；房主可以把任意玩家移到 A/B 队。
  - 开始条件：A/B 各至少 1 人，其他玩家全部准备；允许 3v1、2v3 等不等人数。
- 个人练习：
  - 建房即自动开始一张棋盘；无对手、无小局/大比分/第六行判分。
  - 猜中或第 6 行结束显示练习结果；房主可“再练一局”。
  - 练习统计写入独立的 `practice` 模式：盘数、猜测数、猜出数、猜出率、平均/最快猜出时间；不计入天梯/排行榜/总统计。
- 1v1 / 团队战赛制：
  - 一个小局（set）：个人（1v1）或队伍（团队）先到 **11 分** 且 **领先 2 分** 获胜；10:10 后继续，直到领先 2 分。
  - 每个小局通过多轮抢答累积分数：每轮先猜中者得 1 分；**第 6 行仍未猜中时，对方（团队战为对方队伍）得 1 分**；1 分钟内无人作答则本轮结束，无人得分。
  - 大比分：房主建房时选择 **1 / 3 / 5 / 7 局**（默认 3）；先赢 `ceil(局数/2)` 个小局者赢得比赛。
  - 小局之间清空双方小局分，保留大比分，自动进入下一小局；小局结束展示结算页约 5 秒，再进入下一小局。
- 三人混战：
  - 先到 7 分获胜；每轮先猜中者 +1；第 6 行未猜中时，其他两名玩家各 +1；1 分钟无人作答则本轮结束。
- 每轮：
  - 答案从 **全部 29,406 条可用成语**（29,957 条中过滤掉缺笔画字的 550 条）中随机抽取。
  - 棋盘最多 6 行，全房共享。
  - 任意玩家随时可以提交一个四字词语；服务端串行处理。
  - 每人两次提交之间至少间隔 **1000ms**。
  - 猜错：消耗 1 行，追加一行公开线索；该行标注猜测者。
  - 猜中：该玩家/队伍得 1 分，本轮立即结束，公布答案。
  - 第 6 行仍猜错：按上面规则给对方加 1 分（本轮结束）。
  - **无人作答倒计时 60 秒**：每次有效猜测都会重置；超时本轮结束，无人得分。
  - 同一轮内重复的猜测词直接拒绝，不消耗行数。
- 猜测范围（建房时选择）：
  - `standard` 标准：只能猜词库中的成语（29,406 条可用成语）。
  - `free` 自由：任意 4 个汉字都可以猜，但必须是汉字、且每个字都在笔画库中；不允许数字/字母/符号。
- 房主无需准备：房主创建房间即视为已准备；`room.start` 只要求其他玩家全部准备。
- 离开/断线：
  - 对局中离开或断线，座位保留 **3 分钟**；3 分钟内可用房号重新加入，恢复对局。
  - 3 分钟未回来：1v1 判对手胜；团队战判对方队伍胜；三人战移除该玩家，剩余玩家继续（只剩 1 人时该玩家获胜）。
  - 等待中离开直接移除；所有人离开后房间销毁。
- 回合衔接：
  - 本轮结束后展示答案 2.5 秒；小局结束后展示结算页 5 秒。
  - 1v1 / 团队战：小局未结束进入下一轮；小局结束清空小局分、进入下一小局；大比分达到目标进入 `matchEnd`。
  - 三人战：达到 7 分即 `matchEnd`。
  - 比赛结束进入 `matchEnd`，房主可“再来一局”，大比分/小局分/轮次清零，保留所选大比分与猜测模式。

## 2.1 个人统计

- 注册用户按模式累计：场次、胜/负/平、胜率、参与轮数、提交过猜测的轮数、猜出次数、猜出率、猜测命中率、总猜测数、平均猜出时间、最快猜出时间、最快场次（全场最快平均猜出时间的场次）、累计得分、赢下小局数。
- `practice` 单独累计盘数/轮数/猜测/猜出/用时，不计入 `total`、天梯、排行榜和比赛记录。
- 游客不写入持久统计。
- API：`GET /api/stats/me`（需要登录），返回 `{ total, modes }`；前端提供 `#/stats` 页面，练习模式单独分区。

## 2.2 第五轮修改（2026-11）

- 快速匹配：一局定胜负（bestOf 固定 1）；匹配成功不自动开局，房主先发规则协商弹框，其他玩家同意或修改，双方达成一致后房主开始。匹配默认自由猜词，词库默认 common。
- 词库：标准模式默认 `common`（7208 条常见成语）；房主/规则协商可切换 `all`（29406 条全量）。自由模式不受词库限制。
- 每小局目标分：可选 7/11/15/21，默认 11，也允许房主自定义（1~99）；三人战目标分同理可自定义，默认 7。
- 输入：不再限制输入框 4 字；非法提交不清空；标准模式差 1 个字时只随机提示一个最接近成语。
- 结算页保留每个小局的小比分；游戏侧边栏显示最近 5 轮答案。
- 移动端输入框悬浮在底部；结算页区分正常胜利与断线判胜。
- 右上角增加“更新日志”；首页底部加 ICP 备案号。
- 账号：注册用户可修改头像与昵称，昵称不可重复；可查看个人战绩（对手、大比分、小比分、天梯分变化），练习不开放查询。
- 首页顶部显示“已注册 x 人 当前在线 x 人”。
- 游客 WebSocket 下线且没有保留座位/队列/观战时，立即删除游客数据。



## 3. 棋盘反馈

完全复用 Koishi 插件 v4.4.0 的 `compareStrokes` 与 `generateLetterTilesHtmlForCiying` 语义：

- 每个猜测行有 4 个格子，每格对应一个位置。
- 每格内部把“答案字”和“猜测字”逐笔比较：
  - 距离 < 0.5：判为正确笔画，画答案自己的笔画路径，绿色 `#0d9488`。
  - 0.5 <= 距离 < 1：画猜字的笔画路径，按形心差平移 70%，透明度 `(1 - distance) / 0.5`，黑色。
  - 距离 >= 1：不画。
- 整字与位置完全正确：绿底 + 白色完整答案笔画。
- 普通模式会累积每个位置的影子：新行显示该位置之前所有行的影子 + 本次比较结果。服务端维护 `positionCaches: string[][]`（4 个位置）。
- 已完全猜中的位置在后续行保持绿底显示答案字。
- 数据来源：`datasets/strokes.json`（9574 字，`{ strokes: string[], medians: [[x,y],...][] }`，坐标 1024 网格，渲染时 y 轴翻转为 `900 - y`）。

## 4. 身份与账号

- 游客：`POST /api/session/guest`，昵称 1~16 字符；返回 token 和 user；游客不参与天梯。
- 注册：`POST /api/auth/register`，`username` 3~20 位（字母/数字/下划线），密码 >= 6 位；返回 token。
- 登录：`POST /api/auth/login`。
- 当前用户：`GET /api/me`（Bearer token）。
- 退出：`POST /api/auth/logout`。
- 游客可随时玩；天梯只记录注册用户。
- 登录采用服务端内存 + JSON 持久化；密码使用 `node:crypto` 的 `scrypt` 加盐哈希。
- token 为 32 字节随机 hex，存于 JSON；客户端存 localStorage。

## 5. 房间、匹配、观战

- 私有房：创建时 `visibility: "private"`，生成 5 位房号；可通过房号加入，不出现在房间列表。
- 公开房：创建时 `visibility: "public"`；大厅可见，可加入。
- 建房参数：`bestOf`（1/3/5/7，默认 3，duel/team 生效）、`guessMode`（`standard` / `free`，默认 standard）。
- 团队战：A/B 两队，每队人数不限；加入时按当前人数自动分到较少人的一队（相等时交替）；房主在双方都有至少 1 人、其他玩家全部准备时可开始。
- 快速匹配：`queue.join { mode }`，队列人数达到该模式人数后自动建房并倒计时；`duel`/`ffa3` 可用；团队战请用房号（人数不限，不适合固定队列）。
- 观战：`spectate.join { code }`，只读接收状态；不回传玩家操作。观战人数上限 20。
- 房间状态：`waiting`、`countdown`、`playing`、`roundEnd`、`matchEnd`。
- 准备：普通玩家 `room.ready`；**房主无需准备**；房主 `room.start`。
- 房主离开/断线时转移给第一个在线玩家；所有人离开后房间销毁。
- 离开/断线：对局中保留座位 180 秒（`rejoinDeadline`）；期间可用房号重新加入；超时按第 2 节规则判负/移除。等待中离开立即移除。房间 10 分钟无活动销毁。

## 6. 天梯与排行榜

- 初始分 1200，分模式存储：`duel`、`ffa3`、`team2v2`。
- 只有本局所有玩家都是注册用户时才结算天梯。
- 个人模式：
  - `duel`：标准 Elo，K=32，平局各 0.5；按**大比分胜者**结算，小局比分不影响 K。
  - `ffa3`：按名次两两比较的 Elo，K=24。
- 团队模式：队伍平均分作为队伍分，K=32，队内每个注册成员按队伍结果更新。
- 排行榜：`GET /api/leaderboard?mode=duel|ffa3|team2v2`，返回前 50，含用户名、分数、场次。
- 比赛记录：`GET /api/matches/recent?limit=20`，返回最近比赛摘要。

## 7. 服务端与前端技术

- 运行环境：**Node.js 24+**（直接运行 TypeScript，依赖 Node 原生 type stripping；代码只使用可擦除语法，不用 enum/namespace/参数属性）。不使用 tsx / esbuild / Vite / 打包器，避免本地沙箱无法 spawn 子进程的问题。
- 单进程 Node + Fastify + `ws`；同时提供 REST、WebSocket、静态文件。
- 前端：**原生 HTML/CSS/ES Modules JavaScript**（无框架、无构建步骤），放在 `apps/web/public`；服务端静态托管。SVG 渲染棋盘；移动端优先。
- 测试：`node scripts/run-tests.mjs` 在单进程内运行全部 `.ts` 测试文件（沙箱禁止 Node 再 spawn 子进程）。
- 房间状态全部在内存；用户、token、天梯、比赛记录写入 `DATA_DIR/store.json`（原子写）。
- 服务端权威：答案只存在于服务端内存；客户端只收到已经揭示的线索路径与轮次结束后才下发的答案。
- 静态文件由服务端从 `apps/web/public` 提供；开发时直接 `node apps/server/src/index.ts`，无需前端构建。
- 右上角有“帮助”入口：规则说明 + 原作者致谢，链接 `https://cy.surprising.studio/` 与 Steam 页面 `https://store.steampowered.com/app/2331660/`。
- 房间顶部显示红/蓝（三人战红/绿/蓝）当前小局比分条，段宽按分数比例变化，分数写在段内；进入赛点时切换发光脉冲风格。
- UI 规范：不使用“·”“|”作为可见分隔符；减少圆角矩形，主要面板/按钮使用小圆角（2~4px），圆形头像/状态点除外。

## 8. WebSocket 协议

连接：`ws://host/ws?token=<token>`。所有消息为 JSON。

客户端 → 服务端：

```ts
{
  type: "room.create",
  mode: Mode,
  visibility: "public" | "private",
  bestOf?: 1 | 3 | 5 | 7,
  guessMode?: "standard" | "free",
  dictionary?: "common" | "all",
  pointsToWin?: number
}
{ type: "room.join", code: string }
{ type: "room.leave" }
{ type: "room.ready", ready: boolean }
{ type: "room.start" }
{ type: "room.setTeam", team: "A" | "B", userId?: string }
{ type: "room.proposeRules", rules: RoomRules }
{ type: "room.acceptRules", proposalId: string }
{ type: "room.counterRules", rules: RoomRules }
{ type: "room.guess", word: string }
{ type: "room.chat", scope: "room" | "team", text: string }
{ type: "room.rematch" }
{ type: "spectate.join", code: string }
{ type: "spectate.leave" }
{ type: "queue.join", mode: Mode }
{ type: "queue.leave" }
{ type: "ping" }
```

`bestOf` 对 `duel` / `team2v2` 生效；快速匹配固定 1。`RoomState` 增加 `rules/requiresAgreement/rulesAgreed/proposal/recentRounds`、`guessMode`；`RoomPlayer.rejoinDeadline` 表示重连截止；`RoundState` 增加 `awardedTo/awardedTeam/setWinnerId/setWinnerTeam`；`MatchState` 增加 `forfeitById/forfeitTeam/setHistory`；玩家/比赛记录带 `avatar`。

服务端 → 客户端：

```ts
{ type: "hello", user: PublicUser }
{ type: "state", state: RoomState }        // 房间内/观战时，状态变化即推送
{ type: "rooms", rooms: RoomSummary[] }    // 大厅房间列表
{ type: "queue", state: QueueState }
{ type: "leaderboard", mode: Mode, rows: LeaderboardRow[] } // 可选，主要用 REST
{ type: "error", message: string }
{ type: "toast", message: string }
{ type: "pong" }
```

`RoomState.viewerRole` 为 `"player" | "spectator"`，`viewerId` 为当前用户 id。

## 9. 文件与职责

- `packages/shared`：共享类型、常量、协议（Lead 维护）。
- `packages/engine` + `apps/server`：后端（backend-dev 维护）。
- `apps/web`：前端（frontend-dev 维护）。
- `datasets/`：`strokes.json`、`idioms.json`、`common-idioms.json`（Lead 提供）。
- 根目录：`Dockerfile`、`docker-compose.yml`、`README.md`（Lead 维护）。

禁止修改不属于自己职责的文件；需要共享类型变更时先通知 Lead。

## 10. 验收标准

- `pnpm install` 成功；`node scripts/run-tests.mjs` 通过；TypeScript `tsc --noEmit` 通过。
- 本地启动后，两个浏览器（或两个标签页）能完成 1v1：创建房间（选大比分/猜词模式）→ 加入 → 非房主准备 → 房主开始 → 抢答 → 小局 11 分且领先 2 分 → 小局/大局结算页。
- 3 人混战先到 7 分；团队战人数不限、A/B 两队、赛制同 1v1。
- 第 6 行未猜中给对方加分、60 秒无人作答结束本轮、1 秒提交间隔均生效。
- 对局中离开/断线 3 分钟内可用房号回来；超时判负。
- 标准/自由猜词模式生效；标准拒绝词库外词语，自由接受任意 4 个有笔画数据的汉字。
- 观战能看到实时棋盘且不能提交猜测。
- 游客可玩；注册/登录后 1v1 天梯分变化；`#/stats` 能看到个人统计。
- 服务端状态中在轮次未结束前不出现答案。
- Docker 构建成功，容器内 `http://localhost:3000` 可访问。
- 棋盘 6 行在常见桌面/手机视口内一屏可见（以真实浏览器目测为准）。
