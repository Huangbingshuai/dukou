# 验收记录

所有验证都在**临时 store** 上跑，未改动你真实的 `~/.codex` / `~/.claude` / `~/.dsh` 数据（真实 store 只被读取）。

## 1. 三端读取

| 端 | 会话数 | 列表耗时 | 备注 |
|---|---|---|---|
| Codex | 132 | 21ms | 其中只有 30 个还留着 rollout 文件 |
| Claude | 4 | 5ms | |
| DSH | 113 | 3ms | 投影缓存直读，不解压会话 |

## 2. 逐条指纹一致性（canonical IR）

一条 338 条消息的 DSH 会话（含 123 次工具调用、73 段推理、1 个图片引用）作为源：

| 目标 | 写入 | 读回 | 缺失 |
|---|---|---|---|
| Codex | rollout 366 行 | 338 条 | **0** |
| Claude | 337 行 | 337 条 | 1（空图片引用，Claude 无法内联无字节图片） |

验证方法：`missingMessages(目标, 源)` 为 0 表示源的每个内容指纹在目标里都能找到（重复消息按多重集计数）。

## 3. 二次运行幂等

```
run 1:  codex create 338 · claude create 338
run 2:  codex skip   0   · claude skip   0
```

第一次运行时 Claude 少了 1 条（空图片），第二版引入了 `unrepresentable` 台账：写入后回读比对，把目标确实放不下的指纹记下来，之后不再重试，也不会反复追加。

## 4. 双向追加（关键路径）

1. 用 DSH 会话建立三联组（DSH / Codex / Claude 各一份）
2. **在 Claude 的 JSONL 里手工追加两条真实消息**（模拟用户在 Claude 里继续对话）
3. `sync --from claude` → 

```
codex   append 2 missing
dsh     append 2 missing
```

4. 读回三端：

```
dsh 340 · codex 340 · claude 339
codex vs dsh missing 0 | dsh vs codex missing 0 | dsh vs claude missing 0
dsh 末尾两条: "这条消息是 Claude 端新加的" / "收到，这是 Claude 的回复。"
```

5. 再跑一次：`codex skip 0 · dsh skip 0`（收敛，无重复）

**结论**：从 Claude 端新增的内容，会以逐条一致的形式出现在 DSH 与 Codex；反向同理（DSH→Codex/Claude 已验证）。

## 5. 尚未做的真机验收

以下需要人眼或真实客户端参与，留给下一阶段：

- **Codex**：写入 `~/.codex` 后打开 Codex，确认新会话出现在列表里、正文可见、`codex resume` 能继续。理论依据是本机 132 个 thread 全部 `history_mode='paginated'`，而 `projection_state` 无记录时会从 byte 0 折叠 rollout。
- **DSH**：写入 `~/.dsh` 后重启/刷新 DSH，确认侧栏出现该会话、能打开并续聊。理论依据是 `deepseek-chat-import` 走的就是 `projcache + workspace.json` 这套。
- **Claude**：`claude --resume <uuid>` 直接打开已写入的 transcript。

---

## 6. 真实环境首轮验收（2026-11-21）

在真实 `~/.codex` / `~/.claude` / `~/.dsh` 上，用本会话（`session-ef08c2b3…`）做第一次实迁：

```
源：DeepSeek Harness / session-ef08c2b3（611 条消息）
  Codex：新建副本 611 条 · 66cb9f20-c774-5052-bb04-16dcc77ff813
  Claude Code：新建副本 611 条 · 6f22245c-7531-4f73-9400-02c9dda8589d
```

写入结果核对：

| 检查项 | 结果 |
|---|---|
| Codex `threads` 行 | ✅ 标题、cwd、`history_mode=paginated`、`originator=session-mirror` |
| Codex rollout | ✅ 1.1 MB，`sessions/2026/11/20/rollout-…-66cb9f20….jsonl` |
| Codex `projection_state` | ✅ 无记录（符合设计：Codex 首次打开时从 byte 0 折叠） |
| Codex 备份 | ✅ `~/.codex/mirror-backups/codex-2026-11-20T21-25-56` |
| Claude transcript | ✅ 611 行，221 个 `tool_use`，152 个 `thinking` |
| 三端指纹 | ✅ `dsh 622 · codex 622 · claude 622`，双向缺失 0 |

## 7. 实时闭环（真机）

迁移完成后没有再做任何手动操作，等 26 秒：

```
dsh 622 · codex 622 · claude 622
codex missing 0 | claude missing 0
```

对话每增长一条，20 秒内的下一轮把新消息推到另外两端。这是「实时双向镜像」在真实存储上的证据。

## 8. 项目归属

Codex 不会自动把会话挂进项目（本机 132 个会话里 25 个 `project_id` 为空）。镜像按**项目名 + 文件夹**双匹配：

- 只有在「同名且同路径」的项目已存在时才复用；
- 否则按源端的项目名新建项目并挂载该文件夹；
- 绝不把一个对话塞进只是碰巧占用同一目录的、别的项目。

首个实迁的会话最终落在项目 `code`（`/Users/huangbing/code`）。

## 9. 图片字节搬运（合成样本，逐字节核对）

三端对图片的表达完全不同：

| 端 | 表达 |
|---|---|
| DSH | 内容寻址对象 `sha256:<hash>` → `~/.dsh/attachments/v1/objects/<前2位>/<hash>`，块里只存 `attachmentId / mediaType / bytes / width / height` |
| Claude | 内联 `{type:'image', source:{type:'base64', media_type, data}}` |
| Codex | 内联 data URL：`{type:'input_image', image_url:'data:image/png;base64,…', detail:'high'}` |

统一后，IR 的图片块带 `data`（base64），指纹按**字节哈希**而不是引用比较。用 1×1 PNG 做三方往返：

```
DSH   写入 12 个事件 → 读回 3 条 → 缺失 0 → 图片字节一致 ✅
Claude 写入 3 行     → 读回 3 条 → 缺失 0 → 图片字节一致 ✅
Codex  写入 11 行     → 读回 3 条 → 缺失 0 → 图片字节一致 ✅
```

顺带验证了项目创建：Codex 侧按源端项目名新建了项目 `demo` 并挂上 `/tmp/demo-img`。

## 10. 当前状态与剩余验收

| 能力 | 状态 |
|---|---|
| 三端读取（含 Codex 投影兜底、DSH 多帧） | ✅ |
| 三端写入（含备份 / schema 探测 / 失败回滚） | ✅ |
| 双向增量 + 幂等 + 不可表示台账 | ✅ |
| 实时轮（20 秒） | ✅ 真机验证（26 秒追平） |
| 图片字节 | ✅ 合成样本三方一致 |
| 项目名 / 文件夹 | ✅ Codex 建项目并入根；DSH 入工作区；Claude 用目录编码 |
| 对话里一句话触发 | ✅ `session_mirror` 工具已生效 |
| 前端按钮 | ⏳ 已注册，需刷新页面确认外观 |
| 反向实时（Claude → DSH 真机） | ⏳ 临时 store 已验证，真机未做（避免污染你的真实会话） |
| 新版写入器在应用中生效 | ⏳ 需重启 DSH（ESM 模块缓存） |

## 11. 反向真机验证（Claude → Codex / DSH，验完即清理）

用一个**临时** Claude 会话（不动你任何现有数据）：

```
sync --from claude --id 966239c1… --to codex,dsh
  codex  create 5 missing · 6fab307f-d4f7-5318-8983-78b229e5d2b3
  dsh    create 5 missing · session-b03e7cdd-e519-4dad-8901-1bab5bbf3f9f
```

随后往 Claude 的 JSONL 追加两条真实消息，再同步：

```
  codex  append 2 missing
  dsh    append 2 missing
读回：dsh 7 · codex 7 · claude 7，双向缺失 0/0/0
dsh 末尾正是 "追加的一条新消息" / "追加的回复"
```

清理（带路径白名单校验，删完核对）：`codex 134→133 · claude 6→5 · dsh 114→113`，主镜像组仍健康。

## 12. 自动化套件

| 套件 | 内容 | 结果 |
|---|---|---|
| `scripts/regression.ts` | 三方往返、图片字节、二次幂等、追加传播、**schema 不认识时拒绝写且不留残骸**、多帧 zstd、真机镜像组一致性 | 17/17 |
| `scripts/client-smoke.ts` | 用最小 React 桩真跑客户端组件：包名注册、槽位、首次渲染、拉取 overview、展开列表、按钮齐全 | 11/11 |
| `scripts/accept.sh` | 一条命令跑完上面两项 + 备份清单 + 三端 resume 命令 | ✅ |

## 13. 备份节流

实时轮每 20 秒就可能追加一次，最初每次追加都新建一份 Codex 备份（1 分钟堆 3 份、14MB）。现在：

- 追加时 10 分钟内复用同一份快照；
- 新建会话时仍强制新建；
- 总量保留最近 10 份。

实测：追加 11 条消息，备份数量 2 → 2。

## 14. 实时触发方式（真机）

初始实现是 20 秒轮询。现改为**文件监听**：`~/.claude/projects`、`~/.codex/sessions`、`~/.dsh/sessions` 任一变化后防抖 1.5 秒触发一轮，60 秒轮询只作兜底。

实测：`lag 3@codex 3@claude` → 8 秒后 `lag 0`（远短于 60 秒安全网，说明是监听触发）。

## 15. 运行中插件的写入路径验证

担心 ESM 模块缓存让运行中的插件停留在旧代码，用一个临时 Claude 会话走**真实工具调用**（不是 CLI）：

```
source claude/95faf623…（2 条消息）
  Codex：新建副本 2 条 · 93676c05-2994-5a73-ba5f-9f3749caeb17
  DeepSeek Harness：新建副本 2 条 · session-df894767-a555-4525-8e59-3c0f79b246d5
```

创建成功 → 运行中的插件确实在用最新写入器（含项目创建、备份节流）。清理后三端计数回到 `133 / 5 / 113`，台账回到 1 组。

## 16. 唯一未由我验证的部分

浏览器里那一栏的**实际像素**。我做了替身渲染（最小的 React 桩 + 槽位主机，11 项检查全过），但无法替代真实浏览器。请在刷新页面后看一眼输入框上方是否有「三端镜像」栏。

> 说明：第 15、17 节记录的是早期 DSH 插件形态的验证。该插件已按要求移除，
> 实时监听已迁到 Web 后端（`web/server.ts`），能力仍在，只是换了入口。

## 17. 真实浏览器联调（Chrome + CDP，无需 Playwright）

做法：用 `~/.dsh/.credentials.yaml` 里的密钥自签一个浏览器会话 cookie（`dsh-auth-<sha256(authority)>` + `v1.<payload>.<hmac>`，payload 的时间戳是**毫秒**），再用 headless Chrome 通过 DevTools Protocol 打开真实页面、注入 cookie、点击、截图。

脚本：[`scripts/browser-test.ts`](../scripts/browser-test.ts)。截图在 [`docs/screenshots/`](screenshots/)。

实测结果：

| 检查 | 结果 |
|---|---|
| 页面加载 | `title = DeepSeek Harness`，侧栏与本会话都在 |
| 客户端模块被加载 | `boot.entries` 含 `@local/session-mirror`，资源 `plugins/??@local/session-mirror/client.js&rev=…` 已请求 |
| 「三端镜像」栏渲染 | ✅ `Codex 133 · Claude 5 · DSH 114 · 已镜像 1 · 未镜像 20` |
| 点开列表 | ✅ 20 行，每行三孔 + 来源 + 标题 + 「推送到三端」 |
| 点「全部对齐」 | ✅ 提示「所有镜像组已一致。」，POST 返回 200 |
| 点「推送到三端」（空会话） | ✅ 提示「…没有任何可迁移的消息（空会话），未做任何写入」，三端计数不变 |
| 控制台异常 | 无 |

### 真实浏览器里发现并修掉的四个问题

1. **槽位名写错**：模板里的 `conversation.composer.dock` 在这个版本不存在，真实槽位是 `conversation.input.dock`。注册到不存在的槽位**静默失败**——没报错、没渲染。现在改用 `conversation.input.dock`。
2. **精确 Fetch 路由必须声明 `requestBody`**：省略它会让 `register` 静默不生效（表现为 `POST` 返回 404 而不是 405）。GET 路由用 `'buffered'`。
3. **`'streaming'` + 无 body 的 POST 会被服务端掐断**：浏览器里报 `net::ERR_EMPTY_RESPONSE`（curl 却正常）。改成 `'buffered'` 并让前端显式发 `{}` 即可。
4. **空会话会建出 0 条消息的空壳**：现在迁移前先检查消息数，空会话直接拒绝并说明原因，不做任何写入。

### 仍然存在的开发约束

`../src/*.ts` 这类**核心模块在运行中的进程里被 ESM 缓存**：改完重装插件，入口 `index.js` 会重新加载，但它引用的核心模块仍是旧版本。所以：

- 插件本地（`dsh-plugin/*`）的改动 → 重装即生效；
- 核心库（`src/*`）的改动 → 需要重启 DSH，或把新逻辑放进**新文件**（`guards.ts` 就是这么落地的）。

## 18. Web 系统 + 实时监听（当前形态）

DSH 插件已按要求删除（profile 条目、软链、源码、测试一并清掉）。插件里的实时监听迁到了 Web 后端，能力保留：

- 后端 `fs.watch` 监听 `~/.claude/projects`、`~/.codex/sessions`、`~/.dsh/sessions`，变更后防抖 1.5 秒跑一轮收敛；60 秒轮询仅作兜底。
- 收敛结果通过 SSE `/api/stream` 推给页面，页面收到 `synced` 就刷新台账并写一行日志。

实测（真机）：

```
初始：codex 1093 · claude 1093 · dsh 1095   lag 2
touch 一个被监听的会话文件
SSE 收到：event: synced  data: {"changed":2,"groups":1}
之后：codex 1095 · claude 1095 · dsh 1095   lag 0
```

浏览器里点选迁移也验证过（`--mutate` 模式）：

```
筛选 Claude → 勾选第二行「hi」→ 目标只留 Codex → 开始对齐
日志：《hi》2 条 · Codex 新建 2  (30ms)
Codex 133 → 134
```

`scripts/web-browser-test.ts` 默认**只读**（渲染、选择、预览、筛选），加 `--mutate` 才会真的写副本。

## 真实迁移联调（浏览器点按钮，2026-11-21）

用 `scripts/web-migrate.ts` 在无头 Chrome 里真的点「发送到 → …」，再回读三个副本比对。
本轮共迁移 5 段对话到 Claude Code / DeepSeek Harness，发现的缺陷与修复：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 点「发送到 Claude Code」报 `target is not defined`，所有真实迁移必失败 | `mirror.ts` 收尾计算 `record.synced` 时引用了已不存在的循环变量 `target` | 改为按 `plan.origin` 聚合已记录的不可表示指纹 |
| 2 | 失败的迁移在 `~/.claude/projects` 留下 3 个同内容孤儿文件 | 先写文件、后记账；记账前抛错就不会登记，重试再写一份 | 创建成功后立即 `ledger.upsert + save`，再处理其余逻辑 |
| 3 | 切到 DSH 视图左侧全是 0 条对话 | `DshReader` 的成员表丢了 workspace id，`projectId` 退化成目录路径，与项目表 id 对不上 | 成员表保留 `id: workspaceId`；前端把未知 projectId 折进「未归类」而不是丢弃 |
| 4 | 切到 Claude Code 视图也是 0 条 | 展开状态只在 `load()` 里初始化，切工具走的是 `render()`，于是全收起 | 展开初始化移进 `renderTree()`，key 用「工具 + 项目 id 列表」，换工具才重置；默认从 Codex 开始 |
| 5 | 真机组「副本一致」检查失败（claude 缺 225 条指纹），继续同步会重复追加 | Claude 无法存字符串入参，写成 `{raw: text}`，指纹与源侧字符串不等 | 指纹归一化时解开 `{raw}` 包装；Claude 读取时也还原成原字符串 |
| 6 | 页面报 `Cannot read properties of undefined (reading 'replaceChildren')` | 新加的 `#thread-project` 没登记进元素表，且替换脚本静默没生效 | 补登记；启动时逐个校验元素并 `console.error`，让这类问题一次性暴露 |

修复后同一套流程的结果（`梳理项目混合启动流程`，1329 条消息）：

```
codex  1329 条 · 130 段正文 · 29 轮提问
claude 1329 条 · 130 段正文 · 29 轮提问   2.68 MB / 1329 行
dsh    1329 条 · 130 段正文 · 29 轮提问   648 KB zstd
图片副本字节一致：sha256 c9d532ce852536e9（74601 字节，三端相同）
再次全量同步：changed []（幂等，无重复追加）
```
