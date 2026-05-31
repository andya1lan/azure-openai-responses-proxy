import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_FILTER_RE = /^(host|accept-encoding|cf-)/i;

function concatUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr as any, offset);
    offset += arr.length;
  }
  return result;
}

function parseHttpHeaders(buff: Uint8Array): any {
  const text = decoder.decode(buff);
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headerSection = text.slice(0, headerEnd).split('\r\n');
  const statusLine = headerSection[0];
  const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
  if (!statusMatch) throw new Error(`Invalid Status Line: ${statusLine}`);
  const headers = new Headers();
  for (let i = 1; i < headerSection.length; i++) {
    const line = headerSection[i];
    const idx = line.indexOf(': ');
    if (idx !== -1) {
      headers.append(line.slice(0, idx), line.slice(idx + 2));
    }
  }
  return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
}

async function* readChunks(reader: any, buff: Uint8Array = new Uint8Array()): AsyncGenerator<Uint8Array> {
  while (true) {
    let pos = -1;
    for (let i = 0; i < buff.length - 1; i++) {
      if (buff[i] === 13 && buff[i + 1] === 10) {
        pos = i;
        break;
      }
    }
    if (pos === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      buff = concatUint8Arrays(buff, value as any);
      continue;
    }

    const sizeLine = decoder.decode(buff.slice(0, pos));
    const size = parseInt(sizeLine, 16);
    if (isNaN(size)) {
      throw new Error(`Invalid chunk size: ${sizeLine}`);
    }
    if (size === 0) break;

    buff = buff.slice(pos + 2);
    while (buff.length < size + 2) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Unexpected EOF in chunked encoding');
      buff = concatUint8Arrays(buff, value);
    }
    yield buff.slice(0, size);
    buff = buff.slice(size + 2);
  }
}

async function parseResponse(reader: any): Promise<Response> {
  let buff: any = new Uint8Array();
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buff = concatUint8Arrays(buff, value as any);
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        const isChunked = headers.get('transfer-encoding')?.includes('chunked');
        const contentLength = parseInt(headers.get('content-length') || '0', 10);
        const data = buff.slice(headerEnd + 4);

        return new Response(
          new ReadableStream({
            async start(ctrl) {
              try {
                if (isChunked) {
                  for await (const chunk of readChunks(reader, data)) {
                    ctrl.enqueue(chunk);
                  }
                } else {
                  let received = data.length;
                  if (data.length) ctrl.enqueue(data);
                  while (received < contentLength) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    received += value.length;
                    ctrl.enqueue(value);
                  }
                }
                ctrl.close();
              } catch (err) {
                console.error('Error parsing response stream', err);
                ctrl.error(err);
              }
            },
          }),
          { status, statusText, headers }
        );
      }
    }
    if (done) break;
  }
  throw new Error('Failed to parse response headers');
}

function safeHeadersToString(headers: Headers): string {
  let result = '';
  headers.forEach((value, key) => {
    result += `${key}: ${value}\r\n`;
  });
  return result;
}

/**
 * Direct socket-level fetch that bypasses the Workers runtime's default
 * header injection. Useful when upstream gateways are picky about extra
 * `cf-*` headers being added to the request.
 */
export async function shadowFetch(input: Request | string, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const targetUrl = url;

  const cleanedHeaders = new Headers();
  if (req.headers) {
    req.headers.forEach((v, k) => {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    });
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((v, k) => {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    });
  }

  cleanedHeaders.set('Host', targetUrl.hostname);
  cleanedHeaders.set('Connection', 'close');
  cleanedHeaders.set('Accept-Encoding', 'identity');

  let bodyBuffer: Uint8Array | null = null;
  if (req.body) {
    const buffer = await req.arrayBuffer();
    bodyBuffer = new Uint8Array(buffer);
    cleanedHeaders.set('Content-Length', bodyBuffer.length.toString());
  } else {
    cleanedHeaders.set('Content-Length', '0');
  }

  const isSecure = targetUrl.protocol === 'https:';
  const port = targetUrl.port || (isSecure ? '443' : '80');

  const socket = connect(
    { hostname: targetUrl.hostname, port: Number(port) },
    { secureTransport: isSecure ? 'on' : 'off', allowHalfOpen: false }
  );

  const writer = socket.writable.getWriter();

  const method = req.method;
  const requestLine = `${method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
    safeHeadersToString(cleanedHeaders) +
    '\r\n';

  await writer.write(encoder.encode(requestLine));

  if (bodyBuffer) {
    await writer.write(bodyBuffer);
  }

  return parseResponse(socket.readable.getReader());
}
