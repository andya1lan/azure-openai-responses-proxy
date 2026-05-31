import { Config } from './config';

interface SSEFormatHandler {
  splitBlocks(buffer: string): { blocks: string[]; remaining: string };
  processBlock(
    block: string,
    writer: WritableStreamDefaultWriter,
    encoder: TextEncoder,
    delay: number,
    isStreamEnding: boolean,
    typewriterBudget: number
  ): Promise<number>;
  onStreamEnd?(writer: WritableStreamDefaultWriter, encoder: TextEncoder): Promise<void>;
  formatError(message: string): string;
}

export class StreamOptimizer {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get minDelay() { return 5; }
  get maxDelay() { return 40; }
  get adaptiveDelayFactor() { return 0.5; }
  get chunkBufferSize() { return 5; }
  get minContentLengthForFastOutput() { return 1000; }
  get fastOutputDelay() { return 2; }
  get finalLowDelay() { return 2; }
  get typewriterThreshold() { return 800; }

  /** Wrap an OpenAI Chat-Completion SSE stream. */
  transformChat(response: Response): Response {
    return this.wrapResponse(response, this.chatHandler());
  }

  /** Wrap an OpenAI Responses-API SSE stream. */
  transformResponses(response: Response): Response {
    return this.wrapResponse(response, this.responsesHandler());
  }

  // ==================== Core ====================

  private wrapResponse(response: Response, handler: SSEFormatHandler): Response {
    if (!response.body) return response;
    const { readable, writable } = new TransformStream();
    this.coreStreamProcessor(response.body, writable, handler);
    return new Response(readable, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  private async coreStreamProcessor(
    inputStream: ReadableStream,
    outputStream: WritableStream,
    handler: SSEFormatHandler
  ) {
    const reader = inputStream.getReader();
    const writer = outputStream.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    let buffer = '';
    let lastChunkTime = Date.now();
    let recentChunkSizes: number[] = [];
    let currentDelay = this.minDelay;
    let isStreamEnding = false;
    let maxSingleChunkSize = 0;
    let fastOutputMode = false;
    let totalContentOutput = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          isStreamEnding = true;
          if (buffer.length > 0) {
            const { blocks } = handler.splitBlocks(buffer + '\n\n');
            for (const block of blocks) {
              if (block.trim()) {
                const contentLen = await handler.processBlock(
                  block, writer, encoder, this.minDelay, true,
                  Math.max(0, this.typewriterThreshold - totalContentOutput)
                );
                totalContentOutput += contentLen;
              }
            }
          }
          if (handler.onStreamEnd) {
            await handler.onStreamEnd(writer, encoder);
          }
          break;
        }

        const currentTime = Date.now();
        const timeSinceLastChunk = currentTime - lastChunkTime;
        lastChunkTime = currentTime;

        if (value && value.length) {
          recentChunkSizes.push(value.length);
          if (recentChunkSizes.length > this.chunkBufferSize) recentChunkSizes.shift();
          maxSingleChunkSize = Math.max(maxSingleChunkSize, value.length);

          if (!fastOutputMode && maxSingleChunkSize > this.minContentLengthForFastOutput) {
            fastOutputMode = true;
          }

          const avgChunkSize = recentChunkSizes.reduce((a, b) => a + b, 0) / recentChunkSizes.length;

          if (fastOutputMode) {
            currentDelay = this.fastOutputDelay;
          } else {
            currentDelay = this.adaptDelay(avgChunkSize, timeSinceLastChunk, isStreamEnding);
          }

          buffer += decoder.decode(value, { stream: true });
          const { blocks, remaining } = handler.splitBlocks(buffer);
          buffer = remaining;

          for (const block of blocks) {
            if (block.trim()) {
              const contentLen = await handler.processBlock(
                block, writer, encoder, currentDelay, isStreamEnding,
                Math.max(0, this.typewriterThreshold - totalContentOutput)
              );
              totalContentOutput += contentLen;
            }
          }
        }
      }
    } catch (e) {
      console.error('Stream processing error', e);
      try {
        await writer.write(encoder.encode(handler.formatError('Stream error')));
      } catch { /* writer may already be broken */ }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  adaptDelay(chunkSize: number, timeSinceLastChunk: number, isStreamEnding: boolean): number {
    if (chunkSize <= 0) return this.minDelay;
    if (isStreamEnding) return this.finalLowDelay;

    const sizeInverseFactor = 1 + Math.log(1 + Math.min(chunkSize, 200)) / Math.log(20);
    const normalizedSizeFactor = 1 / Math.max(0.5, Math.min(2.0, sizeInverseFactor));

    const normalizedTime = Math.min(2000, Math.max(50, timeSinceLastChunk));
    const timeFactor = Math.sqrt(normalizedTime / 300);

    const adaptiveDelay =
      this.minDelay +
      (this.maxDelay - this.minDelay) * normalizedSizeFactor * timeFactor * this.adaptiveDelayFactor;
    const baseDelay = Math.min(this.maxDelay, Math.max(this.minDelay, adaptiveDelay));
    const randomFactor = 0.9 + Math.random() * 0.2;

    return baseDelay * randomFactor;
  }

  private async sendCharByChar(
    text: string,
    buildChunk: (char: string) => string,
    writer: WritableStreamDefaultWriter,
    encoder: TextEncoder,
    delay: number,
    isStreamEnding: boolean
  ) {
    for (let i = 0; i < text.length; i++) {
      await writer.write(encoder.encode(buildChunk(text[i])));
      if (i < text.length - 1 && delay > 0) {
        const actualDelay = isStreamEnding ? this.finalLowDelay : delay;
        await new Promise(resolve => setTimeout(resolve, actualDelay));
      }
    }
  }

  // ==================== Chat Completions handler ====================

  private chatHandler(): SSEFormatHandler {
    return {
      splitBlocks: (buffer: string) => {
        const lines = buffer.split('\n');
        const remaining = lines.pop() || '';
        return { blocks: lines, remaining };
      },

      processBlock: async (line, writer, encoder, delay, isStreamEnding, typewriterBudget): Promise<number> => {
        if (!line.trim()) {
          await writer.write(encoder.encode('\n'));
          return 0;
        }
        if (!line.startsWith('data: ')) {
          await writer.write(encoder.encode(`${line}\n`));
          return 0;
        }
        const data = line.slice(6);
        if (data === '[DONE]') return 0;

        try {
          const jsonData = JSON.parse(data);
          const content = jsonData.choices?.[0]?.delta?.content;
          if (content && typeof content === 'string') {
            if (typewriterBudget > 0) {
              const twLen = Math.min(content.length, typewriterBudget);
              await this.sendCharByChar(
                content.substring(0, twLen),
                char => `data: ${JSON.stringify({
                  ...jsonData,
                  choices: [{ ...jsonData.choices[0], delta: { content: char } }]
                })}\n\n`,
                writer, encoder, delay, isStreamEnding
              );
              if (twLen < content.length) {
                const rest = {
                  ...jsonData,
                  choices: [{ ...jsonData.choices[0], delta: { content: content.substring(twLen) } }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(rest)}\n\n`));
              }
            } else {
              await writer.write(encoder.encode(`data: ${JSON.stringify(jsonData)}\n\n`));
            }
            return content.length;
          }
        } catch { /* fall through – pass raw */ }
        await writer.write(encoder.encode(`data: ${data}\n\n`));
        return 0;
      },

      onStreamEnd: async (writer, encoder) => {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      },

      formatError: msg =>
        `data: ${JSON.stringify({ error: { message: msg, type: 'stream_error', code: 500 } })}\n\n`,
    };
  }

  // ==================== Responses API handler ====================

  private responsesHandler(): SSEFormatHandler {
    return {
      splitBlocks: (buffer: string) => {
        const parts = buffer.split('\n\n');
        const remaining = parts.pop() || '';
        return { blocks: parts, remaining };
      },

      processBlock: async (block, writer, encoder, delay, isStreamEnding, typewriterBudget): Promise<number> => {
        let eventType = '';
        let dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr = line.slice(6);
        }
        if (!eventType || !dataStr) {
          if (block.trim()) await writer.write(encoder.encode(`${block}\n\n`));
          return 0;
        }

        if (eventType === 'response.output_text.delta') {
          try {
            const jsonData = JSON.parse(dataStr);
            const text: string | undefined = jsonData.delta;
            if (text && typewriterBudget > 0) {
              const twLen = Math.min(text.length, typewriterBudget);
              const baseSeq = typeof jsonData.sequence_number === 'number' ? jsonData.sequence_number : null;
              let extraSeq = 0;
              await this.sendCharByChar(
                text.substring(0, twLen),
                char => {
                  const seqOverride =
                    baseSeq !== null ? { sequence_number: baseSeq + extraSeq++ } : {};
                  return `event: ${eventType}\ndata: ${JSON.stringify({
                    ...jsonData,
                    ...seqOverride,
                    delta: char
                  })}\n\n`;
                },
                writer, encoder, delay, isStreamEnding
              );
              if (twLen < text.length) {
                const rest = {
                  ...jsonData,
                  ...(baseSeq !== null ? { sequence_number: baseSeq + extraSeq } : {}),
                  delta: text.substring(twLen)
                };
                await writer.write(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(rest)}\n\n`));
              }
              return text.length;
            }
            await writer.write(encoder.encode(`event: ${eventType}\ndata: ${dataStr}\n\n`));
            return text?.length || 0;
          } catch { /* fall through */ }
        }

        await writer.write(encoder.encode(`event: ${eventType}\ndata: ${dataStr}\n\n`));
        return 0;
      },

      formatError: msg =>
        `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'stream_error', message: msg })}\n\n`,
    };
  }
}
