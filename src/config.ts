import { Env } from './types';

function truthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return false;
}

export class Config {
  env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  get azureEndpoint(): string {
    const raw = (this.env.AZURE_ENDPOINT || '').trim();
    if (!raw) throw new Error('AZURE_ENDPOINT is not configured');
    return raw.replace(/\/+$/, '');
  }

  get azureApiVersion(): string {
    return (this.env.AZURE_API_VERSION || '2024-10-21').trim();
  }

  /** Header used to authenticate to the Azure / gateway. */
  get azureAuthHeader(): 'api-key' | 'authorization' {
    const v = (this.env.AZURE_AUTH_HEADER || 'api-key').toLowerCase();
    return v === 'authorization' || v === 'bearer' ? 'authorization' : 'api-key';
  }

  get azureApiKey(): string | undefined {
    return this.env.AZURE_API_KEY;
  }

  get defaultModel(): string {
    return this.env.DEFAULT_MODEL || 'gpt-4o';
  }

  /** Deployment names exposed by GET /v1/models. */
  get exposedModels(): string[] {
    const raw = this.env.EXPOSED_MODELS || this.defaultModel;
    return raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  get enableStreaming(): boolean {
    return truthy(this.env.ENABLE_STREAMING);
  }

  get debugLog(): boolean {
    return truthy(this.env.DEBUG_LOG);
  }

  get clientApiKey(): string | undefined {
    return this.env.API_KEY;
  }

  /**
   * Map a client-supplied model name to an Azure deployment id.
   * Azure URLs require the deployment name in the path. If no model is
   * provided we fall back to the default deployment.
   */
  resolveDeployment(model?: string | null): string {
    const m = (model || '').trim();
    if (!m) return this.defaultModel;
    return m;
  }

  /** Build the Azure Chat Completions URL for a given deployment. */
  chatCompletionsUrl(deployment: string): string {
    const dep = encodeURIComponent(deployment);
    return `${this.azureEndpoint}/openai/deployments/${dep}/chat/completions?api-version=${encodeURIComponent(this.azureApiVersion)}`;
  }
}
