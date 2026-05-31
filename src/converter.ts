import { Config } from './config';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatToolChoice,
  ResponseContentPart,
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesRequest,
  ResponsesResponse,
  ResponsesUsage,
} from './types';

/* ============================================================================
 *
 *  This module converts between three shapes:
 *    - OpenAI Chat Completion request/response (what Azure speaks)
 *    - OpenAI Responses API request/response  (the new format)
 *
 *  The proxy receives one of {ChatCompletion, Responses}; converts down to
 *  ChatCompletion; sends to Azure; then converts the upstream answer back to
 *  the originally-requested shape (streaming or not).
 *
 * ========================================================================= */

export class Converter {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  //  ChatCompletion → ChatCompletion (light cleanup for Azure)
  // ============================================================

  /**
   * Pass-through the body to Azure with minor cleanup:
   *   - delete the `model` field if the upstream is path-based (Azure uses
   *     the deployment id in the URL; some gateways tolerate `model`, others
   *     don't, so we keep it — Azure accepts it).
   *   - force `stream_options.include_usage = true` whenever streaming so we
   *     can surface usage in the final Responses event.
   */
  prepareChatRequest(req: ChatCompletionRequest, includeUsage: boolean): ChatCompletionRequest {
    const out: ChatCompletionRequest = { ...req };
    if (includeUsage && out.stream) {
      out.stream_options = { ...(out.stream_options || {}), include_usage: true };
    }
    return out;
  }

  // ============================================================
  //  Responses → ChatCompletion request
  // ============================================================

  responsesToChatRequest(req: ResponsesRequest): ChatCompletionRequest {
    if (this.config.debugLog) {
      console.log('[converter] responsesToChat input:', JSON.stringify(req).slice(0, 2048));
    }

    const messages: ChatMessage[] = [];

    if (req.instructions) {
      messages.push({ role: 'system', content: req.instructions });
    }

    if (typeof req.input === 'string') {
      messages.push({ role: 'user', content: req.input });
    } else if (Array.isArray(req.input)) {
      for (const item of req.input) {
        const converted = this.responsesInputItemToChatMessages(item);
        messages.push(...converted);
      }
    } else {
      throw new Error('input is required (string or array)');
    }

    const out: ChatCompletionRequest = {
      model: req.model || this.config.defaultModel,
      messages,
    };

    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.top_logprobs !== undefined) out.top_logprobs = req.top_logprobs;
    if (req.max_output_tokens !== undefined) out.max_completion_tokens = req.max_output_tokens;
    if (req.parallel_tool_calls !== undefined) out.parallel_tool_calls = req.parallel_tool_calls;
    if (req.stream !== undefined) out.stream = req.stream;
    if (req.user !== undefined) out.user = req.user;
    if (req.metadata !== undefined) out.metadata = req.metadata;
    if (req.store !== undefined) out.store = req.store;
    if (req.service_tier !== undefined) out.service_tier = req.service_tier;

    if (req.reasoning?.effort) out.reasoning_effort = req.reasoning.effort;
    if (req.text?.verbosity) out.verbosity = req.text.verbosity;
    if (req.text?.format) out.response_format = this.responsesFormatToChat(req.text.format);

    if (req.tools && req.tools.length > 0) {
      out.tools = req.tools
        .map(t => this.responseToolToChatTool(t))
        .filter((t): t is ChatTool => t !== null);
    }
    if (req.tool_choice !== undefined) {
      out.tool_choice = this.responseToolChoiceToChat(req.tool_choice);
    }

    return out;
  }

  private responsesInputItemToChatMessages(item: ResponseInputItem): ChatMessage[] {
    if (!item || typeof item !== 'object') return [];

    switch (item.type) {
      case 'message': {
        const role = (item as any).role as ChatMessage['role'];
        const content = (item as any).content;
        if (typeof content === 'string') {
          return [{ role, content }];
        }
        if (Array.isArray(content)) {
          // assistant message can carry output_text / refusal
          if (role === 'assistant') {
            const text = content
              .filter((p: ResponseContentPart) => p.type === 'output_text')
              .map((p: any) => p.text)
              .join('');
            const refusal = content.find((p: ResponseContentPart) => p.type === 'refusal') as any;
            const msg: ChatMessage = { role: 'assistant', content: text || null };
            if (refusal) msg.refusal = refusal.refusal;
            return [msg];
          }
          // user/system/developer can carry input_text / input_image / input_file
          const parts: any[] = [];
          for (const part of content as ResponseContentPart[]) {
            if (part.type === 'input_text') {
              parts.push({ type: 'text', text: (part as any).text });
            } else if (part.type === 'input_image') {
              const p = part as any;
              const url = p.image_url || (p.file_id ? `file://${p.file_id}` : undefined);
              if (url) {
                const ip: any = { url };
                if (p.detail) ip.detail = p.detail;
                parts.push({ type: 'image_url', image_url: ip });
              }
            } else if (part.type === 'output_text') {
              parts.push({ type: 'text', text: (part as any).text });
            }
            // input_file / others not supported by Chat Completion image_url shape — drop silently
          }
          if (parts.length === 1 && parts[0].type === 'text') {
            return [{ role, content: parts[0].text }];
          }
          return parts.length > 0 ? [{ role, content: parts }] : [];
        }
        return [];
      }

      case 'function_call': {
        const it = item as any;
        const call: ChatToolCall = {
          id: it.call_id,
          type: 'function',
          function: { name: it.name, arguments: it.arguments ?? '' },
        };
        return [{ role: 'assistant', content: null, tool_calls: [call] }];
      }

      case 'function_call_output': {
        const it = item as any;
        return [{ role: 'tool', tool_call_id: it.call_id, content: it.output ?? '' }];
      }

      case 'reasoning': {
        // The Chat Completion API has no notion of reasoning items. They are
        // a Responses-API-only construct, used to round-trip CoT between
        // turns. Drop them — Azure ignores any non-standard fields anyway.
        return [];
      }

      default:
        if (this.config.debugLog) console.warn(`[converter] dropping input item type=${(item as any).type}`);
        return [];
    }
  }

  private responseToolToChatTool(t: any): ChatTool | null {
    if (!t || t.type !== 'function') return null; // hosted tools (web_search, file_search) have no Chat Completion equivalent
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    };
  }

  private responseToolChoiceToChat(tc: any): ChatToolChoice | undefined {
    if (typeof tc === 'string') return tc as ChatToolChoice;
    if (tc && typeof tc === 'object') {
      if (tc.type === 'function' && tc.name) {
        return { type: 'function', function: { name: tc.name } };
      }
      // allowed_tools / web_search / file_search have no Chat Completion analogue
      return undefined;
    }
    return undefined;
  }

  private responsesFormatToChat(fmt: any): any {
    if (!fmt || typeof fmt !== 'object') return undefined;
    if (fmt.type === 'json_schema') {
      // Responses flattens; Chat Completion nests under json_schema
      const { type, ...rest } = fmt;
      return { type: 'json_schema', json_schema: rest };
    }
    return fmt; // text / json_object pass through unchanged
  }

  // ============================================================
  //  ChatCompletion response → Responses response (non-stream)
  // ============================================================

  chatToResponsesResponse(chat: ChatCompletionResponse, originalModel: string): ResponsesResponse {
    const id = `resp_${this.randomId(20)}`;
    const created = chat.created || Math.floor(Date.now() / 1000);
    const output: ResponseOutputItem[] = [];

    const choice = chat.choices?.[0];
    const finishReason = choice?.finish_reason;
    const msg = choice?.message;

    if (msg?.reasoning_content) {
      output.push({
        type: 'reasoning',
        id: `rs_${this.randomId(20)}`,
        summary: [{ type: 'summary_text', text: msg.reasoning_content }],
        status: 'completed',
      } as ResponseOutputItem);
    }

    if (msg?.content || msg?.refusal) {
      const parts: ResponseContentPart[] = [];
      if (msg.content) {
        parts.push({ type: 'output_text', text: msg.content, annotations: [] });
      }
      if (msg.refusal) {
        parts.push({ type: 'refusal', refusal: msg.refusal });
      }
      output.push({
        type: 'message',
        id: `msg_${this.randomId(20)}`,
        role: 'assistant',
        status: finishReason === 'length' ? 'incomplete' : 'completed',
        content: parts,
      } as ResponseOutputItem);
    }

    if (msg?.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        output.push({
          type: 'function_call',
          id: `fc_${this.randomId(20)}`,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments ?? '',
          status: 'completed',
        } as ResponseOutputItem);
      }
    }

    const status: ResponsesResponse['status'] =
      finishReason === 'length' || finishReason === 'content_filter' ? 'incomplete' : 'completed';
    const incompleteDetails =
      status === 'incomplete' && finishReason
        ? { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' }
        : null;

    const outputText = output
      .filter(o => o.type === 'message')
      .flatMap(o => (Array.isArray((o as any).content) ? (o as any).content : []))
      .filter((p: any) => p.type === 'output_text')
      .map((p: any) => p.text)
      .join('');

    return {
      id,
      object: 'response',
      created_at: created,
      status,
      error: null,
      incomplete_details: incompleteDetails,
      model: originalModel,
      instructions: null,
      previous_response_id: null,
      output,
      output_text: outputText || undefined,
      usage: this.usageChatToResponses(chat.usage),
    };
  }

  usageChatToResponses(usage?: ChatCompletionResponse['usage']): ResponsesUsage | undefined {
    if (!usage) return undefined;
    const out: ResponsesUsage = {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    };
    if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
      out.input_tokens_details = { cached_tokens: usage.prompt_tokens_details.cached_tokens };
    }
    if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
      out.output_tokens_details = { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens };
    }
    return out;
  }

  /**
   * Build an empty Responses snapshot suitable for embedding in lifecycle
   * SSE envelopes (response.created / response.in_progress / etc.). It does
   * not contain the actual output items yet — those are added by the caller.
   */
  buildResponsesSnapshot(
    req: ResponsesRequest,
    id: string,
    createdAt: number,
    status: ResponsesResponse['status']
  ): ResponsesResponse {
    return {
      id,
      object: 'response',
      created_at: createdAt,
      status,
      error: null,
      incomplete_details: null,
      model: req.model || this.config.defaultModel,
      instructions: req.instructions || null,
      previous_response_id: req.previous_response_id || null,
      output: [],
      parallel_tool_calls: req.parallel_tool_calls !== false,
      tool_choice: req.tool_choice || 'auto',
      tools: req.tools || [],
      temperature: req.temperature,
      top_p: req.top_p,
      max_output_tokens: req.max_output_tokens ?? null,
      reasoning: req.reasoning || null,
      text: req.text || { format: { type: 'text' } },
      truncation: req.truncation || 'disabled',
      background: req.background || false,
      store: req.store ?? false,
      metadata: req.metadata || {},
    };
  }

  randomId(n: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
}

/* ============================================================================
 *  Streaming converter: Chat Completion SSE → Responses API SSE
 *
 *  We consume the upstream Chat Completion event stream (`data: {...}\n\n`,
 *  terminated by `data: [DONE]\n\n`) and emit the structured Responses API
 *  event stream (`event: <type>\ndata: {...}\n\n`).
 *
 *  Sequence numbers are strictly increasing across the whole response.
 * ========================================================================= */

interface ToolCallState {
  outputIndex: number;
  fcItemId: string;
  callId: string;
  name: string;
  argumentsBuf: string;
  itemAddedEmitted: boolean;
}

export class ChatToResponsesStream {
  private converter: Converter;
  private req: ResponsesRequest;
  private model: string;
  private respId: string;
  private createdAt: number;
  private seq = 0;
  private nextOutputIndex = 0;

  private reasoningOpen = false;
  private reasoningItemId = '';
  private reasoningOutputIndex = -1;
  private reasoningTextSoFar = '';

  private messageOpen = false;
  private messageItemId = '';
  private messageOutputIndex = -1;
  private messageTextSoFar = '';

  private toolCalls: Map<number, ToolCallState> = new Map();

  private usage: ResponsesUsage | undefined;
  private finishReason: string | null = null;
  private finalContent: Array<ResponseOutputItem> = [];

  constructor(converter: Converter, req: ResponsesRequest, model: string) {
    this.converter = converter;
    this.req = req;
    this.model = model;
    this.respId = `resp_${converter.randomId(20)}`;
    this.createdAt = Math.floor(Date.now() / 1000);
  }

  /**
   * Read the upstream Chat Completion SSE stream and write Responses API SSE
   * events to the output stream.
   */
  async pump(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): Promise<void> {
    const reader = input.getReader();
    const writer = output.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const write = async (event: string, data: any) => {
      data.type = event;
      data.sequence_number = this.seq++;
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      await writer.write(encoder.encode(payload));
    };

    try {
      // 1. response.created + response.in_progress (full empty snapshot)
      const snapshotInProgress = this.converter.buildResponsesSnapshot(
        this.req, this.respId, this.createdAt, 'in_progress'
      );
      await write('response.created', { response: structuredClone(snapshotInProgress) });
      await write('response.in_progress', { response: structuredClone(snapshotInProgress) });

      // 2. process upstream chunks
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // chat completion SSE: split on newlines, "data: <json>"
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          let chunk: any;
          try { chunk = JSON.parse(data); } catch { continue; }
          await this.handleChunk(chunk, write);
        }
      }

      // 3. drain trailing buffer (in case stream ended without final newline)
      if (buffer.trim()) {
        const line = buffer.trim();
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data !== '[DONE]') {
            try {
              const chunk = JSON.parse(data);
              await this.handleChunk(chunk, write);
            } catch { /* ignore */ }
          }
        }
      }

      // 4. close any open items
      await this.closeOpenItems(write);

      // 5. response.completed
      const finalResponse = this.converter.buildResponsesSnapshot(
        this.req, this.respId, this.createdAt,
        this.finishReason === 'length' ? 'incomplete' : 'completed'
      );
      finalResponse.output = this.finalContent;
      finalResponse.output_text = this.messageTextSoFar || undefined;
      finalResponse.usage = this.usage;
      if (finalResponse.status === 'incomplete') {
        finalResponse.incomplete_details = { reason: 'max_output_tokens' };
      }
      await write(finalResponse.status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
        response: finalResponse,
      });
    } catch (e: any) {
      console.error('[converter] stream pump error', e);
      try {
        await write('error', { code: 'stream_error', message: e?.message || String(e), param: null });
      } catch { /* writer may be broken */ }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  private async handleChunk(
    chunk: any,
    write: (event: string, data: any) => Promise<void>
  ): Promise<void> {
    // usage-only chunk (when stream_options.include_usage)
    if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
      this.usage = this.converter.usageChatToResponses(chunk.usage);
      return;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    // -- reasoning_content (non-standard, e.g. DeepSeek-style proxies)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      await this.handleReasoningDelta(delta.reasoning_content, write);
    }

    // -- text content
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      await this.handleTextDelta(delta.content, write);
    }

    // -- tool calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        await this.handleToolCallDelta(tc, write);
      }
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }
  }

  private async handleReasoningDelta(
    text: string,
    write: (event: string, data: any) => Promise<void>
  ): Promise<void> {
    if (!this.reasoningOpen) {
      this.reasoningOpen = true;
      this.reasoningOutputIndex = this.nextOutputIndex++;
      this.reasoningItemId = `rs_${this.converter.randomId(20)}`;
      const item = {
        type: 'reasoning',
        id: this.reasoningItemId,
        summary: [],
        status: 'in_progress',
      };
      await write('response.output_item.added', {
        output_index: this.reasoningOutputIndex,
        item,
      });
      await write('response.reasoning_summary_part.added', {
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    this.reasoningTextSoFar += text;
    await write('response.reasoning_summary_text.delta', {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  private async handleTextDelta(
    text: string,
    write: (event: string, data: any) => Promise<void>
  ): Promise<void> {
    // Close reasoning item first if it was open and we are starting text
    if (this.reasoningOpen) {
      await this.closeReasoning(write);
    }
    if (!this.messageOpen) {
      this.messageOpen = true;
      this.messageOutputIndex = this.nextOutputIndex++;
      this.messageItemId = `msg_${this.converter.randomId(20)}`;
      await write('response.output_item.added', {
        output_index: this.messageOutputIndex,
        item: {
          id: this.messageItemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      });
      await write('response.content_part.added', {
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.messageTextSoFar += text;
    await write('response.output_text.delta', {
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta: text,
      logprobs: [],
    });
  }

  private async handleToolCallDelta(
    tc: any,
    write: (event: string, data: any) => Promise<void>
  ): Promise<void> {
    const idx: number = tc.index ?? 0;
    let state = this.toolCalls.get(idx);
    if (!state) {
      state = {
        outputIndex: -1,
        fcItemId: `fc_${this.converter.randomId(20)}`,
        callId: tc.id || `call_${this.converter.randomId(20)}`,
        name: tc.function?.name || '',
        argumentsBuf: '',
        itemAddedEmitted: false,
      };
      this.toolCalls.set(idx, state);
    }
    if (tc.id && !state.callId.startsWith('call_')) state.callId = tc.id;
    if (tc.id) state.callId = tc.id;
    if (tc.function?.name) state.name = tc.function.name;

    // We need name + call_id to emit the output_item.added event. The first
    // tool_call delta typically carries both — emit on first delta only.
    if (!state.itemAddedEmitted && state.name && state.callId) {
      // Close any open text message before starting tool calls so output
      // indices line up with the final output[] order.
      if (this.messageOpen) {
        await this.closeMessage(write);
      }
      if (this.reasoningOpen) {
        await this.closeReasoning(write);
      }
      state.outputIndex = this.nextOutputIndex++;
      state.itemAddedEmitted = true;
      await write('response.output_item.added', {
        output_index: state.outputIndex,
        item: {
          id: state.fcItemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: state.callId,
          name: state.name,
          arguments: '',
        },
      });
    }

    const argDelta: string | undefined = tc.function?.arguments;
    if (argDelta && state.itemAddedEmitted) {
      state.argumentsBuf += argDelta;
      await write('response.function_call_arguments.delta', {
        item_id: state.fcItemId,
        output_index: state.outputIndex,
        delta: argDelta,
      });
    }
  }

  private async closeReasoning(write: (event: string, data: any) => Promise<void>): Promise<void> {
    if (!this.reasoningOpen) return;
    await write('response.reasoning_summary_text.done', {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      text: this.reasoningTextSoFar,
    });
    await write('response.reasoning_summary_part.done', {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: this.reasoningTextSoFar },
    });
    const item = {
      type: 'reasoning',
      id: this.reasoningItemId,
      summary: [{ type: 'summary_text', text: this.reasoningTextSoFar }],
      status: 'completed',
    };
    await write('response.output_item.done', {
      output_index: this.reasoningOutputIndex,
      item,
    });
    this.finalContent.push(item as ResponseOutputItem);
    this.reasoningOpen = false;
  }

  private async closeMessage(write: (event: string, data: any) => Promise<void>): Promise<void> {
    if (!this.messageOpen) return;
    await write('response.output_text.done', {
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      text: this.messageTextSoFar,
      logprobs: [],
    });
    await write('response.content_part.done', {
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: this.messageTextSoFar, annotations: [] },
    });
    const item = {
      id: this.messageItemId,
      type: 'message',
      status: this.finishReason === 'length' ? 'incomplete' : 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: this.messageTextSoFar, annotations: [] }],
    };
    await write('response.output_item.done', {
      output_index: this.messageOutputIndex,
      item,
    });
    this.finalContent.push(item as ResponseOutputItem);
    this.messageOpen = false;
  }

  private async closeToolCalls(write: (event: string, data: any) => Promise<void>): Promise<void> {
    const sorted = Array.from(this.toolCalls.values()).sort((a, b) => a.outputIndex - b.outputIndex);
    for (const state of sorted) {
      if (!state.itemAddedEmitted) continue;
      await write('response.function_call_arguments.done', {
        item_id: state.fcItemId,
        output_index: state.outputIndex,
        arguments: state.argumentsBuf,
      });
      const item = {
        id: state.fcItemId,
        type: 'function_call',
        status: 'completed',
        call_id: state.callId,
        name: state.name,
        arguments: state.argumentsBuf,
      };
      await write('response.output_item.done', {
        output_index: state.outputIndex,
        item,
      });
      this.finalContent.push(item as ResponseOutputItem);
    }
  }

  private async closeOpenItems(write: (event: string, data: any) => Promise<void>): Promise<void> {
    if (this.reasoningOpen) await this.closeReasoning(write);
    if (this.messageOpen) await this.closeMessage(write);
    if (this.toolCalls.size > 0) await this.closeToolCalls(write);
  }
}

/**
 * Helper: synthesize a Responses-API SSE stream from an already-completed
 * Responses payload. Used when the upstream Chat Completion request was
 * non-streaming but the client asked for `stream: true`.
 */
export function simulateResponsesStream(resp: ResponsesResponse): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let seq = 0;
  const write = async (event: string, data: any) => {
    data.type = event;
    data.sequence_number = seq++;
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      const snapshot = { ...resp, status: 'in_progress' as const, output: [], usage: undefined };
      await write('response.created', { response: snapshot });
      await write('response.in_progress', { response: snapshot });

      for (let i = 0; i < resp.output.length; i++) {
        const item: any = resp.output[i];
        await write('response.output_item.added', {
          output_index: i,
          item: { ...item, status: 'in_progress' },
        });

        if (item.type === 'message' && Array.isArray(item.content)) {
          for (let c = 0; c < item.content.length; c++) {
            const part = item.content[c];
            if (part.type === 'output_text') {
              await write('response.content_part.added', {
                item_id: item.id,
                output_index: i,
                content_index: c,
                part: { type: 'output_text', text: '', annotations: [] },
              });
              await write('response.output_text.delta', {
                item_id: item.id,
                output_index: i,
                content_index: c,
                delta: part.text,
                logprobs: [],
              });
              await write('response.output_text.done', {
                item_id: item.id,
                output_index: i,
                content_index: c,
                text: part.text,
                logprobs: [],
              });
              await write('response.content_part.done', {
                item_id: item.id,
                output_index: i,
                content_index: c,
                part,
              });
            }
          }
        } else if (item.type === 'function_call') {
          await write('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: i,
            delta: item.arguments,
          });
          await write('response.function_call_arguments.done', {
            item_id: item.id,
            output_index: i,
            arguments: item.arguments,
          });
        } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
          for (let s = 0; s < item.summary.length; s++) {
            await write('response.reasoning_summary_part.added', {
              item_id: item.id,
              output_index: i,
              summary_index: s,
              part: { type: 'summary_text', text: '' },
            });
            await write('response.reasoning_summary_text.delta', {
              item_id: item.id,
              output_index: i,
              summary_index: s,
              delta: item.summary[s].text,
            });
            await write('response.reasoning_summary_text.done', {
              item_id: item.id,
              output_index: i,
              summary_index: s,
              text: item.summary[s].text,
            });
            await write('response.reasoning_summary_part.done', {
              item_id: item.id,
              output_index: i,
              summary_index: s,
              part: item.summary[s],
            });
          }
        }

        await write('response.output_item.done', { output_index: i, item });
      }

      await write(resp.status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
        response: resp,
      });
    } catch (e: any) {
      try {
        await write('error', { code: 'stream_error', message: e?.message || String(e) });
      } catch { /* writer broken */ }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
}
