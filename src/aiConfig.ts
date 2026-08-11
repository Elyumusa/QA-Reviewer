import type { AiProviderAdapter } from './aiProvider.js'
import { AnthropicProviderAdapter, DeepSeekProviderAdapter, OpenAiProviderAdapter } from './aiProviders.js'
import { QualityReviewerError } from './errors.js'
import type { AiProviderId } from './types.js'

const defaults: Record<AiProviderId, { model: string; apiUrl: string }> = {
  deepseek: { model: 'deepseek-v4-pro', apiUrl: 'https://api.deepseek.com/chat/completions' },
  openai: { model: 'gpt-5.6-sol', apiUrl: 'https://api.openai.com/v1/chat/completions' },
  anthropic: { model: 'claude-sonnet-5', apiUrl: 'https://api.anthropic.com/v1/messages' },
}

export interface AiRuntimeConfiguration {
  provider: AiProviderId
  model: string
  apiUrl: string
  adapter: AiProviderAdapter
}

export function resolveAiProviderId(value: string | undefined): AiProviderId {
  const normalized = (value ?? 'deepseek').trim().toLowerCase()
  if (normalized === 'claude') return 'anthropic'
  if (normalized === 'deepseek' || normalized === 'openai' || normalized === 'anthropic') return normalized
  throw new QualityReviewerError('AI provider must be deepseek, openai, or anthropic (claude is accepted as an alias)')
}

export function defaultModelForProvider(provider: AiProviderId): string {
  return defaults[provider].model
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = (environment[name] ?? '').trim()
  if (!value) {
    throw new QualityReviewerError(`Missing ${name}. Select another provider or use --deterministic-only for focused checks without AI review.`)
  }
  return value
}

function modelValue(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  if (!(name in environment)) return fallback
  const value = (environment[name] ?? '').trim()
  if (!value) throw new QualityReviewerError(`${name} must not be empty`)
  return value
}

function endpointValue(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  if (!(name in environment) || !environment[name]?.trim()) return fallback
  const raw = environment[name]?.trim() ?? ''
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    throw new QualityReviewerError(`${name} must be a valid absolute HTTP(S) URL`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new QualityReviewerError(`${name} must use http:// or https://`)
  }
  return url.toString()
}

export function resolveAiConfiguration(
  provider: AiProviderId,
  environment: NodeJS.ProcessEnv,
): AiRuntimeConfiguration {
  if (provider === 'deepseek') {
    const apiKey = required(environment, 'DEEPSEEK_API_KEY')
    const model = modelValue(environment, 'DEEPSEEK_MODEL', defaults.deepseek.model)
    const apiUrl = endpointValue(environment, 'DEEPSEEK_API_URL', defaults.deepseek.apiUrl)
    return { provider, model, apiUrl, adapter: new DeepSeekProviderAdapter({ apiKey, model, apiUrl }) }
  }
  if (provider === 'openai') {
    const apiKey = required(environment, 'OPENAI_API_KEY')
    const model = modelValue(environment, 'OPENAI_MODEL', defaults.openai.model)
    const apiUrl = endpointValue(environment, 'OPENAI_API_URL', defaults.openai.apiUrl)
    return { provider, model, apiUrl, adapter: new OpenAiProviderAdapter({ apiKey, model, apiUrl }) }
  }

  const apiKey = required(environment, 'ANTHROPIC_API_KEY')
  const model = modelValue(environment, 'ANTHROPIC_MODEL', defaults.anthropic.model)
  const apiUrl = endpointValue(environment, 'ANTHROPIC_API_URL', defaults.anthropic.apiUrl)
  const apiVersion = (environment.ANTHROPIC_VERSION ?? '2023-06-01').trim()
  if (!apiVersion) throw new QualityReviewerError('ANTHROPIC_VERSION must not be empty')
  return {
    provider,
    model,
    apiUrl,
    adapter: new AnthropicProviderAdapter({ apiKey, model, apiUrl, apiVersion }),
  }
}
