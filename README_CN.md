# Azure OpenAI Responses 代理

[English](README.md) | [中文](README_CN.md)

一个 Cloudflare Worker，代理上游的 **Azure OpenAI Chat Completion API**，同时向客户端暴露两种接口：

- 标准的 **OpenAI Chat Completion API** (`/v1/chat/completions`)
- 新的 **OpenAI Responses API** (`/v1/responses`)

客户端可以用原始的 Chat Completion 形态或新的 Responses API 形态访问 Azure 部署，对客户端而言完全感知不到 Azure 特有的 URL 结构和鉴权 header。

## 特性

- **上游端点双模式**：支持官方 Azure OpenAI 端点（`https://<resource>.openai.azure.com`），也支持任何兼容 Azure Chat Completion URL 形态的反代端点
- **上游鉴权双模式**：`api-key` header（默认 Azure）或 `Authorization: Bearer`（Entra ID / 反代）
- **Chat Completion 透传**：仅改写鉴权 / URL
- **Responses ↔ Chat Completion 双向转换**：流式与非流式都支持
- **流式 SSE**：严格按 OpenAI Responses 协议输出 `response.created` / `response.output_item.added` / `response.output_text.delta` / `response.completed`，`sequence_number` 严格递增
- **工具调用**：扁平的 Responses tool 定义会转成嵌套的 Chat Completion 形态，`function_call` / `function_call_output` 双向匹配 `call_id`
- **推理模型**：`reasoning.effort` 直通，非标准的 `reasoning_content` 增量会变成 `reasoning` 输出项
- **用量**：把 Chat Completion 的 usage 映射成 `input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens`
- **流式优化器**：两种 SSE 都带打字机平滑效果
- **ShadowFetch**：原生 socket 级别上游请求，去掉 Workers runtime 默认注入的 `cf-*` header（对挑剔的企业网关很有用）
- **CORS**：内置预检
- **API Key** 鉴权：保护 worker 自身

## 配置

将 `wrangler.toml.example` 复制为 `wrangler.toml`：

```toml
[vars]
# 上游：官方 Azure OpenAI 端点，或兼容的反代端点
AZURE_ENDPOINT     = "https://your-resource.openai.azure.com"
AZURE_API_VERSION  = "2024-10-21"
AZURE_AUTH_HEADER  = "api-key"        # 或 "authorization" (Bearer)

# 默认值
DEFAULT_MODEL   = "gpt-4o"
EXPOSED_MODELS  = "gpt-4o,gpt-4o-mini,gpt-5,o3-mini"
ENABLE_STREAMING = true
DEBUG_LOG       = false
```

Secrets（用 `wrangler secret put` 设置）：

| Secret | 必填 | 用途 |
|---|---|---|
| `AZURE_API_KEY` | 是 | 上游鉴权 token，按配置走 `api-key` 或 `Authorization: Bearer` |
| `API_KEY` | 否 | 客户端访问 worker 的 Bearer token |

## 接口

### `POST /v1/chat/completions`

标准 OpenAI Chat Completion 请求 / 响应。请求体几乎原样转发到 Azure，仅在流式时强制 `stream_options.include_usage`，以便把 usage 同步进响应。

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"你好！"}],
    "stream": false
  }'
```

`model` 字段对应 Azure 的 **部署名**，不是底层模型 id。

### `POST /v1/responses`

新版 OpenAI Responses API。Worker 会先把请求转换成 Chat Completion 形态打到 Azure，再把上游响应转换回 Responses 形态。

```bash
curl -X POST https://your-worker.workers.dev/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "instructions": "请简短作答。",
    "input": "2+2 等于多少？"
  }'
```

流式：

```bash
curl -N -X POST https://your-worker.workers.dev/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": [
      {"type":"message","role":"user","content":[
        {"type":"input_text","text":"讲个笑话"}
      ]}
    ],
    "stream": true
  }'
```

支持的请求字段：

- `model`、`input`（字符串 **或** item 数组：`message`、`function_call`、`function_call_output`、`reasoning`）
- `instructions`（会注入为首条 `system` 消息）
- `tools`（仅支持 `function` 类型，hosted tools 如 `web_search` 会被丢弃）
- `tool_choice`（字符串或 `{type:"function", name}`）
- `max_output_tokens` → `max_completion_tokens`
- `reasoning.effort` → `reasoning_effort`
- `text.verbosity` → `verbosity`
- `text.format`（含 `json_schema`）→ `response_format`
- `temperature`、`top_p`、`top_logprobs`、`parallel_tool_calls`、`metadata`、`user`、`store`、`service_tier`、`stream`

支持的响应 output 项：

- `message`（含 `output_text` 和可选 `refusal`）
- `function_call`（`call_id`、`name`、`arguments`）
- `reasoning`（上游返回非标准 `reasoning_content` 时）

完整保留了流式协议：生命周期事件（`response.created`、`response.in_progress`、`response.completed` / `response.incomplete`）、item 事件（`response.output_item.added/done`）、content part 事件（`response.content_part.added/done`）、文本增量（`response.output_text.delta/done`）、函数参数增量（`response.function_call_arguments.delta/done`），以及 reasoning summary 事件。

### `GET /v1/models`

按 OpenAI `models.list` 格式返回 `EXPOSED_MODELS` 配置的部署列表。

## 安全

启用 worker 的客户端鉴权：

```bash
npx wrangler secret put API_KEY
```

客户端需要带 `Authorization: Bearer <API_KEY>`。若未设置 `API_KEY`，worker 对外是开放的。

## 开发

```bash
npm install
npm run dev          # wrangler dev
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run deploy       # wrangler deploy
```

## 关于 `previous_response_id`

OpenAI Responses API 通过 `previous_response_id` 提供服务端的对话状态。本 worker 是无状态的，**不会** 还原历史对话——客户端每轮都需要带完整的 `input` 数组。`previous_response_id` 会被接受并回显到响应快照中，但不会被解析。

## License

MIT
