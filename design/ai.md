# 应用内 AI 助手

> 2026-11-01 起。第一阶段已完成；后面三个阶段按顺序做。

## 目标

AI 助手内建在应用里：一个对话窗口，用户可以问笔记里的内容、让它整理笔记、帮自己学习。MCP（`folio-mcp`）是给外部 AI 工具用的，继续保留，但不是重点。

## 已定的选择

| 问题 | 决定 | 原因 |
|---|---|---|
| 模型 | 用户自己填 key，可以加多家服务商。默认 Claude（`claude-opus-5-5`），也支持 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、Kimi、Ollama、自定义） | 用户的选择；全球产品，各地能用的模型不同 |
| 修改笔记 | 设置里可选“每次先问我”（默认）或“直接修改”，类似 Claude Code / Codex | 用户的选择。第二阶段实现，设置项现在已经有了 |
| 对话记录 | 跟笔记一样同步 | 用户想在不同设备上接着之前的对话学习 |
| API key | 只存在本机系统钥匙串（Android 用 keystore 加密，不可用时存在资料库里），不同步；页面读不到 | 数据安全（ARCHITECTURE §5.6） |
| 请求从哪里发 | 由 Rust 发（`crates/folio-ai`），不由网页发 | key 不进入页面；绕开浏览器跨域限制 |

## 结构

```
ChatPanel (web/src/ai/ChatPanel.tsx)
   │ send()                     ai/chat.ts：多轮循环，最多 16 轮
   ▼
backend.aiTurn ──Tauri Channel 流式事件──▶ src-tauri/src/ai.rs ──▶ folio-ai（Anthropic / OpenAI 兼容）
backend.aiTool ─────────────────────────▶ folio_mcp::tools::call（只读工具，和 MCP 用同一套）
```

- **循环在前端。** 每一轮：Rust 调一次模型，把文字和工具调用以事件的形式流式发回；前端并行执行工具，把结果作为下一条消息发回，直到模型说完。每条消息完成时就写进对话文档，所以中途停下也会保留已有的部分。
- **Anthropic：**
  - 流式、`max_tokens` 64000、自适应思考（不传 thinking 参数）、top-level `cache_control`；
  - 工具设 `eager_input_streaming`，前端校验工具输入，不合法时回 `INVALID_JSON` 错误；
  - 检查 `max_tokens` 和 `refusal` 两种停止原因；
  - 模型返回的原始内容（含思考块）原样保存、原样发回；
  - 在 api.anthropic.com 上开启服务端回退（`server-side-fallback-2026-07-01`，`fallbacks: "default"`）。
- **OpenAI 兼容：** `chat/completions` 流式，`tool_calls` 按 index 拼接。
- **工具（只读）：** search、read_card、read_journal、get_backlinks、list_tags、find_by_tag、list_recent_cards、list_topics、topic_cards、list_tasks。用户当前看的卡片和选中的文字会随消息一起发送（输入框上方的标签可以去掉）。
- **来源：** 系统提示要求模型用 `[标题](folio:card/<id>)` 和 `[几个字](folio:block/<卡片 id>/<块 id>)` 标出来源。点击后打开卡片并定位到那个块。
- **Markdown 渲染：** 自己解析成语法树再渲染，不用 innerHTML，模型的输出不会变成页面上的标签或脚本。
- **保留回答：**
  - “存成卡片”：只保留最后一次工具调用之后的文字，链接转成卡片链接和块引用。
  - “加到今天的日记”：按粘贴的规则插入。

## 对话的存储（向后兼容）

旧版本的同步遇到不认识的文档类型或 id 前缀会报错，导致整个同步中断。所以对话不新增文档类型：

- 每个对话是一个 **board 类型的文档，id 是不带前缀的 UUID**。旧版本照常同步、保存，但不会显示：它们的白板列表来自工作区文档的 `boards`，Rust 只索引卡片。
- 对话列表放在工作区文档的 `chats` 映射里：`id → {title, created_at, updated_at, deleted_at}`。删除只记 `deleted_at`，所有设备都会看到。
- 消息存在根列表 `messages` 里，每条是 `{id, at, data: AiMessage 的 JSON, model?}`，写入后不再修改。读不懂的消息（来自更新的版本，或已损坏）会被跳过。
- 一定要通过 `openChat(id)` 打开对话，这样才会以 board 类型保存。
- 工作区文档的“是否有内容”以前只看 topics，现在也看 boards、templates、chats。（以前只有模板的工作区不会被保存，是一个潜在的 bug。）

## 阶段

1. **对话**（已完成）：
   - 对话窗口（⌘J、标签栏和手机底栏上的按钮）；
   - 服务商设置；
   - 只读工具；
   - 可点击的来源；
   - 存成卡片、加到日记；
   - 对话同步。
2. **修改笔记：** 新建卡片、追加或修改块、打标签、归入主题。
   - “每次先问我”：先展示改动，同意后才写入。
   - “直接修改”：直接写入，可以撤销。
   - 写入都走语义 API，并标注出处（AI 及模型名）。
3. **辅助学习：** 根据卡片出题、复习（间隔重复）、讲解、整理学习路线。
4. **语义检索：** 本地向量索引，补充全文搜索在近义词和跨语言上的不足。

## 还没做到的

- 还没用真实的 API key 和桌面应用端到端试过：网页版没有模型，测试用的是假模型。
- 网页版（memory 后端）只有 search 一个工具，没有模型；只用于测试。
