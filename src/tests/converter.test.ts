import { describe, it, expect } from 'vitest';
import { ChatToResponsesStream, Converter, simulateResponsesStream } from '../converter';
import { Config } from '../config';
import { ChatCompletionResponse, Env, ResponsesRequest } from '../types';

function makeConfig(extra: Partial<Env> = {}): Config {
  return new Config({
    AZURE_ENDPOINT: 'https://test.openai.azure.com',
    AZURE_API_VERSION: '2024-10-21',
    AZURE_API_KEY: 'test-key',
    DEFAULT_MODEL: 'gpt-4o',
    ENABLE_STREAMING: true,
    ...extra,
  });
}

describe('Config', () => {
  it('builds Azure URL with deployment + api-version', () => {
    const c = makeConfig();
    expect(c.chatCompletionsUrl('gpt-4o-mini')).toBe(
      'https://test.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21'
    );
  });

  it('exposes configured models', () => {
    const c = makeConfig({ EXPOSED_MODELS: 'gpt-4o, gpt-4o-mini ,gpt-5' });
    expect(c.exposedModels).toEqual(['gpt-4o', 'gpt-4o-mini', 'gpt-5']);
  });

  it('falls back to default model when none provided', () => {
    const c = makeConfig();
    expect(c.resolveDeployment(undefined)).toBe('gpt-4o');
    expect(c.resolveDeployment('')).toBe('gpt-4o');
    expect(c.resolveDeployment('gpt-5')).toBe('gpt-5');
  });
});

describe('Converter: Responses → ChatCompletion', () => {
  const converter = new Converter(makeConfig());

  it('handles string input + instructions', () => {
    const req: ResponsesRequest = {
      model: 'gpt-4o',
      input: 'Hello!',
      instructions: 'Talk like a pirate.',
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.messages).toEqual([
      { role: 'system', content: 'Talk like a pirate.' },
      { role: 'user', content: 'Hello!' },
    ]);
  });

  it('handles array input with message item (string content)', () => {
    const req: ResponsesRequest = {
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'assistant', content: 'hi' },
      ],
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('maps input_text / input_image content parts', () => {
    const req: ResponsesRequest = {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this' },
            { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'high' },
          ],
        },
      ],
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'high' } },
    ]);
  });

  it('maps function_call and function_call_output items', () => {
    const req: ResponsesRequest = {
      input: [
        { type: 'message', role: 'user', content: 'what is the weather' },
        { type: 'function_call', call_id: 'call_123', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call_output', call_id: 'call_123', output: '{"temp":"70F"}' },
      ],
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.messages).toEqual([
      { role: 'user', content: 'what is the weather' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_123', content: '{"temp":"70F"}' },
    ]);
  });

  it('flattens tool definitions (flat → nested)', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: true,
        },
      ],
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: true,
        },
      },
    ]);
  });

  it('converts tool_choice {type:function, name} → nested', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      tool_choice: { type: 'function', name: 'get_weather' },
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('drops hosted tools (web_search etc.)', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      tools: [
        { type: 'web_search' } as any,
        { type: 'function', name: 'f', parameters: {} },
      ],
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.tools).toHaveLength(1);
    expect((out.tools as any)[0].function.name).toBe('f');
  });

  it('maps max_output_tokens, reasoning.effort, text.verbosity, text.format', () => {
    const req: ResponsesRequest = {
      input: 'hi',
      max_output_tokens: 500,
      reasoning: { effort: 'high' },
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', name: 'X', schema: { type: 'object' }, strict: true },
      },
    };
    const out = converter.responsesToChatRequest(req);
    expect(out.max_completion_tokens).toBe(500);
    expect(out.reasoning_effort).toBe('high');
    expect(out.verbosity).toBe('low');
    expect(out.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'X', schema: { type: 'object' }, strict: true },
    });
  });
});

describe('Converter: ChatCompletion → Responses (non-stream)', () => {
  const converter = new Converter(makeConfig());

  it('converts a plain text response', () => {
    const chat: ChatCompletionResponse = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o-2024-11-20',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Hello, world!' },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
    const out = converter.chatToResponsesResponse(chat, 'gpt-4o');
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.model).toBe('gpt-4o');
    expect(out.output).toHaveLength(1);
    expect(out.output[0].type).toBe('message');
    const msg = out.output[0] as any;
    expect(msg.content).toEqual([{ type: 'output_text', text: 'Hello, world!', annotations: [] }]);
    expect(out.output_text).toBe('Hello, world!');
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  });

  it('emits function_call items for tool_calls', () => {
    const chat: ChatCompletionResponse = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_xyz',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
        },
      ],
    };
    const out = converter.chatToResponsesResponse(chat, 'gpt-4o');
    expect(out.output).toHaveLength(1);
    const fc = out.output[0] as any;
    expect(fc.type).toBe('function_call');
    expect(fc.call_id).toBe('call_xyz');
    expect(fc.name).toBe('get_weather');
    expect(fc.arguments).toBe('{"city":"SF"}');
  });

  it('marks length-finished as incomplete', () => {
    const chat: ChatCompletionResponse = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o',
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'partial...' } }],
    };
    const out = converter.chatToResponsesResponse(chat, 'gpt-4o');
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('surfaces non-standard reasoning_content as a reasoning item', () => {
    const chat: ChatCompletionResponse = {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'o3',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Final answer',
            reasoning_content: 'Step 1...Step 2...',
          },
        },
      ],
    };
    const out = converter.chatToResponsesResponse(chat, 'o3');
    expect(out.output[0].type).toBe('reasoning');
    expect((out.output[0] as any).summary).toEqual([{ type: 'summary_text', text: 'Step 1...Step 2...' }]);
    expect(out.output[1].type).toBe('message');
  });

  it('maps usage details', () => {
    const chat: ChatCompletionResponse = {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 80 },
      },
    };
    const out = converter.chatToResponsesResponse(chat, 'gpt-4o');
    expect(out.usage).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
      input_tokens_details: { cached_tokens: 50 },
      output_tokens_details: { reasoning_tokens: 80 },
    });
  });
});

// ============================================================
//  Streaming converter
// ============================================================

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function chatSse(chunks: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) {
        if (c === '[DONE]') {
          ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
        } else {
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
        }
      }
      ctrl.close();
    },
  });
}

function parseSseEvents(text: string): Array<{ event: string; data: any }> {
  const blocks = text.split('\n\n').filter(b => b.trim());
  return blocks.map(b => {
    let event = '';
    let dataStr = '';
    for (const line of b.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    return { event, data: dataStr ? JSON.parse(dataStr) : null };
  });
}

describe('Streaming: ChatCompletion SSE → Responses SSE', () => {
  it('emits lifecycle + text deltas for a simple text response', async () => {
    const converter = new Converter(makeConfig());
    const pump = new ChatToResponsesStream(converter, { input: 'hi', model: 'gpt-4o' }, 'gpt-4o');
    const input = chatSse([
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      '[DONE]',
    ]);
    const { readable, writable } = new TransformStream();
    const pumpPromise = pump.pump(input, writable);
    const text = await collectStream(readable);
    await pumpPromise;
    const events = parseSseEvents(text);
    const types = events.map(e => e.event);

    expect(types[0]).toBe('response.created');
    expect(types[1]).toBe('response.in_progress');
    expect(types).toContain('response.output_item.added');
    expect(types).toContain('response.content_part.added');
    expect(types.filter(t => t === 'response.output_text.delta')).toHaveLength(2);
    expect(types).toContain('response.output_text.done');
    expect(types).toContain('response.content_part.done');
    expect(types).toContain('response.output_item.done');
    expect(types[types.length - 1]).toBe('response.completed');

    // Sequence numbers are strictly increasing
    const seqs = events.map(e => e.data.sequence_number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);

    // Final response.completed should carry usage
    const completed = events[events.length - 1];
    expect(completed.data.response.usage).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
    });
    expect(completed.data.response.output_text).toBe('Hello world');
  });

  it('emits function_call events for tool calls', async () => {
    const converter = new Converter(makeConfig());
    const pump = new ChatToResponsesStream(converter, { input: 'do it', model: 'gpt-4o' }, 'gpt-4o');
    const input = chatSse([
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'do_thing', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]);
    const { readable, writable } = new TransformStream();
    const pumpPromise = pump.pump(input, writable);
    const text = await collectStream(readable);
    await pumpPromise;
    const events = parseSseEvents(text);
    const types = events.map(e => e.event);

    expect(types).toContain('response.output_item.added');
    expect(types.filter(t => t === 'response.function_call_arguments.delta')).toHaveLength(2);
    expect(types).toContain('response.function_call_arguments.done');
    expect(types[types.length - 1]).toBe('response.completed');

    const done = events.find(e => e.event === 'response.function_call_arguments.done')!;
    expect(done.data.arguments).toBe('{"x":1}');

    const completed = events[events.length - 1];
    const fc = completed.data.response.output[0];
    expect(fc.type).toBe('function_call');
    expect(fc.call_id).toBe('call_abc');
    expect(fc.name).toBe('do_thing');
    expect(fc.arguments).toBe('{"x":1}');
  });

  it('surfaces reasoning_content delta as a reasoning item', async () => {
    const converter = new Converter(makeConfig());
    const pump = new ChatToResponsesStream(converter, { input: 'hi' }, 'o3');
    const input = chatSse([
      { choices: [{ index: 0, delta: { reasoning_content: 'Step 1.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: ' Step 2.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
    const { readable, writable } = new TransformStream();
    const pumpPromise = pump.pump(input, writable);
    const text = await collectStream(readable);
    await pumpPromise;
    const events = parseSseEvents(text);
    const types = events.map(e => e.event);

    expect(types).toContain('response.reasoning_summary_part.added');
    expect(types.filter(t => t === 'response.reasoning_summary_text.delta')).toHaveLength(2);
    expect(types).toContain('response.reasoning_summary_text.done');

    const completed = events[events.length - 1];
    expect(completed.data.response.output).toHaveLength(2);
    expect(completed.data.response.output[0].type).toBe('reasoning');
    expect(completed.data.response.output[1].type).toBe('message');
  });
});

describe('simulateResponsesStream', () => {
  it('simulates a stream from a non-streaming response', async () => {
    const converter = new Converter(makeConfig());
    const chat: ChatCompletionResponse = {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi!' } }],
    };
    const resp = converter.chatToResponsesResponse(chat, 'gpt-4o');
    const stream = simulateResponsesStream(resp);
    const events = parseSseEvents(await collectStream(stream.body!));
    const types = events.map(e => e.event);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types[types.length - 1]).toBe('response.completed');
  });
});
