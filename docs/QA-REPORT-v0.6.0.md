# openNotion（拾贝）v0.6.0 全栈检测报告

检测日期：2026-11-01 · 分支：main（abf75b5）· 检测方式：白盒代码走查（3 路并行审查 + 主线程逐条复核）+ 黑盒自动化测试 + 生产构建实测 + Playwright 真人式 UX 走查

> **修复记录（2026-11-01）**：下文全部 12 个 P1 已修复并回归验证；P2-1（fs scope）、P2-2（token 强度）已修复。各条目末尾标注 ✅。剩余 P2/P3 未动，留作后续批次。破坏性变更提醒：**桌面端 fs 静态授权已移除**，升级后需在设置里重新选择知识库文件夹（运行时按需授权）；**relay 要求 token ≥ 12 字符**。
>
> 修复映射（P1 编号 → 改法）：
> | 条目 | 修复 |
> |------|------|
> | P1-1 冲突副本方向 | relay 下发 `origin_device`；engine 只在「本地这版输了」时存副本（推送落败 + 拉取被覆盖两路径去重），赢家不再生成自我重复副本 |
> | P1-2 marker 残留 | 副本机制重写后 marker 整体移除（每次覆盖事件天然只发生一次） |
> | P1-3 拉取吞本地编辑 | 拉取循环包进单个 Dexie 事务：事务内 hook 同步触发，抑制标志不可能误伤排队中的用户写入 |
> | P1-4 outbox setTimeout | 失败重试 3 次（间隔 1s），最终失败写入 `sync_last_error` 不再静默 |
> | P1-5 knowledge 重复索引 | reindex 复用旧条目 id（folder+path 查旧），内容刷新而非新建 |
> | P1-6 停止/开始竞态 | stopRecorder 加 stopping 短路；start 在 stopping 阶段等待停止完成再启动 |
> | P1-7 尾块落库竞态 | finalFlush 等原 handler 的 IndexedDB 写入完成（而非仅事件派发）再 resolve |
> | P1-8 多标签页恢复 | resumePendingJobs 用 Web Locks 跨标签互斥；TIMESLICE 5min→1min 使 updated_at 成为活跃录音心跳，「recording」状态走统一 stale 判定（旧实现无条件恢复会劫持正在进行的录音） |
> | P1-9 时钟/平局分叉 | relay 拒绝时间戳非法或领先 >24h 的变更（response 新增 `rejected`，客户端提示校时钟）；平局决胜两端统一为 device_id 大者胜 |
> | P1-10 级联删除 | 9 表 + kv 整段一个事务；补删 `live_caption_*` / `meeting_template_*` kv 键 |
> | P1-11 AI 删任务 | delete_task 走 subtreeIds 级联软删，undo 恢复整棵子树 |
> | P1-12 bootstrap 静默 | main.tsx catch 后渲染致命错误页（数据库打不开时不再继续在坏 DB 上跑） |
> | P2-1 fs scope | capabilities 移除全部静态 fs:scope；新增 Rust 命令 `pick_knowledge_folder`，选目录时运行时授权该目录 |
> | P2-2 token 强度 | relay 拒绝 <12 字符 token（403）；设置页令牌字段加说明 |
> | P2-4 AudioContext 泄漏 | toWav 解码完 close（try/finally） |
> | P2-6 CmdK rejection/滚动 | Enter 路径 Promise 包裹 catch；cursor 变化 scrollIntoView |
> | P2-7 AiChat 双击重复执行 | confirm/undo 加执行中守卫（executingRef），await 期间重复点击忽略 |
> | P2-9 quickAdd 日期翻滚 | monthDay 检测「Date 构造月不符」即拒绝（2月31日不再变成3月3日） |
> | P2-10 liveCaption 停止竞态 | 代际计数：start 的 await 窗口内 stop/重启会使旧 start 中止，不再创建游离识别器 |

---

## 一、总体结论

| 维度 | 结果 |
|------|------|
| TypeScript 编译 | ✅ 通过 |
| 生产构建 | ✅ 通过 |
| 端到端测试（63 个 spec / 108 用例） | ✅ 106 通过、1 跳过、1 个"失败"为检测环境工件竞争（复跑 7/7 通过，非应用 bug） |
| 断网专项（生产构建 + Service Worker） | ✅ 3/3 通过 |
| Rust 后端测试 | 见文末补记 |
| UX 走查 | 整体干净一致，3 处打磨点（见第四节） |
| 白盒审查 | **12 个 P1（数据丢失/正确性）、16 个 P2（安全/加固）、6 个 P3**，全部经主线程逐条复核确认 |

**一句话**：应用的功能基本面（黑盒）很健康，测试覆盖也扎实；但白盒发现同步子系统（v0.6.0 新功能）和录音管线存在若干**真实的数据丢失路径**，建议按第二节优先级修复后再大规模推多端同步。

---

## 二、P1 —— 数据丢失 / 功能错误（按修复优先级排序）

### 同步（多端同步 v0.6.0）

**P1-1 冲突副本生成在赢家一侧，输家静默丢版本**
`web/src/sync/engine.ts:122-143` + `relay/core.mjs:44-52`
B 先推 vB，A 后推 vA 且胜出：服务端把 conflict 推给 **A**，A 给自己已胜出的版本生成一份「（冲突副本）」——纯噪音重复。真正的输家 B 下次同步时静默被 vA 覆盖（`engine.ts:107` 守卫放行），全程收不到任何冲突通知。`core.mjs:43` 注释承诺的「两边都保留，用户自己合并」**没有实现**——输家版本只存在于服务端 log，任何客户端都拿不到。与 protocol.ts「永不丢数据」的设计目标直接矛盾。
**修法**：服务端把 conflict 同时推给输家（随 changes 下发或 conflicts 里带上 loser 视角），客户端在拉取路径也做冲突副本。

**P1-2 冲突标记 `sync_conflict_*` 永久残留，第二次冲突静默覆盖本地**
`web/src/sync/engine.ts:124-125`
marker 只写不删（全库无 delete）。同一实体一周后再次并发冲突时 `if (await db.kv.get(marker)) continue` 直接跳过副本生成——本地版本被静默覆盖，无副本、无提示。
**修法**：副本生成后删除 marker；或 marker 值记录 resolved_at。

**P1-3 拉取窗口内本地编辑被静默吞掉，永不同步**
`web/src/sync/outbox.ts:12-21` + `web/src/sync/engine.ts:101-118`
`withRemoteApply` 用模块级布尔 `applyingRemote` 抑制 hook。拉取循环逐条 `await`（get/put），期间用户任何本地写入（敲笔记、勾任务）的 hook 被 `if (applyingRemote) return` 丢弃——变更进了 IndexedDB 但不进发件箱，其它设备永远收不到。教科书级全局标志竞态。
**修法**：抑制改为按事务/按实体来源区分（如给远端写入打 `sync_applied` 标志，hook 内检查 origin），或拉取期间把被抑制的写入补进发件箱。

**P1-4 outbox 入队 setTimeout(0) + 静默 catch，变更可永久丢失**
`web/src/sync/outbox.ts:57`
hook 同步拍快照后 `setTimeout(() => enqueue(...).catch(() => {}), 0)`。应用在该 tick 内退出（Cmd+Q / 标签页被杀 / PWA 被清）→ Dexie 数据已写、outbox 行丢失，该变更永远不在 push 列表里，无任何迹象。enqueue 失败也被空 catch 吞掉。
**修法**：enqueue 失败重试 +  surfaced 到设置页「同步错误」；启动时校验（outbox 为空但实体有未同步标记）可作为兜底。

**P1-9 时钟偏差 / 平局决胜不一致 → 永久分叉**
`relay/core.mjs:14-18, 39-42` vs `web/src/sync/engine.ts:107`
① `updated_at` 无任何合法性校验：设备时钟设在 2030 年时，它对任何实体的修改都会赢下冲突决胜且无法恢复（`server_time` 已返回但客户端从不校验）。
② 平局时服务端按 device_id 字典序决胜，客户端拉取守卫 `local.updated_at >= ch.updated_at` 一律保留本地——两端对该实体永久不一致，且 cursor 已推进、永不重发。
**修法**：relay 拒绝偏离 server_time 超过阈值的 updated_at；平局决胜两端实现同一规则（device_id 大者胜）。

### 录音 / 会议管线

**P1-5 知识库 reindex 重复插入，索引无限膨胀**
`web/src/lib/knowledge.ts:95,179-203`
`readAndIndexFile` 每次生成新 `uid()`，`put` 只增不覆盖；stale 清理只删「已消失」的文件。每点一次「重新索引」，每个文件多一行副本 → 检索结果重复、表无限增长、pin 卡片（`source_entry_id`）指向旧 id 导致 pin/unpin 状态错乱。
**修法**：以 `[folder+path]` 查旧条目，有则保留原 id 更新内容。

**P1-6 stopRecorder 无并发守卫：快速双击 → 转录跑两遍；停止中 start 被静默吞**
`web/src/audio/engine.ts:300-369` + `web/src/components/RecordingBar.tsx:89`
停止按钮在 stopping 阶段不置灰；第二次 stop() 覆盖 `ondataavailable`，随后两次 `finaliseMeeting` + `runTranscribePipeline` → 双份转录/纪要/待办。反向问题：`stopping` 阶段按 ⌘⇧R 开始，`engine.ts:119 if (active) return` 静默吞掉——UI 显示已开始、实际什么都没录。
**修法**：`store.stop` 加 `phase==='stopping'` 短路；start 等 starting 链完成或显式报错。

**P1-7 尾块未落库就启动转录，录音最后一段可能永不被转写**
`web/src/audio/engine.ts:314-333`
`finalFlush` 的 resolve 在调用原 handler（async、未 await）后立即触发——等的是事件派发而非 `db.audioChunks.put` 完成。慢盘/大尾块时 `mergeAudioChunks` 读不到尾块；转录幂等跳过，无重转录入口 → 该段音频永久丢失。
**修法**：resolve 移到 handler 的 put 完成后（handler 返回 promise 并 await）。

**P1-8 多标签页重复恢复 → 双份产物；标签 B 会劫持标签 A 正在进行的录音**
`web/src/pipeline/jobs.ts:25-42` + `once.ts`
`oncePerMeeting` 是进程内 Map，跨标签页无保护；且 `'recording'` 状态不做 stale 检查（`return true`），第二个标签页 boot 时会把第一个标签页正在录的会议置为 processing 并启动转录（此时 A 还在写 chunk）。
**修法**：resume 前用 `live_caption_<id>` kv 或 BroadcastChannel 做跨标签页选主；recording 状态加 owner tab 标记。

### 数据操作

**P1-10 会议级联删除无事务，且会议行最先删**
`web/src/lib/meetingActions.ts:12-27`
9 张表顺序 await，不包 `db.transaction`；`db.meetings.delete` 排第一，中途失败/关页 → 会议已消失、孤儿转录/待办/音频无从发现无法重试。另漏删 `live_caption_<id>`、`meeting_template_<id>` 两个 kv 键（永久残留）。
**修法**：整段包事务（Dexie 事务覆盖多表），kv 键纳入清理。

**P1-11 AI 删除任务不级联，子树变「隐形活数据」**
`web/src/lib/aiActions.ts:107-116`
UI 路径走 `subtreeIds` 级联，但 `delete_task` 动作只软删单节点：子任务在树中不可见却仍 live，计入 `rollupProgress`、出现在平铺列表；undo 只恢复父节点。
**修法**：动作路径复用 `subtreeIds` 级联软删，undo 恢复整棵子树。

**P1-12 bootstrap 失败静默吞掉，全应用在坏数据库上运行**
`web/src/main.tsx:8`
`void bootstrap().finally(() => render(...))` 无 catch：Dexie 迁移失败 / IndexedDB 被禁时照常渲染，用户看到一堆莫名错误而不是「数据库打不开」的致命错误页（ErrorBoundary 管不到这里）。
**修法**：catch 后渲染致命错误页。

---

## 三、P2 —— 安全 / 加固（复核确认）

| # | 位置 | 问题 |
|---|------|------|
| P2-1 | `src-tauri/capabilities/default.json` | **fs:scope 授权 `$HOME/**`**——webview 内任何代码（含 XSS 路径）可读整个用户目录（SSH 私钥、浏览器 profile）。知识库只需要 dialog 选中的目录，应删 `$HOME/**` 改运行时授权 |
| P2-2 | `relay/worker.ts:99-119` | token 即命名空间、无强度要求——「1234」也能用；建议最小长度/熵校验 + README 警示 |
| P2-3 | `src/api/localApi.ts:90,219` | `scope` 无枚举校验直接 cast（可写入任意值污染子树）；500 响应把 Dexie 内部错误细节外泄 |
| P2-4 | `src/audio/playable.ts:15` | `new AudioContext()` 用完不 close——WebKit 上每次回放泄漏一个，累积后 `decodeAudioData` 抛错、回放永久失效 |
| P2-5 | `src-tauri/src/system_audio.rs:304-310,266,158` | start 覆盖旧 session 不停止 → SCStream 泄漏；channels=0 时整数除零 panic（FFI 边界 unwind = abort）；两处 `.expect("Sessions mutex poisoned")` 在命令边界上 |
| P2-6 | `src/components/CommandPalette.tsx:96` | 键盘路径 Enter 裸调 `run()`（reject 时 unhandled rejection）；无 focus trap / `role=dialog`；cursor 移动不 scrollIntoView |
| P2-7 | `src/components/AiChat.tsx:94-107` | 「执行」按钮双击在 await 期间重复执行破坏性动作；应先乐观移除 pending 项 |
| P2-8 | `src-tauri/src/api_server.rs:124` | 请求体超 1MB 被 `.take()` 静默截断，截断 JSON 变成莫名 500；应返回 413 |
| P2-9 | `src/pipeline/transcribe.ts:100-113` | ASR 临时失败（网络 500/key 过期）只要有实时字幕就落正式 transcript，之后幂等检查阻止重转——低精度字幕成为永久记录 |
| P2-10 | `src/lib/quickAdd.ts:35-41` | 「2月31日」静默翻滚成 3月3日；月日合法性校验缺失 |
| P2-11 | `src/pipeline/summarize.ts:154-186` | 重新生成「先删旧待办后写入」不原子，中途失败 → 待办全丢 + 会议卡在 summarizing；应包事务 |
| P2-12 | `src/lib/liveCaption.ts:54-90` | start 的 await 窗口内 stop 先执行 → start 继续创建 rec，停止丢失、识别在后台继续跑 |
| P2-13 | `src/lib/aiActions.ts:45,89` | LLM 输出的 `due_date` 不校验直接落库（「周五前」等非法值进索引字段） |
| P2-14 | `relay/worker.ts:75-79` | DO log 无界增长 + 每次全量重写 state（代码内 ponytail 注释已自认）——长期同步延迟线性劣化 |
| P2-15 | `relay/core.mjs`（内存版） | 本地内存服务器重启即 seq 归零/log 清空，各端 cursor 还是大数 → pull 永为空集，同步**静默停摆**无报错；README 需警示 |
| P2-16 | `src/audio/liveAsr.ts:85-92` | 积压时字幕按固定 5s 窗口贴时间戳，实际合并 6s/10s 时时间轴漂移；pending 无上限，长会议内存压力 |

## P3 —— 记录项

- `src/db/db.ts:57-60` v3 迁移把「有父的 task」一刀切标 `strategic`——挂在 quarterly/project KR 下的存量 task scope 标错（注释已自认近似）
- `src/lib/notes.ts:18`、`aiActions.ts:50` `sort_order: Date.now()` 同毫秒撞号
- `src/db/settings.ts:20-28` settings 缓存函数全库无调用方（死代码）
- `src/pipeline/summarize.ts:404-406` `clampedEnd = min(end, ceiling)` 恒等于 end（死代码）
- `src/App.tsx:77` dev 下 StrictMode 双跑 effect → Dexie hook 挂两份 → outbox 双份（仅影响 dev 调试同步，prod 无此问题）
- 会议删除 / summarize 等多步写路径缺事务（已在 P1-10/P2-11 列示）

## 白盒确认无问题的方面

推送幂等、出队竞态（行 id + updated_at 双匹配）、回环抑制、cursor 推进语义、tombstone 传播、relay 跨命名空间隔离、自动同步节奏钳制、OKR 纯函数层（防环/重排/rollup）、模板 seed 幂等、季度边界换算、模型下载（safe_name 防穿越 + 域名白名单含前缀陷阱测试 + .part 隔离）、API server 仅绑 127.0.0.1、ErrorBoundary 覆盖 root。

---

## 四、UX 走查结论（Notion 丝滑度标杆）

**实测通过**：slash 命令菜单（键盘全可用、菜单语义化 role）、⌘K 命令面板（搜索过滤正确、支持快速创建语义）、笔记编辑器（实时保存状态、块手柄、Tiptap 输入流畅）、设置页信息架构（分区清晰、「数据去向」透明面板是亮点）、空态引导、移动端底栏布局、 onboarding 卡片响应式。

**打磨点（不阻塞，建议排期）**：

1. **AI 工作台首屏留白过多**——1440×900 下中央只有 5 个松散的建议 chips，大片死白；不像精心设计的着陆区。建议：欢迎语 + 最近内容（最近笔记/即将到期任务/最近会议）三列卡片，把空屏变成仪表盘。
2. **移动端 375px 建议区文案左右被裁切**——「问问题，或直接让我做事——…」在窄屏溢出截断。
3. **笔记详情页正文与底部「任务/评论/反向链接」之间大片空白**——内容列顶部对齐后中部全空，可考虑内容上移或底部区块吸底。

**记录为设计决策（非缺陷）**：新安装默认强制 light 主题（`bootstrap.ts:56-58` 一次性标记），「跟随系统」需在设置中手动开启。

---

## 五、原始修复优先级建议（已全部执行完毕）

> 第一~四梯队所列条目在 2026-11-01 全部修复完成，映射见文首修复映射表。

1. **第一梯队（数据安全，建议立即）**：P1-1/1-2/1-3/1-4（同步四连——不修的话多端同步本身就是数据丢失源）、P1-12
2. **第二梯队（会议管线可靠性）**：P1-5、P1-6、P1-7、P1-8
3. **第三梯队（数据操作完整性）**：P1-9、P1-10、P1-11
4. **安全专项**：P2-1（fs scope 收窄）、P2-2（token 强度）
5. UX 打磨点随下个迭代排期

---

## 附：黑盒测试明细

| 套件 | 修复前 | 修复后 |
|------|--------|--------|
| `pnpm typecheck` | ✅ | ✅ |
| `pnpm build`（生产） | ✅ | ✅ |
| Playwright 全量（63 spec） | 106 ✅ / 1 skipped / 1 失败（检测环境工件竞争，复跑通过） | **107 ✅ / 1 skipped / 0 failed** |
| `tests/offline.spec.ts`（生产 preview） | ✅ | ✅（修复后重新构建再测） |
| Rust `cargo test` | ✅ 21 passed | ✅ 21 passed（含新增 `pick_knowledge_folder` 命令编译） |
