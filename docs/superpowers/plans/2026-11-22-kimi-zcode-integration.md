# Kimi Code 与 ZCode 接入实施计划

**目标：** 将 Kimi Code、ZCode 接入渡口统一 IR、会话列表和对话查看；仅在写入协议经验证后开放为迁移目标。状态更新：ZCode 本地数据库写入、浏览器联调和真实 3.19.1 桌面端重开验收已完成；Kimi 按用户选择的“只用官方接口”保持只读。

**架构：** 复用 Harness registry、reader dispatch、镜像引擎与 UI。Kimi Code 默认使用 `~/.kimi-code`（支持 `KIMI_CODE_HOME`），通过官方 loopback Server API 只读；ZCode 默认从 `~/.zcode/cli/db/db.sqlite` 读取，并写入 session/message/part 表、`v2/tasks-index.sqlite` 和本地附件。是否可作为写入目标由 registry 的 `canWrite` 明确控制。

**Tech stack：** TypeScript、Node.js 24+、`node:sqlite`、临时存储 fixtures、真实 Kimi Code/ZCode 桌面端验收。

## 安全与范围约束

- Kimi Code 官方文档警告不要手动编辑 `sessions/` 文件；公开 Server API 支持创建 session 和提交 prompt，但没有任意 transcript 导入接口。用户明确选择只使用官方接口，因此 Kimi 保持只读；不把整段历史作为 prompt 发送，因为这会触发模型生成，无法保证原样迁移。
- ZCode 本地 schema 检查到 session/message/part 和桌面 tasks index 表后，新增写入器会检查所需列、写前快照备份、使用事务、维护序号，并按 ZCode artifact URI 格式把图片 data URL 存入会话附件目录。此路径直接写本地 SQLite，不是官方导入 API；隔离 schema、浏览器联调和真实桌面端重开验收均通过。
- 不覆盖未登记会话，不向正由客户端生成的会话写入。真实验收创建“渡口验收”测试会话并保留，不清理原有会话或上传凭据/真实聊天内容。

## 工作项

1. **已完成：** 隔离 fixtures 测试 Kimi API cursor pagination、user image、assistant tool call，以及 ZCode SQLite list/read、create/append、顺序和图片往返；新端回归共 10 项通过。
2. **已完成：** ZCode 写入器支持创建/追加消息、工具调用/结果和图片，写前备份 SQLite、校验 schema、用事务提交 session/message/part 与 desktop tasks index。浏览器端从 Claude fixture 点击“发送到 ZCode”，断言完整顺序和 2 张图片可见。真实 ZCode 3.19.1 客户端重开会话后，确认项目分组、按序显示用户/助手轮次，并可打开迁移图片预览。
3. **已完成：** 新增 origin、reader dispatch、CLI list/dump/stats、Web inventory/transcript；ZCode 显示在“发送到”菜单，Kimi 因官方接口限制仍只读。
4. **真实验收状态：** 在用户授权信任本项目目录后，于真实 ZCode 新建项目分组并创建了标识为 `DUKOU-ZCODE-REAL-*` 的合成验收会话；最新验收会话在退出并重新启动 ZCode 后成功重开，消息保持顺序，PNG 图片可见并能打开预览。测试内容为合成文字和棋盘图，不包含用户真实对话。早期格式试验留下了失败会话供排查，最新通过会话为 `DUKOU-ZCODE-REAL-20261122085017`。

## 验收门槛

- **已验证：** 原有 harness 回归（先前记录 39/39）；新端回归 10/10；Claude Code → ZCode 浏览器联调 6 条消息、顺序正确、2 张图片显示；真实 ZCode 3.19.1 重开会话、顺序和用户图片预览成功。
- **尚未通过/尚未执行：** Kimi live API 和发送（本机 Server API 未运行；官方接口不支持完整历史导入）；ZCode 端到端并发收敛。完整全套回归曾有 42/43 结果，失败项是现有实时镜像组启动前后端延迟检查（484）；不能据此称全套通过。
- 原生端验收逐项记录通过/失败；隔离回归不能代替原生客户端验收。未有安全写入路径的端不得标为双向接入完成。
- 确认凭据、真实会话数据、ZCode 数据库与 Kimi sessions 目录不进入 Git；仅在另获明确要求后推送代码。
