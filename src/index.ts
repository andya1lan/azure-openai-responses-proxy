import { Auth } from './auth';
import { AzureService } from './azure';
import { Config } from './config';
import { ChatToResponsesStream, Converter, simulateResponsesStream } from './converter';
import { StreamOptimizer } from './optimizer';
import { ChatCompletionRequest, Env, ResponsesRequest } from './types';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function jsonError(message: string, status: number, type = 'invalid_request_error'): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function checkClientAuth(request: Request, expected: string | undefined): Response | null {
  if (!expected) return null;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${expected}`) {
    return jsonError('Invalid API Key', 401, 'authentication_error');
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    let config: Config;
    try {
      config = new Config(env);
    } catch (e: any) {
      return jsonError(e.message || 'Server misconfigured', 500, 'server_error');
    }

    const auth = new Auth(config);
    const converter = new Converter(config);
    const azure = new AzureService(config, auth, converter);
    const optimizer = new StreamOptimizer(config);

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      const authErr = checkClientAuth(request, config.clientApiKey);
      if (authErr) return authErr;
      return handleChatCompletion(request, config, azure, converter, optimizer);
    }

    if (url.pathname === '/v1/responses' && request.method === 'POST') {
      const authErr = checkClientAuth(request, config.clientApiKey);
      if (authErr) return authErr;
      return handleResponses(request, config, azure, converter, optimizer);
    }

    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const authErr = checkClientAuth(request, config.clientApiKey);
      if (authErr) return authErr;
      return handleModels(config);
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};

// ============================================================
//  /v1/chat/completions
// ============================================================

async function handleChatCompletion(
  request: Request,
  config: Config,
  azure: AzureService,
  converter: Converter,
  optimizer: StreamOptimizer
): Promise<Response> {
  let body: ChatCompletionRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!body || !Array.isArray(body.messages)) {
    return jsonError('messages is required', 400);
  }

  const clientStream = body.stream === true && config.enableStreaming;
  const upstreamReq = converter.prepareChatRequest(body, clientStream);
  upstreamReq.stream = clientStream;

  console.log(`[worker] /v1/chat/completions model=${body.model} stream=${clientStream}`);

  try {
    const upstream = await azure.chatCompletion(upstreamReq);
    if (clientStream) {
      const optimized = optimizer.transformChat(
        new Response(upstream.body, {
          status: upstream.status,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
      const resp = new Response(optimized.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
      return resp;
    } else {
      const data = await azure.readJson(upstream);
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  } catch (e: any) {
    console.error('[worker] chat completion error', e);
    const status = e?.status || 502;
    return jsonError(e?.message || 'Upstream error', status, 'api_error');
  }
}

// ============================================================
//  /v1/responses
// ============================================================

async function handleResponses(
  request: Request,
  config: Config,
  azure: AzureService,
  converter: Converter,
  optimizer: StreamOptimizer
): Promise<Response> {
  let body: ResponsesRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!body || body.input === undefined || body.input === null) {
    return jsonError('input is required', 400);
  }

  const clientStream = body.stream === true && config.enableStreaming;
  const originalModel = body.model || config.defaultModel;

  let upstreamReq: ChatCompletionRequest;
  try {
    upstreamReq = converter.responsesToChatRequest(body);
    upstreamReq = converter.prepareChatRequest(upstreamReq, clientStream);
    upstreamReq.stream = clientStream;
  } catch (e: any) {
    return jsonError(e?.message || 'Conversion failed', 400);
  }

  console.log(`[worker] /v1/responses model=${originalModel} stream=${clientStream}`);

  try {
    const upstream = await azure.chatCompletion(upstreamReq);
    if (clientStream) {
      const upstreamCt = upstream.headers.get('content-type') || '';
      // If upstream returned JSON despite asking for stream, simulate.
      if (upstreamCt.includes('application/json')) {
        const data = await azure.readJson(upstream);
        const resp = converter.chatToResponsesResponse(data, originalModel);
        const sim = simulateResponsesStream(resp);
        const optimized = optimizer.transformResponses(sim);
        const final = new Response(optimized.body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
        for (const [k, v] of Object.entries(CORS_HEADERS)) final.headers.set(k, v);
        return final;
      }

      if (!upstream.body) {
        return jsonError('Upstream returned empty stream', 502, 'api_error');
      }

      const pump = new ChatToResponsesStream(converter, body, originalModel);
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      pump.pump(upstream.body, writable).catch(e => console.error('[worker] pump error', e));

      const responsesStream = new Response(readable, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
      const optimized = optimizer.transformResponses(responsesStream);
      const final = new Response(optimized.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      for (const [k, v] of Object.entries(CORS_HEADERS)) final.headers.set(k, v);
      return final;
    } else {
      const data = await azure.readJson(upstream);
      const resp = converter.chatToResponsesResponse(data, originalModel);
      return new Response(JSON.stringify(resp), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  } catch (e: any) {
    console.error('[worker] responses error', e);
    const status = e?.status || 502;
    return jsonError(e?.message || 'Upstream error', status, 'api_error');
  }
}

// ============================================================
//  /v1/models
// ============================================================

function handleModels(config: Config): Response {
  const created = Math.floor(Date.now() / 1000);
  const data = config.exposedModels.map(id => ({
    id,
    object: 'model',
    created,
    owned_by: 'azure-openai',
  }));
  return new Response(JSON.stringify({ object: 'list', data }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
