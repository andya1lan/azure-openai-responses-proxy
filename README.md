# Azure OpenAI Responses Proxy

[English](README.md) | [中文](README_CN.md)

A Cloudflare Worker that proxies an upstream **Azure OpenAI Chat Completion API** and exposes two client-facing surfaces:

- The standard **OpenAI Chat Completion API** (`/v1/chat/completions`)
- The new **OpenAI Responses API** (`/v1/responses`)

Clients can talk to your Azure deployment using either the original Chat Completion shape or the newer Responses API shape without knowing anything about Azure-specific URLs or auth headers.

## Features

- **Dual upstream endpoints**: works against the official Azure OpenAI endpoint (`https://<resource>.openai.azure.com`) **or** any compatible reverse proxy that speaks the Azure Chat Completion URL shape
- **Dual upstream auth**: `api-key` header (default Azure) or `Authorization: Bearer` (Entra ID / reverse proxies)
- **Chat Completion passthrough** with auth/URL rewriting
- **Responses API ↔ Chat Completion conversion**, both streaming and non-streaming
- **Streaming SSE** with proper `response.created` / `response.output_item.added` / `response.output_text.delta` / `response.completed` event semantics and strictly-increasing `sequence_number`s
- **Tool calling** — flat Responses tool defs are translated to nested Chat Completion tool defs, and `function_call` / `function_call_output` items round-trip correctly
- **Reasoning models** — `reasoning.effort` and non-standard `reasoning_content` deltas are surfaced as `reasoning` output items
- **Usage** — Chat Completion usage is mapped to `input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens`
- **Stream optimizer** — typewriter effect smoothing for both surfaces
- **ShadowFetch** — raw socket-level upstream fetch that drops Workers' default `cf-*` headers (useful for picky enterprise gateways)
- **CORS** preflight handled
- **API key** protection for the worker itself

## Configuration

Copy `wrangler.toml.example` to `wrangler.toml`:

```toml
[vars]
# Upstream: official Azure OpenAI endpoint or a compatible reverse proxy
AZURE_ENDPOINT     = "https://your-resource.openai.azure.com"
AZURE_API_VERSION  = "2024-10-21"
AZURE_AUTH_HEADER  = "api-key"        # or "authorization" (Bearer)

# Defaults
DEFAULT_MODEL   = "gpt-4o"
EXPOSED_MODELS  = "gpt-4o,gpt-4o-mini,gpt-5,o3-mini"
ENABLE_STREAMING = true
DEBUG_LOG       = false
```

Secrets (set with `wrangler secret put`):

| Secret | Required | Purpose |
|---|---|---|
| `AZURE_API_KEY` | yes | Upstream auth token sent in `api-key` or `Authorization: Bearer` |
| `API_KEY` | no | Bearer token clients must send to the worker |

## Endpoints

### `POST /v1/chat/completions`

Standard OpenAI Chat Completion request/response. The body is passed through to Azure largely unchanged; only `stream_options.include_usage` is forced when streaming so usage can be threaded into the response.

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"Hello!"}],
    "stream": false
  }'
```

The `model` field maps to the Azure **deployment name** (not the underlying model id).

### `POST /v1/responses`

New OpenAI Responses API. The worker translates the request into a Chat Completion call against Azure and translates the response back.

```bash
curl -X POST https://your-worker.workers.dev/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "instructions": "Be concise.",
    "input": "What is 2+2?"
  }'
```

Streaming:

```bash
curl -N -X POST https://your-worker.workers.dev/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": [
      {"type":"message","role":"user","content":[
        {"type":"input_text","text":"Tell me a joke"}
      ]}
    ],
    "stream": true
  }'
```

Supported request fields:

- `model`, `input` (string **or** array of items: `message`, `function_call`, `function_call_output`, `reasoning`)
- `instructions` (mapped to a leading `system` message)
- `tools` (`function` only — hosted tools like `web_search` are dropped)
- `tool_choice` (string, or `{type:"function", name}`)
- `max_output_tokens` → `max_completion_tokens`
- `reasoning.effort` → `reasoning_effort`
- `text.verbosity` → `verbosity`
- `text.format` (incl. `json_schema`) → `response_format`
- `temperature`, `top_p`, `top_logprobs`, `parallel_tool_calls`, `metadata`, `user`, `store`, `service_tier`, `stream`

Supported response output items:

- `message` with `output_text` and optional `refusal`
- `function_call` (with `call_id`, `name`, `arguments`)
- `reasoning` (when upstream returns the non-standard `reasoning_content` field)

The full streaming envelope is preserved: lifecycle events (`response.created`, `response.in_progress`, `response.completed` / `response.incomplete`), item events (`response.output_item.added/done`), content-part events (`response.content_part.added/done`), text deltas (`response.output_text.delta/done`), function-call arg deltas (`response.function_call_arguments.delta/done`), and reasoning summary events.

### `GET /v1/models`

Returns the deployments listed in `EXPOSED_MODELS` in OpenAI `models.list` format.

## Security

Protect the worker with `API_KEY`:

```bash
npx wrangler secret put API_KEY
```

Clients must then send `Authorization: Bearer <API_KEY>`. If `API_KEY` is unset, the worker is open.

## Development

```bash
npm install
npm run dev          # wrangler dev
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run deploy       # wrangler deploy
```

## Notes on `previous_response_id`

The Responses API has server-side state via `previous_response_id`. This worker is stateless and does **not** implement that conversation rehydration — clients must send the full `input` array on each turn. The `previous_response_id` field is accepted and echoed back in the response snapshot but not consulted.

## License

MIT
