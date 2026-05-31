import { Config } from './config';

export class Auth {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /** Add the upstream auth header in-place. */
  applyAuth(headers: Headers): void {
    const key = this.config.azureApiKey;
    if (!key) {
      throw new Error('AZURE_API_KEY is not configured');
    }
    if (this.config.azureAuthHeader === 'authorization') {
      headers.set('Authorization', `Bearer ${key}`);
    } else {
      headers.set('api-key', key);
    }
  }
}
