# 设计：三端会话实时镜像

状态：后端读链路已在本机真实数据上验证通过（2026-11-21）。

---

## 1. 存储地图（实测）

| | 正文来源 | 索引 / 列表 | 附件 |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | 无（文件即索引） | 正文内嵌 base64 / `~/.claude/projects/<slug>/memory` |
| **Codex** | ① `sessions/**/rollout-*.jsonl`（新会话才有，旧的会被压缩清除）<br>② `thread_history_1.sqlite` `thread_items.item_json`（持久投影） | `state_5.sqlite` `threads` + `projects`/`project_roots` | `~/.codex/attachments/` |
| **DSH** | `sessions/<encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd` | `storages/session_projcache/sessions/<id>.json` + `storages/workspace.json` | `~/.dsh/attachments/` |

### 1.1 Codex：投影才是正文

- `thread_history_projection_state(thread_id, next_rollout_byte_offset, next_rollout_ordinal)` 记录每个 rollout 折叠进 `thread_items` 的进度。
- 本机 132 个 threads，只有 30 个还留着 rollout 文件；其余正文**只存在于 `thread_items`**（实测从投影里完整还原了 519 条消息的会话）。
- **推论（写入侧）**：只要写出 rollout + 插一行 `threads`，**不写 projection_state**，Codex 打开该会话时会从 byte 0 自己折叠 → 不需要手工合成 `thread_items`。这使 Codex 写入成本从「三层」降到「两层」。
- 投影 item 类型：`userMessage` / `agentMessage` / `reasoning` / `commandExecution` / `mcpToolCall` / `fileChange` / `webSearch` / `imageView` / `plan` / `subAgentActivity` / `contextCompaction` 等 16 种。

### 1.2 DSH：多帧 zstd，且注入消息混在 user/message 里

- `session.v4.jsonl.zstd` 是**多帧追加**的：每次持久化写入一个独立、带 checksum 的 zstd 帧。单次 `zstdDecompressSync` 只解出第一帧（实测只得到 1 行 header；按帧解码后得到 478 帧 / 352 条消息）。
- 帧边界必须靠**结构化扫描**（帧头 + block 头）而不是搜索 magic（实测 525KB 文件里出现 478 次 magic，绝大多数是压缩数据里的巧合）。已移植 DSH 自己的 `scanZstdFrames` 到 `src/zstd.ts`。
- DSH 把运行时注入（runtime context、skill catalog、time context、tool jobs）也写成 `user/message`，只靠 `data.source.kind` 区分：实测一个会话里 `user` 4 条，`runtime-context`/`skill-catalog`/`time-context`/`tool-jobs` 共 5 条。**镜像必须按 source kind 过滤**，否则每轮同步都会多出一段注入文本。
- 写入必须满足 v4 严格校验：`seq` 稠密递增、turn/step 生命周期闭合、surface 事件带 `surfaceOp`。
- 官方写入姿势见 `@deepseek-ai/dsh-deepseek-chat-import`：`Session.create()` → `sessionPersistence.create()` → flush/close → `coldSnapshot()` → `attachSession()`。

### 1.3 Claude Code：只需文件

- 事件：`user` / `assistant` / `system` / `attachment` / `file-history-snapshot` / `mode` / `permission-mode` / `last-prompt` / `cost-state`。
- 内容块：`text` / `thinking` / `tool_use` / `tool_result` / `image`。
- `claude --resume <uuid>` 直接按文件解析，**不需要索引写入**；但目录名必须等于启动 cwd 的编码（注意 macOS `/tmp → /private/tmp`）。

---

## 2. 架构

```
                 ┌──────────────────────────────────────────────┐
  Claude store ─▶│ readers/claude   ─┐                          │
  Codex  store ─▶│ readers/codex    ─┼─▶ IR ─▶ mirror engine ─┐  │
  DSH    store ─▶│ readers/dsh      ─┘        (ledger+diff)   │  │
                 └───────────────────────────────────────────┼──┘
                                                             ▼
                 ┌──────────────────────────────────────────────┐
                 │ writers/claude   (jsonl + 目录编码)           │
                 │ writers/codex    (rollout + threads 行)       │
                 │ writers/dsh      (v4 事件流 + projcache + ws) │
                 └──────────────────────────────────────────────┘
        Host 后端：tools（Agent 一句话触发）+ HTTP 路由（前端按钮）
        Client 前端：DSH Web GUI 内的镜像控制台
```

### 2.1 收敛模型：副本 + 逐消息 id

三端日志都是**追加型**，所以镜像不做「覆盖」，而做**副本收敛**：

1. 为每条消息计算稳定 id：`sha1(origin, sourceId, role, 内容指纹)`，落在 IR 的 `Message.id` 上（已存在的原生 id 优先保留）。
2. 每个镜像组（mirror group）维护一条台账，记录三端各自的会话 id、已同步消息 id 集合、最后成功同步的内容哈希。
3. 每轮同步：取三端消息 id 的**并集**，按时间排序 → 每端只追加自己缺的部分 → 三端最终内容相同。
4. 防回环：写入时给会话打 `mirrorOrigin` 标记（DSH 用 `ignorable` 事件、Codex 用 `session_meta.source`、Claude 用一条带标记的 system 行）；读取时来自镜像的消息 id 已被台账记住，不会再次推送。

### 2.2 冲突与幂等

| 情况 | 处理 |
|---|---|
| 同一条消息三端都有 | 不写（id 命中台账） |
| 某端新增消息 | 追加到另外两端 |
| 标题不一致 | 以最近修改的一端为准（`updatedAt` 大者），写入 `session/title` / `threads.title` / 首条 user 文本 |
| 项目名/文件夹不一致 | 以源端 `cwd` 的 basename + 真实路径为准，三端各自建/复用项目 |
| 会话被删除 | 台账标记 tombstone，不自动删除另一端（需显式确认） |

### 2.3 安全边界（已确认的写入策略）

- 任何 sqlite 写入前：`state_5.sqlite` / `thread_history_1.sqlite` 先做在线备份到 `~/.dsh/migration-backups/`。
- 每次写入前探测 schema（列名/类型/`history_mode`）；不匹配 → **拒绝写入并报错**，不改任何字节。
- DSH 会话写入优先走官方 `Session` API；只有独立 CLI 模式才直接写 zstd 帧（复用 `compressFrame`，与 DSH 帧格式一致）。
- 所有写入先写临时文件，再原子 rename；`workspace.json` 用「读-改-写 + 备份」并保持 JSON 结构版本。

---

## 3. 当前代码

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/ir.ts` | IR 类型（Conversation / Message / Block）+ 标题推导 | ✅ |
| `src/paths.ts` | 三端路径、cwd 编码、有界文件发现 | ✅ |
| `src/zstd.ts` | DSH 多帧 zstd 扫描/解码/编码 | ✅ 实测 478 帧 |
| `src/adapters/codex.ts` | rollout 优先 + `thread_items` 投影兜底 | ✅ 132 会话 |
| `src/adapters/claude.ts` | JSONL → IR，含 tool_use/tool_result/thinking | ✅ 4 会话 |
| `src/adapters/dsh.ts` | 投影缓存列表 + 多帧解码 + source.kind 过滤 | ✅ 113 会话 |
| `src/cli.ts` | `list` / `dump` / `stats` | ✅ |

实测：`codex 132 / claude 4 / dsh 113` 会话，列表耗时分别 17ms / 5ms / 14ms。

## 4. 下一步

1. writers × 3 + 台账（先单向，Codex 写入做真机验收：写 → 打开 Codex → 复述哨兵）
2. Web 后端 HTTP 接口（`web/server.ts`）
3. 前端控制台（设计见 `frontend-design.md`，实现见 `web/public/`）
4. 实时镜像循环（fs.watch + 去抖 + 收敛）
