import { Config } from './config';
import { Auth } from './auth';
import { Converter } from './converter';
import { shadowFetch } from './fetch';
import { ChatCompletionRequest, ChatCompletionResponse } from './types';

export class AzureService {
  config: Config;
  auth: Auth;
  converter: Converter;

  constructor(config: Config, auth: Auth, converter: Converter) {
    this.config = config;
    this.auth = auth;
    this.converter = converter;
  }

  /**
   * Send a Chat Completion request to Azure OpenAI. Returns the raw upstream
   * Response — callers are responsible for parsing JSON or streaming the body.
   */
  async chatCompletion(req: ChatCompletionRequest): Promise<Response> {
    const deployment = this.config.resolveDeployment(req.model);
    const url = this.config.chatCompletionsUrl(deployment);

    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: req.stream ? 'text/event-stream' : 'application/json',
    });
    this.auth.applyAuth(headers);

    const body = JSON.stringify(req);
    console.log(
      `[azure] deployment=${deployment} stream=${!!req.stream} size=${body.length} messages=${req.messages.length}`
    );
    if (this.config.debugLog) {
      console.log(`[azure] url=${url}`);
      console.log(`[azure] body=${body.slice(0, 2048)}`);
    }

    const response = await shadowFetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      const err: any = new Error(`Azure OpenAI error ${response.status}: ${errText}`);
      err.status = response.status;
      err.upstreamBody = errText;
      throw err;
    }

    return response;
  }

  /** Read a non-streaming Chat Completion response as JSON. */
  async readJson(response: Response): Promise<ChatCompletionResponse> {
    const data = (await response.json()) as ChatCompletionResponse;
    if (this.config.debugLog) {
      console.log(`[azure] response choices=${data.choices?.length || 0} model=${data.model}`);
    }
    return data;
  }
}
