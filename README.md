# 渡口 · Dukou

渡口把同一段 AI 对话迁移并同步到 **Codex、Claude Code 和 DeepSeek Harness（DSH）**。它在本机读取各工具的会话存储，通过统一消息格式比较副本，再把缺少的内容写入目标工具。

![渡口 Web 界面：会话列表、对话内容与目标工具菜单](docs/screenshots/dukou-01-tree.png)

> 当前实现仍在验证中。迁移会写入各工具的本地会话文件和索引；首次使用建议先运行 `--dry-run`，并保留备份。真实会话之间可能已有历史差异，不应把“同步”理解为覆盖或自动修复。

## 功能

- 单向迁移或对已有镜像组增量同步；支持 CLI 和本机 Web 界面。
- 迁移文本、思考、工具调用与结果，以及用户、助手和工具结果中的图片。
- 图片按原始字节搬运；工具调用与结果保留关联。
- 本机实时监听镜像组变化；支持备份、幂等检查和写入前校验。

## 环境要求

- macOS；Codex、Claude Code 和/或 DSH 的本地会话存储。
- Node.js **24 或更高版本**（需要 `node:sqlite` 和 zstd 支持）。
- 如果系统 Node 版本不合适，可使用 DSH 随附运行时：

```sh
export DSH_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
```

`scripts/web.sh` 会优先使用 `DSH_NODE_EXECUTABLE`，否则使用符合要求的 `node`。

## 启动 Web 界面

```sh
npm run web
```

默认访问 <http://127.0.0.1:8787>。服务只绑定本机回环地址，**没有身份验证**；不要把它暴露到局域网或公网。

## CLI 快速开始

以下命令假设当前 `node` 为 24+；也可以把 `node` 替换为 `$DSH_NODE_EXECUTABLE`。

```sh
# 查看各工具会话数量
node src/cli.ts stats

# 列出并检查源会话
node src/cli.ts list --from dsh --limit 20
node src/cli.ts dump --from dsh --id session-<uuid> --limit 20

# 先预演：不会写入目标会话
node src/cli.ts sync --from dsh --id session-<uuid> --to codex,claude --dry-run

# 确认预演结果后执行迁移/增量同步
node src/cli.ts sync --from dsh --id session-<uuid> --to codex,claude

# 查看镜像组及副本消息数量
node src/cli.ts doctor
```

可用来源和目标为 `codex`、`claude`、`dsh`。同步台账默认写在 DSH 数据目录下；可通过 `--ledger <path>` 指定。`sync` 还支持 `--codex-home`、`--claude-home`、`--dsh-home`、`--backup` 和 `--dry-run`。导出单个新副本可使用：

```sh
node src/cli.ts export --from dsh --id session-<uuid> --to claude --home /tmp/claude-test
```

`--home` 可用于隔离测试，避免写入默认会话目录。

## 图片和迁移边界

图片会内联写入 Claude/Codex 会话；DSH 使用内容寻址附件存储。Codex 的对话图片还会写入 `imageView` 投影，以便桌面端显示。旧会话中的工具结果可能以纯文本、结构化块或历史序列化字符串保存，渡口会尽量归一化这些格式。

目标工具不支持的内容无法保证完全原生呈现；真实镜像组也可能包含迁移前已存在的差异。执行写入前请查看预演和备份，不要仅凭消息数量判断内容相同。

## 验证

```sh
npm run regression
```

浏览器测试需要先启动 Web 服务，并安装 Google Chrome（macOS 默认路径），再运行：

```sh
npm run web-browser
```

当前回归覆盖三端往返、工具调用关联、图片字节、图片投影、增量同步和幂等性。验收记录与架构说明见 [`docs/verification.md`](docs/verification.md) 和 [`docs/design.md`](docs/design.md)。真实数据检查可能因已有会话差异而失败；失败时应先调查，不要为通过测试而盲目同步或删除历史。

## 项目结构

| 目录/文件 | 内容 |
|---|---|
| `src/adapters/` | Codex、Claude Code、DSH 会话读取器 |
| `src/writers/` | 各工具原生会话写入器 |
| `src/ir.ts`、`src/mirror.ts` | 统一消息格式与迁移/同步引擎 |
| `src/ledger.ts`、`src/groups.ts` | 镜像台账与实时收敛 |
| `web/` | 本机 Web 服务、浏览器界面与 transcript 构建 |
| `scripts/` | 回归测试、浏览器测试及维护脚本 |
| `docs/` | 架构、前端设计与验收记录 |

## 安全说明

渡口直接访问本机各工具的会话文件、附件和索引数据库。迁移可能创建或追加会话，并更新本地索引和台账。请先备份重要数据、预演目标，并避免在共享机器上开放服务端口。
