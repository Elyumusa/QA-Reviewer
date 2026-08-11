import { QualityReviewerError } from './errors.js'

export interface DeepSeekRuntimeConfig {
  apiKey: string
  model: string
  apiUrl?: string
}

export function resolveDeepSeekConfiguration(environment: NodeJS.ProcessEnv): DeepSeekRuntimeConfig {
  const apiKey = (environment.DEEPSEEK_API_KEY ?? '').trim()
  if (!apiKey) {
    throw new QualityReviewerError('Missing DEEPSEEK_API_KEY. Use --deterministic-only to run focused checks without AI review.')
  }

  const model = (environment.DEEPSEEK_MODEL ?? 'deepseek-v4-pro').trim()
  if (!model) throw new QualityReviewerError('DEEPSEEK_MODEL must not be empty')

  const rawApiUrl = environment.DEEPSEEK_API_URL?.trim()
  if (!rawApiUrl) return { apiKey, model }

  let apiUrl: URL
  try {
    apiUrl = new URL(rawApiUrl)
  } catch (error) {
    throw new QualityReviewerError('DEEPSEEK_API_URL must be a valid absolute HTTP(S) URL', { cause: error })
  }
  if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
    throw new QualityReviewerError('DEEPSEEK_API_URL must use http:// or https://')
  }
  return { apiKey, model, apiUrl: apiUrl.toString() }
}
