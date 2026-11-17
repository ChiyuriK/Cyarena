# 腾讯云 + 宝塔面板部署步骤

适用于腾讯云 CVM / 轻量应用服务器，系统为 Linux，已安装宝塔面板。推荐用 **宝塔 Docker + Nginx 反向代理**，这样不用管服务器 Node 版本。

## 0. 先确认三件事

1. 服务器地域：中国大陆的服务器绑定域名提供网站服务需要 **ICP 备案**；没备案时域名走 80/443 会被拦截。可以先用 `公网IP:3000` 测试，备案后再切域名。
2. 域名解析：腾讯云 DNS 添加 A 记录，指向服务器公网 IP。
3. 宝塔面板能登录，SSH/终端可用。

## 1. 腾讯云安全组放行端口

在腾讯云控制台的安全组/防火墙中放行：

- `22`：SSH
- `80`：HTTP
- `443`：HTTPS
- `8888`：宝塔面板（建议只对自己的 IP 开放，或改面板端口）

**不要**对公网放行 `3000`。最终只通过 Nginx 的 80/443 访问。

## 2. 宝塔安装 Docker

宝塔面板 → 软件商店 → 搜索 **Docker管理器** → 安装。

安装完成后，在宝塔面板 → 终端执行：

```bash
docker --version
docker compose version
```

如果 `docker compose` 不存在，试：

```bash
docker-compose version
```

两者都没有时，Ubuntu/Debian：

```bash
apt update
apt install -y docker-compose-plugin
```

CentOS：

```bash
yum install -y docker-compose-plugin
```

如果拉取 `node:24-alpine` 很慢，先在宝塔 Docker 设置里配置镜像加速，或在 `/etc/docker/daemon.json` 配置 registry-mirrors 后 `systemctl restart docker`。

## 3. 上传项目

### 方式 A：宝塔文件管理器上传压缩包

在你的本地 Windows 电脑打开 PowerShell：

```powershell
cd D:\DSH\BigFatFish
tar -czf ciying-arena.tar.gz --exclude=node_modules --exclude=data --exclude=.run-data* ciying-arena
```

生成 `ciying-arena.tar.gz`（约十几 MB，包含 datasets）。

宝塔面板 → 文件 → 进入 `/www/wwwroot` → 上传 `ciying-arena.tar.gz` → 右键解压。

解压后路径应为：

```text
/www/wwwroot/ciying-arena/
```

不要上传 `node_modules/`，Docker 构建时会自己安装。

### 方式 B：Git

本地项目初始化并推送到私有仓库，然后在宝塔终端：

```bash
cd /www/wwwroot
git clone <你的仓库地址> ciying-arena
```

后续更新用 `git pull` 最方便。

## 4. 启动 Docker

宝塔面板 → 终端：

```bash
cd /www/wwwroot/ciying-arena
docker compose up -d --build
```

如果只有 `docker-compose`：

```bash
docker-compose up -d --build
```

首次构建会拉取 Node 24 镜像并安装依赖，几分钟正常。构建完成后检查：

```bash
docker compose ps
curl http://127.0.0.1:3000/api/health
```

返回 `{"ok":true,...}` 就说明服务正常。

查看日志：

```bash
docker compose logs -f arena
```

compose 默认只把服务映射到 `127.0.0.1:3000`，公网访问不到 3000，这是正确的，下一步由 Nginx 反代。

## 5. 宝塔添加网站并反向代理

### 5.1 添加站点

宝塔面板 → 网站 → 添加站点：

- 域名：`ciying.example.com`（换成你的域名）
- PHP 版本：**纯静态**
- 数据库：不创建
- 根目录：默认即可，不需要把代码放这里

### 5.2 添加反向代理

网站 → 你的域名 → 设置 → 反向代理 → 添加反向代理：

- 代理名称：`ciying`
- 目标 URL：`http://127.0.0.1:3000`
- 发送域名：`$host`

保存。

### 5.3 修改 Nginx 配置（关键）

宝塔默认站点配置里通常有 `.js`、`.css`、图片的静态缓存规则。它们会拦截 `/js/main.js`、`/styles.css`，导致页面 404。必须让所有请求走反向代理。

网站 → 设置 → 配置文件，找到类似下面的规则并**删除或注释**：

```nginx
location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)$ { ... }
location ~ .*\.(js|css)?$ { ... }
```

然后在 `server { }` 内保留/添加：

```nginx
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
```

保存后：

```bash
nginx -t
systemctl reload nginx
```

WebSocket 也走 `/ws`，上面两个 `Upgrade`/`Connection` 头必须保留，否则能打开页面但进不了房间、抢答不同步。

## 6. 开启 HTTPS

网站 → 设置 → SSL → Let's Encrypt：

- 勾选域名
- 申请证书
- 开启“强制 HTTPS”

申请失败先检查：

- 域名 A 记录是否已生效
- 腾讯云安全组 80/443 是否放行
- 中国大陆服务器域名是否已备案
- 宝塔站点是否监听 80

## 7. 验证

浏览器打开：

```text
https://ciying.example.com
```

再检查接口：

```bash
curl https://ciying.example.com/api/health
```

用两个浏览器标签页测试：建房 → 加入 → 准备 → 开始 → 抢答 → 小局结算。再用手机测试一下移动端。

如果暂时没有域名，想先用公网 IP 测试：

1. 把 `docker-compose.yml` 的端口临时改成 `"3000:3000"`
2. 腾讯云安全组临时放行 3000
3. 访问 `http://服务器公网IP:3000`
4. 测试完改回 `127.0.0.1:3000:3000` 并关闭 3000

## 8. 以后怎么修改更新

### 有 Git

本地改完、测试后：

```bash
git add .
git commit -m "这次改了什么"
git push
```

服务器：

```bash
cd /www/wwwroot/ciying-arena
git pull
docker compose up -d --build
```

### 没有 Git

用宝塔文件管理器覆盖对应文件，或重新上传压缩包覆盖，然后：

```bash
cd /www/wwwroot/ciying-arena
docker compose up -d --build
```

**注意**：重启会清空当前内存中的房间，账号、天梯、比赛记录、练习统计在 `data/store.json` 里不会丢。建议没人在玩时更新。

### 改代码的位置

```text
apps/server/src         后端接口、房间、WebSocket、统计
apps/web/public         前端 HTML/CSS/JS，无构建步骤
packages/engine         笔画比较、校验、Elo、1v1 规则
packages/shared         前后端共享类型和协议
datasets                词库和笔画数据
```

前端虽然没有构建步骤，但 Docker 部署时仍要重新 build，把新文件打进镜像。

### 更新前跑测试

```bash
cd /www/wwwroot/ciying-arena
node scripts/run-tests.mjs
node scripts/check-web-imports.mjs
```

服务器没装 Node 24 跑不了也没关系，可以在本地跑完再上传。

## 9. 备份与回滚

备份数据：

```bash
cd /www/wwwroot/ciying-arena
mkdir -p backups
tar czf "backups/store-$(date +%F-%H%M).tgz" data/
```

宝塔计划任务里也可以加一个每日 shell 备份。

回滚：

```bash
git log --oneline
git checkout <上一个正常提交>
docker compose up -d --build
```

## 10. 常见问题

**502 Bad Gateway**

- `docker compose ps` 看容器是否 running
- `docker compose logs --tail=100 arena`
- 反向代理目标是否写错，必须是 `http://127.0.0.1:3000`

**页面能开但 JS/CSS 404**

- 宝塔站点配置里的 `.js`、`.css` 静态缓存 location 没删干净，被 Nginx 本地拦截了
- 确认所有请求都走 proxy_pass

**能打开页面但进不了房间 / 抢答不同步**

- Nginx 没转发 `Upgrade` 和 `Connection`
- 检查 `/ws` 是否被 CDN 或其它代理拦截

**HTTPS 申请失败**

- DNS 未生效
- 80 端口未放行
- 大陆服务器未备案
- 宝塔站点没有绑定正确域名

**Docker 构建失败**

- 服务器内存不足，建议 2G 以上或加 swap
- 拉取镜像失败，配置 Docker 镜像加速
- 用 `docker compose build --no-cache` 重试

**数据写入失败**

- `data/` 目录权限问题
- 容器内是 `/app/data`，compose 已挂载到 `/www/wwwroot/ciying-arena/data`

## 11. 上线前建议

- 宝塔面板改掉默认 8888 端口，限制来源 IP，开启面板 SSL
- 只对公网开放 80/443，3000 保持本机
- 定期备份 `data/`
- 公开运营前确认词库、笔画数据和字体的授权
- “词影”是 Steam 游戏名，建议换一个独立名称
- 如果用户量上来，把房间状态迁 Redis、账号/战绩迁 MySQL/Postgres，当前版本是单进程 JSON 存储
