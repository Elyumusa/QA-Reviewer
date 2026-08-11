import { AiJsonClient, type AiJsonClientOptions } from './aiJsonClient.js'
import type { FetchImplementation } from './aiProvider.js'
import { DeepSeekProviderAdapter } from './aiProviders.js'
import { QualityReviewerError } from './errors.js'

export type { FetchImplementation } from './aiProvider.js'

export interface DeepSeekClientOptions extends Omit<AiJsonClientOptions, 'provider'> {
  apiKey: string
  model: string
  apiUrl?: string
  fetchImplementation?: FetchImplementation
}

/**
 * Compatibility wrapper for existing consumers. New provider-neutral code should
 * construct AiJsonClient with an AiProviderAdapter instead.
 */
export class DeepSeekJsonClient extends AiJsonClient {
  constructor(options: DeepSeekClientOptions) {
    if (!options.apiKey.trim()) {
      throw new QualityReviewerError('Missing DEEPSEEK_API_KEY. Use --deterministic-only to run without AI review.')
    }
    const { apiKey, model, apiUrl, ...clientOptions } = options
    super({
      ...clientOptions,
      provider: new DeepSeekProviderAdapter({
        apiKey,
        model,
        apiUrl: apiUrl ?? 'https://api.deepseek.com/chat/completions',
      }),
    })
  }
}
