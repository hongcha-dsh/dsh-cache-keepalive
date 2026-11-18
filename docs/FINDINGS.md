# 阶段 0 技术验证记录（2026-11-18）

环境：DSH Desktop；provider `blsc-anthropic`（AI 智算云中转，`https://llmapi.blsc.cn`，api=anthropic-messages）；模型 Claude-Sonnet-5.5；上下文约 13.7k token 的测试前缀。
脚本：`spike1_relay.py`、`spike2_ttl.py`、`spike3_small_max.py`（API Key 只从 `BLSC_API_KEY` 读取，不打印）。

## 中转站实测

| 项 | 结果 |
|---|---|
| 缓存 TTL | 5 分钟，实测：对照组 6.5 分钟后缓存失效，整段重新写入 |
| 返回 Usage | 含 `cache_read_input_tokens` / `cache_creation_input_tokens`，真实可用 |
| `max_tokens: 0` | 中转站**不当作 0 处理**，而是正常生成完整回答（出 594 tokens）。能命中并刷新缓存（9 分钟时仍读缓存），但会产生真实输出费用 |
| `max_tokens: 1` | 中转站直接返回假响应（`#`，input_tokens=0，无缓存字段），**不碰缓存，不刷新 TTL**（9 分钟时缓存已失效） |
| `max_tokens: 2/4/8/16` | 正常命中缓存（read=全部前缀），仅产生对应的少量输出；开/关 adaptive thinking 均可 |

结论：在这个中转站上，保活应使用 `max_tokens: 2`（最小可用值），不能用官方文档的 `0`。

## DSH 源码阅读（`@deepseek-ai/dsh-llm-pi-ai` + pi-ai 1.3.0）

- `max_tokens: options?.maxTokens ?? model.maxTokens`，传 0 会原样送出；但请求固定 `stream: true`，真实 Anthropic 不允许 `max_tokens:0` 流式，所以走 `llm.stream` 重放在官方 API 上会被拒。
- StreamChunk 的 `usage` 含 `cacheReadTokens` / `cacheWriteTokens`（`stream.ts mapUsage`）。
- pi-ai 支持 `onPayload` / `fetch` 钩子，但 DSH 适配层**没有暴露**，插件无法通过官方 API 拿到真实线上请求体。
- `compaction-basic` 的摘要请求复用会话的 tools 与 messages，专为前缀缓存对齐设计，`sessionId` 与 agent 一致。
- `dsh-cost-meter` 已在 profile 中，自带模型价格表和缓存命中统计，费用部分可复用其价格数据而不必另做。

## 尚未验证

1. 在 DSH 内通过插件复刻"最后一次请求"（`llm/stream` 事件给出 GenerateOptions，需自行转换，或包裹 fetch 抓线上请求体）。
2. 插件能否在 Idle 时调用 `compaction.compactNow()` 或 `/compact`。
3. Host 进程里的定时器在 Desktop 后台、休眠后是否可靠。

## 阶段 1：fork 实装与实测（2026-11-18）

- fork 位置：`../keepalive`（来自 hongcha-dsh/dsh-cache-keepalive v0.6.1，本地提交，未推送、未提 PR）；以 `link:` 方式装入 desktop profile。
- 改动：Claude 默认值（间隔 4 分钟）、分路由价格表、空闲后压缩（`compactAfterMinutes`，默认关）、修复 `observe()` 的 inflight 泄漏（由 ka-tester 发现）。
- 单元测试：`test/keepalive.test.mjs`，41 个用例全部通过（假 ctx + mock timers；Haiku subagent 编写）。
- 真实会话实测：本会话（Claude-Sonnet-5.5，约 24.4 万 token 上下文）开启保活，捕获后 4 分 35 秒首次重放，结果 hit：cacheRead=243998、input=2、output=16、耗时 5.5 秒，估算成本 ¥0.048（对比缓存失效重写约 ¥1.07）。
- 未实测：空闲压缩的真实触发（只在假 ctx 里验证过）。
- 空闲压缩真实实测（新建 scheduled 会话，`compactAfterMinutes=5`）：捕获 12:34:00 → 保活 1 次命中（cacheRead=75175）→ 空闲 5.2 分钟后经 `/compact` 命令压缩成功（"Compacted 11 history items (~33546 tokens)"），之后无任何多余保活或重复压缩。`agent.ctx.get('compaction')` 在该 preset 取不到，走的是命令回退通道。
- 悬浮按钮样式修复：原来在窄容器里被竖排折行，改为单行紧凑药丸「● 保活」（nowrap、不收缩）。
