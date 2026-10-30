# 适配器协议（MVP）

当前协议是本项目内部的 HTTP / JSON 协议，尚未声明兼容 A2A、ACP 或 MCP。Codex 与 Claude 适配分支位于 `bin/connector.mjs`，以后可抽成独立包。

## 连接器协议

请求使用 `Authorization: Bearer <connector-token>`；POST 使用 `Content-Type: application/json`。

| 请求 | 输入 | 返回 / 行为 |
| --- | --- | --- |
| `GET /api/worker/next` | — | `{kind,task}`，无可领任务时 task=null；更新在线时间 |
| `POST /api/worker/claim` | `{taskId,kind}` | `{runId,runToken,task,context,leaseMs}`；事务领取 |
| `POST /api/worker/heartbeat` | `{runId,worktree?,branch?,baseCommit?}` | `{cancel}`；续租或要求停止 |
| `POST /api/worker/finish` | `{runId,outcome,summary,artifact?}` | outcome 为 success/error/cancelled；返回最终状态 |

`summary` 最多 16000 字符；`artifact` 是文本摘要，最多保留 16000 字符，当前不上传 diff 文件。客户端应检查 HTTP 状态，409 通常表示任务冲突、执行已替换或租约失效，不能无限重试领取。

新适配器必须：

1. 将本地授权与“已分配任务”分开；默认让成员知道将执行什么。
2. 在领取后续租，并且在失联、取消和超时时停止本地执行。
3. 为每一轮执行建立独立工作目录，避免同时修改同一个 checkout。
4. 提供可验证的最终结果；CLI 退出码为 0 但缺少最终消息不能报告 success。
5. 处理工具权限拒绝、进程错误与不完整结果，不能伪装成功。
6. 不将团队访问凭证、模型密钥或原始日志上传到消息空间。
7. 将待回传结果持久化，以便网络恢复后人工重放。

## 执行上下文与消息

以下请求使用领取时返回的 `runToken`，只在当前运行租约内有效：

- `GET /api/run/context`：共同目标、当前任务、任务列表、近期结果、项目决定和最近消息。
- `POST /api/run/message`：`{messageId,kind,content}`，kind 是 message/question/blocked。`messageId` 由发送方生成并在重试时保持不变。content 最多 4000 字符。

`question` 是讨论消息，不自动停止任务。`blocked` 记录无法继续的原因；CLI 结束后进入待协作。服务端不会把模型消息变成负责人决定。

当前内置连接器通过本地文件邮箱替 Agent 调用这些接口，避免依赖 CLI 沙箱里的 localhost 网络权限：

```sh
node /path/to/agent-collab/bin/collab.mjs --mailbox /path/to/worktree/.collab context
node /path/to/agent-collab/bin/collab.mjs --mailbox /path/to/worktree/.collab message '接口字段已经确定'
node /path/to/agent-collab/bin/collab.mjs --mailbox /path/to/worktree/.collab question '分页是否从 1 开始？'
node /path/to/agent-collab/bin/collab.mjs --mailbox /path/to/worktree/.collab block '缺少测试数据，需要成员补充'
```

## 新类型的最小改动

1. 在 `Store.register` 的 kind 白名单里增加类型，并更新 UI 下拉选项。
2. 在连接器增加启动参数、输出解析、权限错误判断；保持相同领取与租约逻辑。
3. 用模拟可执行程序测试 worktree 隔离、消息、成功、工具拒绝和取消。
4. 使用真实 CLI 完成一次单任务，再验证跨成员任务依赖与代码同步；记录 CLI 版本。

`demo` 也遵循相同领取与交付协议，但所有输出明确标记为模拟，不应作为真实模型兼容性证明。
