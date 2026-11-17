# 把这次修改更新到服务器（保留现有数据）

适用：服务器已经用 Docker 跑着 `ciying-arena`，现在要更新到最新版本。

## 0. 先说结论

- 账号、天梯、个人统计、比赛记录都在宿主机的 `data/store.json`。
- 新版 compose 仍然把 `./data` 挂载到容器 `/app/data`，所以**只更新代码再重建容器，数据不会丢**。
- 不要删除服务器上的 `data/`，也不要把本地开发用的 `data/` 上传覆盖。
- 更新会重启服务，**当前内存里的房间/对局会清空**，建议没人在玩时操作。

## 1. 先备份数据

登录服务器（宝塔终端或 SSH）：

```bash
cd /www/wwwroot/ciying-arena
mkdir -p backups
tar czf "backups/data-before-update-$(date +%F-%H%M).tgz" data/
ls -lh backups/
```

## 2. 上传新代码

### 方式 A：Git（推荐）

```bash
cd /www/wwwroot/ciying-arena
git status
git pull
```

如果 `git status` 显示 `data/` 是未跟踪/修改状态，确认 `.gitignore` 已忽略 `data/`；不要把 `data/` 提交或覆盖。

### 方式 B：压缩包覆盖

在本地生成/使用更新包：

```powershell
cd D:\DSH\BigFatFish
tar -czf ciying-arena-update-latest.tar.gz --exclude=node_modules --exclude=data ciying-arena
```

通过宝塔文件管理器上传到 `/www/wwwroot`，解压覆盖源码目录。

**关键：覆盖时不要删除或覆盖服务器上的 `/www/wwwroot/ciying-arena/data/`。**

如果使用宝塔“解压到当前目录”，先确认压缩包内没有 `data` 目录；本次更新包已经排除 `data` 和 `node_modules`。

## 3. 重建并重启

```bash
cd /www/wwwroot/ciying-arena
docker compose up -d --build
```

如果服务器只有旧版 compose 命令：

```bash
docker-compose up -d --build
```

这个命令会重新构建镜像并重建容器，但 compose 里的：

```yaml
volumes:
  - ./data:/app/data
```

仍然指向宿主机原来的 `data`，所以账号、天梯、比赛记录会保留。

**不要执行**：

```bash
docker compose down -v
```

`-v` 可能删除卷；本项目虽然是 bind mount，也没必要冒风险。

## 4. 检查更新结果

```bash
docker compose ps
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/site
```

浏览器打开站点后按 `Ctrl+F5` 强刷，确认：

- 首页显示注册人数/在线人数
- 帮助页、更新日志页能打开
- 快速匹配会先弹规则协商
- 战绩页能打开
- 底部有 ICP 备案号

## 5. 如果出问题怎么回滚

代码回滚：

```bash
cd /www/wwwroot/ciying-arena
git log --oneline
git checkout <上一个正常提交>
docker compose up -d --build
```

数据一直在 `data/`，不会因为代码回滚丢失。如果新版本改过数据结构，回滚前最好先保留当前 `data/store.json` 的备份。

恢复数据（只在确实需要时）：

```bash
cd /www/wwwroot/ciying-arena
tar xzf backups/data-before-update-YYYYMMDD-HHMM.tgz
docker compose restart
```

## 6. 旧数据兼容说明

本次版本会自动兼容旧的 `store.json`：

- 旧用户补默认头像
- 旧比赛记录补 `rules/setHistory/forfeit/avatar/setWins` 默认值
- 旧 token/session 保留
- 新增字段不会删除旧字段

所以正常 `docker compose up -d --build` 即可，不需要手动改数据库。

## 7. 如果还没部署过

不要走“更新”，按 [DEPLOY-TENCENT-BT.md](./DEPLOY-TENCENT-BT.md) 从头部署即可；部署完成后再按本文更新。
