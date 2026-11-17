# 部署与后续修改指南

目标：把 `ciying-arena` 部署到一台公网 Linux 服务器，并说明以后改代码、更新、备份和回滚的流程。

> 腾讯云 + 宝塔面板的逐步图文式操作见 [DEPLOY-TENCENT-BT.md](./DEPLOY-TENCENT-BT.md)。

## 1. 服务器准备

建议：

- Ubuntu 22.04 / 24.04 或 Debian 12
- 2 核 4G 起步（房间在内存里，单进程）
- 一个域名，例如 `ciying.example.com`
- 安全组/防火墙放行 `80`、`443`；不要直接把 `3000` 暴露到公网

安装 Docker 与 Compose（推荐）：

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 nginx
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# 退出 SSH 重新登录，让 docker 组生效
docker --version
docker compose version
```

如果系统没有 `docker-compose-v2` 包，按 Docker 官方文档安装 Docker Engine + Compose plugin。

## 2. 上传代码

代码目前没有远程仓库时，可以直接用 `scp`：

```bash
# 在本地项目上级目录执行
scp -r ciying-arena user@your-server:/opt/
```

更推荐用 Git，后续更新最方便：

```bash
# 本地项目目录
git init
git add .
git commit -m "initial ciying-arena"
git remote add origin <你的私有仓库地址>
git push -u origin main

# 服务器
sudo mkdir -p /opt
cd /opt
git clone <你的私有仓库地址> ciying-arena
```

`datasets/` 约 38MB，会一起上传；`node_modules/` 不需要上传。

## 3. Docker 部署

```bash
cd /opt/ciying-arena
docker compose up -d --build
```

检查：

```bash
docker compose ps
curl http://127.0.0.1:3000/api/health
```

应返回类似：

```json
{"ok":true,"status":"ok","name":"ciying-arena",...}
```

数据持久化在宿主机的 `./data/store.json`，容器重启不会丢。compose 默认只映射到 `127.0.0.1:3000`，供 Nginx 反代使用；如需临时用公网 IP 测试，再把端口改成 `"3000:3000"` 并在腾讯云安全组放行 3000。

查看日志：

```bash
docker compose logs -f arena
```

## 4. Nginx + HTTPS

创建 `/etc/nginx/sites-available/ciying-arena`：

```nginx
server {
    listen 80;
    server_name ciying.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

启用并申请证书：

```bash
sudo ln -s /etc/nginx/sites-available/ciying-arena /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ciying.example.com
```

WebSocket 也走同一个域名 `/ws`，所以上面的 `Upgrade` / `Connection` 两个头必须保留。

DNS 把 `ciying.example.com` 的 A 记录指向服务器公网 IP，等生效后再申请证书。

## 5. 不用 Docker 的手动部署（备选）

要求 Node.js 24+：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # 必须 >= 24

sudo corepack enable
cd /opt/ciying-arena
pnpm install --ignore-scripts --node-linker=hoisted
node scripts/verify-data.mjs
```

临时启动测试：

```bash
PORT=3000 DATA_DIR=/var/lib/ciying-arena node apps/server/src/index.ts
```

长期运行用 systemd，示例 `/etc/systemd/system/ciying-arena.service`：

```ini
[Unit]
Description=Ciying Arena
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ciying-arena
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/ciying-arena
ExecStart=/usr/bin/node apps/server/src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/ciying-arena
sudo systemctl daemon-reload
sudo systemctl enable --now ciying-arena
sudo systemctl status ciying-arena
```

## 6. 以后怎么修改

代码结构：

```
apps/server/src         REST + WebSocket + 房间/统计
apps/web/public         前端 HTML/CSS/ES Modules（无构建）
packages/engine          笔画比较、校验、Elo、1v1 逻辑
packages/shared          共享类型与协议
datasets                 词库与笔画数据
scripts                  测试、数据校验、E2E
```

修改流程（建议在本地或测试服）：

1. 改代码。
2. 跑测试：

```bash
cd /opt/ciying-arena
node scripts/run-tests.mjs
node scripts/check-web-imports.mjs
# 可选：类型检查
node_modules/.bin/tsc -p packages/shared/tsconfig.json
node_modules/.bin/tsc -p packages/engine/tsconfig.json
node_modules/.bin/tsc -p apps/server/tsconfig.json
```

3. Docker 方式更新：

```bash
git pull
docker compose up -d --build
```

或者不用 Git，重新 `scp` 覆盖源码后执行同样的 `docker compose up -d --build`。

4. 手动方式更新：替换源码后重启：

```bash
sudo systemctl restart ciying-arena
```

注意：

- **重启会丢失当前内存中的房间/对局**（账号、天梯、比赛记录在 `data/store.json`，不会丢）。建议在没有进行中的对局时更新。
- 只改前端 `apps/web/public` 时不需要编译；Docker 方式仍要重建镜像才能把新静态文件拷进容器。
- 改 `packages/shared` 的字段时，前后端要一起改，并跑类型检查。
- 改词库时先跑 `node scripts/verify-data.mjs`，确认答案都有笔画数据。
- 不要删除 `data/store.json`；升级前先备份。

## 7. 备份与回滚

备份数据：

```bash
cd /opt/ciying-arena
mkdir -p backups
tar czf "backups/store-$(date +%F-%H%M).tgz" data/
```

Docker 回滚：

```bash
git log --oneline
git checkout <上一个可用提交>
docker compose up -d --build
```

手动部署回滚同理，`git checkout` 后重启 systemd 服务。

## 8. 常见问题

**打不开 / connection refused**

- 服务是否在运行：`docker compose ps` 或 `systemctl status ciying-arena`
- `curl http://127.0.0.1:3000/api/health` 是否 200
- Nginx 是否监听 80/443，域名是否解析到服务器

**WebSocket 连不上**

- Nginx 必须转发 `Upgrade` 和 `Connection`，并设置较长 `proxy_read_timeout`
- 不要用只支持普通 HTTP 的 CDN 直接代理 `/ws`

**页面还是旧样式**

- 浏览器 `Ctrl+F5` 强制刷新
- Docker 更新后确认镜像重建成功并重新创建了容器

**Node 版本报错**

- 本项目直接运行 TypeScript，必须 Node.js 24+
- 手动部署时 `node --version` 要确认是 24.x

**端口/数据权限**

- `DATA_DIR` 目录要让运行用户可写
- 容器内数据目录是 `/app/data`，compose 已挂载到宿主机 `./data`

**比赛数据/统计**

- 账号、天梯、比赛记录、练习统计都在 `data/store.json`
- 房间、观战、临时连接状态在内存中，重启会清空

## 9. 上线前检查清单

- [ ] 域名解析、HTTPS 证书正常
- [ ] Nginx 转发 WebSocket 正常
- [ ] 只开放 80/443，3000 不对公网开放
- [ ] `data/` 定期备份
- [ ] 确认词库、笔画数据、字体的授权
- [ ] “词影”是 Steam 游戏名，公开运营建议换独立名称
- [ ] 公开服务建议加登录/聊天限流与敏感词过滤
