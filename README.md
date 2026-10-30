# Agent Collab

让团队的每个人带着自己的 coding agent，在同一个空间完成同一个项目。

**当前是可本地运行的 MVP。** 共享任务、讨论、项目决定和成果记录；连接器在成员自己的电脑启动 Codex CLI 或 Claude Code，在独立 Git worktree 内执行。模型调用直接使用成员原有的 CLI 配置，不经过协作服务。

## 快速启动

需要 **Node.js 24+**。服务端没有第三方 npm 依赖。

```sh
npm start
```

打开 <http://127.0.0.1:4317>，创建空间并保存成员访问凭证。空间数据持久化到 `.agent-collab/collab.sqlite`，该目录不会提交到 Git。

1. 创建空间，填写共同目标。
2. 邀请伙伴加入。每位成员在自己的浏览器加入，获得独立身份。
3. 点击「接入我的 Agent」，选择 Codex CLI 或 Claude Code，保存一次性展示的连接器凭证。
4. 在成员电脑安装本项目，安装并登录对应 CLI；准备一个**已有提交、没有未提交改动**的目标 Git 仓库。
5. 在本项目目录运行连接命令，将 `--repo` 换成目标仓库路径。

```sh
# 凭证由 UI 生成；不要将真实凭证写进 Git
export AGENT_COLLAB_TOKEN='your-connector-token'
npm run connector -- --agent codex --repo /path/to/target-repo --watch

# 另一名成员使用自己的凭证和仓库副本
npm run connector -- --agent claude --repo /path/to/target-repo --watch
```

6. 在看板创建任务，填写说明与验收标准，分配给成员的 Agent。
7. 连接器会在成员终端显示任务并询问是否执行。只有本机输入 `y` 后才启动。需要连续自动执行时，由成员明确添加 `--auto-accept`。
8. 任务完成后进入「待验收」。负责人查看结果、检查本地代码与测试，再点击「验收通过」。

首次可选择 `demo` 类型，并运行 `npm run connector -- --agent demo --watch`。Demo 仅验证领取、消息和交付流程，不调用模型、不生成代码。

## 这版能做什么

- 一个共同目标，多个成员，各自持有自己的 Agent 连接器凭证。
- Codex CLI、Claude Code 两种适配，外加明确标记的 Demo。
- 任务分配、认领、单个前置依赖、协作提问和负责人确认的项目决定。
- SQLite 事务领取，避免两个连接器同时领取同一个任务。
- 执行心跳、取消、失联标记与人工确认后的重新派发。
- 本地独立分支与 worktree，成果摘要、改动列表、执行历史。
- 成员只能派发给自己的 Agent；负责人可以统一调度，成员仍保留本机执行确认。

**接入的是新启动的 CLI 执行，不是接管已有的 Codex 桌面聊天或 Claude 会话。** 当前也没有自动拆任务、自动唤醒其他 Agent、自动 GitHub PR 或自动合并。其他类型的 Agent 可以按 [适配器协议](docs/adapters.md) 扩展，尚不宣称已经兼容任意 Agent。

## 两个人如何交付同一项功能

例如 A 的 Codex 写登录接口，B 的 Claude Code 写接口测试：

1. 负责人在项目决定里确定请求/响应格式。
2. 创建「登录接口」与「接口测试」任务，后者依赖前者。
3. A 的连接器从 A 仓库当前已提交的 HEAD 创建 worktree。Agent 可以在空间发消息和提问。
4. A 检查成果，在该 worktree 中提交、推送，通过团队原有 Git 流程合并。
5. B 在自己的目标仓库同步合并后的提交。
6. 负责人验收前置任务，B 的任务才可以领取；新 worktree 从 B 当时的 HEAD 创建。
7. B 完成测试后提交成果，由负责人验收。

**依赖只控制任务顺序，不负责跨电脑传送代码。** UI 的「验收通过」不会自动提交、合并、推送或拉取。独立 worktree 隔离文件修改，但不能消除逻辑冲突，最终仍需集成测试。重新派发使用新的 worktree，不自动带入上一轮未提交改动。

## 成员电脑上的数据与执行权限

真实执行记录保存在目标仓库的 `.agent-collab/runs/<run-id>/`：

- `worktree/`：代码与分支；连接器不会自动删除。
- `run.json`：执行编号、任务标题和服务地址。
- `output.jsonl`：最后约 120 KB 的 CLI 标准输出，仅本机保存；标准错误显示在终端。
- `result.json`：已回传的摘要与改动列表。
- `pending-result.json`：回传失败时保存的结果。

连接器会在运行目录中创建局部 `.gitignore`，排除 `.agent-collab/` 的运行数据以及 worktree 中 `.collab/` 的快照与发件箱。不要使用 `git add --force` 将这些目录加入提交。工作目录与分支名会作为成果元数据发给团队服务，完整日志不上传。

连接器使用 Codex 的 `workspace-write` 模式和 Claude 的 `default` 权限模式，**不会添加绕过权限的参数**。CLI 的已有本地配置与授权仍然生效；工具拒绝或运行错误会报告为阻塞。Git worktree 是文件隔离机制，不是安全沙箱；此版本用于可信团队。

Agent 读取本地 `.collab/context.json` 获取目标、任务、近期成果、消息与决定，通过本地发件箱发消息。连接器持有凭证并负责网络同步。上下文每约 2 秒刷新，Agent 仍须主动读取，不保证实时打断或即时理解新消息。

## 失联、停止与恢复

服务默认给每轮执行 45 秒租约。连接器每约 2 秒续约；连续失联约 30 秒会停止本地 CLI。收到取消或达到任务时限也会停止 CLI，先发 SIGTERM，5 秒后强制终止。服务端到期则标记「失联」，阻止 Agent 再领任务。

若连接器进程本身被强制杀死，本地 CLI 可能仍在运行。因此失联任务不能自动重试；负责人需要先在成员电脑上确认进程停止，再勾选确认并重新派发。旧轮次的结果不能覆盖新轮次。

网络恢复后，可使用原 Agent 凭证回传本地结果：

```sh
npm run connector -- --recover /absolute/path/to/pending-result.json --server http://127.0.0.1:4317
```

租约已过期的结果会作为停止记录保留，不会自动变成待验收。如果任务已经被重新派发，服务会拒绝旧结果，文件仍保留供人工查看。

## 多台电脑使用

默认只监听 `127.0.0.1`。本机邀请链接无法从伙伴电脑访问。

先将服务部署到所有成员可达的机器，使用可信网络与 HTTPS 反向代理，再使用该 HTTPS 地址打开界面、生成邀请与启动连接器：

```sh
# 示例：本机反向代理连接此服务，公网入口由代理提供 HTTPS
HOST=127.0.0.1 PORT=4317 npm start

# 伙伴电脑
npm run connector -- --agent claude --server https://collab.example.com --repo /path/to/repo --watch
```

反向代理需要保留 Host、Authorization 与 Origin 请求头。连接器只对 loopback 地址允许 HTTP，其他地址必须 HTTPS。`AGENT_COLLAB_DATA` 可指定持久化目录。此版本为单实例服务；请使用 SQLite 在线备份工具，或停服后备份整个数据目录。

当前认证采用高熵 bearer token，服务端只保存哈希。成员凭证存于浏览器本地，邀请 7 天有效、最多使用 10 次。尚未实现 OAuth、凭证撤销/轮换、成员移除、完整审计与多租户运维，不适合直接作为公共 SaaS 开放注册。不要在任务、消息或决定中写入密钥。

## 开发与贡献

```sh
npm run dev
npm run check
npm test
```

测试覆盖双成员 HTTP 协作、权限隔离、并发领取、前置依赖、租约失效、取消、持久化，以及使用**模拟 CLI 子进程**在真实 Git worktree 中执行的 Codex / Claude 适配链路。测试不会调用付费模型。真实 CLI 的账号、权限与版本差异仍需做实机联调。

- [架构与状态机](docs/architecture.md)
- [适配器与 HTTP 协议](docs/adapters.md)
- [贡献指南](CONTRIBUTING.md)

MIT License。项目名暂用 Agent Collab。
