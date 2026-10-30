# 部署团队共享服务

这一部署适用于可信的小团队：一台 Linux 服务器、一个域名、一个 Node 服务和 SQLite 持久化卷。每个成员的 Agent 仍在自己的电脑运行。

## 部署前需要的信息

- 可用的 SSH 登录方式，或托管平台项目。
- Linux 服务器已安装 Docker Engine 和 Docker Compose v2。
- 一个域名，例如 `collab.your-team.com`，DNS A/AAAA 记录正确指向服务器。
- 80、443 端口可用；若服务器已有网站和反向代理，请先整合现有入口，不要直接抢占端口。

当前工作区没有 Docker，容器构建和启动测试交给仓库的 Linux CI。具体服务器上的 DNS、证书、存储权限和网络连通性仍需上线时验证。

## 标准 Docker Compose 部署

```sh
git clone https://github.com/maimaimangmang/agent-collab.git
cd agent-collab
cp .env.example .env
# 编辑 .env，将 DOMAIN 改为真实域名（无 https://、路径或端口）
```

生成建空间口令。若服务器装有 Node 24，可以使用 `npm run deploy:prepare`；没有 Node 时使用临时官方 Node 容器：

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:24-bookworm-slim node bin/prepare-deploy.mjs
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 app caddy
```

口令保存在 `.deployment/secrets/setup-key`，生成命令不打印内容，重复运行不会替换现有口令。主机上的父目录只允许当前用户访问；容器通过 Compose secret 挂载该文件，只给 app 服务使用。不要提交或分享这个口令给普通团队成员。

Compose 默认：

- 只让 Caddy 对外监听 80/443；Node 的 4317 端口不发布到主机。
- Caddy 自动申请 HTTPS 证书，证书存在 `caddy_data` 卷中。
- app 以非 root 用户运行，根文件系统只读，数据库写入 `app_data` 卷。
- app 与 Caddy 通过内部网络通信；app 不需要访问模型服务。
- 进程异常退出后自动重启，Caddy 等待 app 健康检查通过。

浏览器访问 `https://你的域名`。管理员在服务器本地查看口令文件，在创建空间表单输入口令。创建后保存成员访问凭证，再生成邀请链接发给团队成员。口令只控制创建空间，不用于成员登录或 Agent 执行。

## 已有反向代理或托管平台

可直接构建本项目的 Dockerfile，并配置：

| 变量 | 用途 |
| --- | --- |
| `NODE_ENV=production` | 开启部署配置检查，缺少域名或建空间口令则拒绝启动 |
| `PUBLIC_ORIGIN=https://你的域名` | 唯一公开访问来源，不含路径 |
| `AGENT_COLLAB_SETUP_KEY_FILE=/run/secrets/setup_key` | 首选：从密钥文件读取建空间口令 |
| `AGENT_COLLAB_SETUP_KEY` | 可选：平台不支持 secret 文件时，使用平台密钥环境变量；至少 32 字符 |
| `AGENT_COLLAB_DATA=/data` | 持久化目录，必须挂载持久卷 |
| `HOST=0.0.0.0` / `PORT=4317` | 容器内部监听地址 |

口令文件与口令环境变量只能配置一个。反向代理保留原始 Host、Origin、Authorization；服务只接受 PUBLIC_ORIGIN 对应的 Host 与浏览器 Origin。健康检查 `/api/health` 可通过内部 Host 调用，不返回空间数据。使用单副本，不要把 SQLite 文件放在多个服务副本共享的网络盘上。

服务不信任客户端伪造的 X-Forwarded-For。当前匿名建空间/加入限流按直连地址计算，因此通过同一个代理的访问共用每分钟 20 次额度；适用于小团队，不等于公共 SaaS 的限流设计。

## 成员接入

1. 成员打开 HTTPS 邀请链接，输入自己的名字。
2. 点击「接入我的 Agent」，选择工具并保存连接器凭证。
3. 成员在本机克隆本项目，安装 Node 24、Git 和对应 CLI，并完成 CLI 登录。
4. 在本项目目录运行 UI 给出的命令，`--repo` 指向要协作开发的仓库，`--server` 指向团队 HTTPS 地址。
5. 默认在终端逐项确认执行；连接器开始轮询后，网页会显示在线。

连接器不会把模型请求转交共享服务，仍使用本机 CLI 配置。代码和原始日志留在成员本机，团队服务保存任务与摘要。

## 首次上线验收

- 未持有建空间口令的人不能创建空间；有效邀请可以加入。
- 两个成员能看到相同目标、任务、讨论与决定。
- 两个连接器各自只能领取分配给自己的任务。
- 一项独立任务完成后进入待验收；普通成员不能代替负责人验收。
- `docker compose restart app` 后，空间与成员身份仍然有效。
- 网络恢复或服务重启后，执行结果未知的任务不会自动重跑。
- 测试 HTTPS 证书有效和外网访问，再把网址正式交给团队。

自动测试会验证状态与模拟连接器协议；真实 Codex / Claude 账号与跨电脑代码交接需要另外实测。前置依赖不会替代 Git 提交、推送和同步。

## 备份、迁移与恢复

在线备份使用 SQLite backup API，包含已提交的 WAL 内容，并执行完整性检查。目标文件已存在时拒绝覆盖。

```sh
# 容器内备份；命令会输出备份路径，不输出凭证
docker compose exec app node bin/backup.mjs
# 将输出的实际路径替换到下一条命令，复制到服务器外另存
docker compose cp app:/data/backups/实际备份文件名.sqlite ./team-backup.sqlite
chmod 600 ./team-backup.sqlite
```

备份含有团队任务、消息和凭证哈希，应像团队私有资料一样保存。仅放在同一个数据卷里不构成异机备份；请定期导出到自己的备份存储。

本机版本也能导出：`npm run backup -- /absolute/path/team-backup.sqlite`。可将这个文件迁移到服务器。换域名后浏览器不会自动带上旧访问凭证，需要用原成员凭证「恢复访问」。

恢复必须先停止 app，不能覆盖正在使用的 SQLite 文件。示例使用已确认有效的 `team-backup.sqlite`，将现有数据库及 WAL/SHM 一起移入保留目录后再恢复：

```sh
docker compose stop app
docker compose run --rm --no-deps --user root --entrypoint sh -v "$PWD/team-backup.sqlite:/restore.sqlite:ro" app -c '
set -eu
archive="/data/before-restore-$(date +%s)"
mkdir -m 700 "$archive"
for file in /data/collab.sqlite /data/collab.sqlite-wal /data/collab.sqlite-shm; do
  if [ -f "$file" ]; then mv "$file" "$archive/"; fi
done
cp /restore.sqlite /data/collab.sqlite
chown node:node /data/collab.sqlite
chmod 600 /data/collab.sqlite
'
docker compose up -d app
```

恢复到旧备份可能带回仍标为执行中的历史轮次。先确认所有成员的相关进程已经停止，再恢复和重试任务。备份恢复的版本应与运行代码匹配。

## 更新与回滚

更新前保存当前提交号并导出数据库备份，然后拉取已测试版本并执行 `docker compose up -d --build`。重建容器不会清除持久卷。不要使用 `docker compose down -v`，它会删除数据库和证书卷。

若更新不兼容，停止 app，切回已记录的代码版本，必要时按上节恢复匹配的备份。当前仍是 MVP，尚不支持滚动升级、多副本和任意版本的数据库降级。

## 参考

- [Caddy 的 HTTPS 反向代理说明](https://caddyserver.com/docs/quick-starts/reverse-proxy)
- [Docker Compose secret 文件挂载](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Node.js SQLite backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-db-path-options)
