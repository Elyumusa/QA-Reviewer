import {
  apiErrorMessage,
  firstArrayObject,
  nestedObject,
  nullableNumber,
  objectValue,
  type AiHttpRequest,
  type AiProviderAdapter,
  type AiProviderRequest,
  type NormalizedAiStreamChunk,
  type NormalizedAiResponse,
} from './aiProvider.js'
import type { AiTokenUsage } from './types.js'

function chatCompletionUsage(payload: unknown): AiTokenUsage {
  const usage = nestedObject(payload, 'usage')
  const details = objectValue(usage?.completion_tokens_details)
  const promptDetails = objectValue(usage?.prompt_tokens_details)
  return {
    prompt_tokens: nullableNumber(usage?.prompt_tokens),
    completion_tokens: nullableNumber(usage?.completion_tokens),
    reasoning_tokens: nullableNumber(details?.reasoning_tokens),
    total_tokens: nullableNumber(usage?.total_tokens),
    prompt_cache_hit_tokens: nullableNumber(usage?.prompt_cache_hit_tokens) ?? nullableNumber(promptDetails?.cached_tokens),
    prompt_cache_miss_tokens: nullableNumber(usage?.prompt_cache_miss_tokens),
  }
}

function chatCompletionResponse(payload: unknown): NormalizedAiResponse {
  const root = objectValue(payload)
  const choice = firstArrayObject(payload, 'choices')
  const message = objectValue(choice?.message)
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  return {
    content: typeof message?.content === 'string' ? message.content : null,
    responseModel: typeof root?.model === 'string' ? root.model : null,
    finishReason,
    truncated: finishReason === 'length',
    refusal: typeof message?.refusal === 'string' && message.refusal.trim().length > 0,
    usage: chatCompletionUsage(payload),
  }
}

function chatCompletionStreamChunk(payload: unknown): NormalizedAiStreamChunk {
  const root = objectValue(payload)
  const choice = firstArrayObject(payload, 'choices')
  const delta = objectValue(choice?.delta)
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  return {
    contentDelta: typeof delta?.content === 'string' ? delta.content : '',
    responseModel: typeof root?.model === 'string' ? root.model : null,
    finishReason,
    refusal: typeof delta?.refusal === 'string' && delta.refusal.trim().length > 0,
    usage: chatCompletionUsage(payload),
  }
}

export interface ProviderAdapterOptions {
  apiKey: string
  model: string
  apiUrl: string
}

export class DeepSeekProviderAdapter implements AiProviderAdapter {
  readonly id = 'deepseek' as const
  readonly supportsStreaming = true
  readonly model: string
  readonly endpoint: string
  private readonly apiKey: string

  constructor(options: ProviderAdapterOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.endpoint = options.apiUrl
  }

  buildRequest(request: AiProviderRequest): AiHttpRequest {
    return {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.input },
        ],
        thinking: { type: request.thinking },
        ...(request.thinking === 'enabled' ? { reasoning_effort: request.reasoningEffort } : {}),
        response_format: { type: 'json_object' },
        max_tokens: request.maxTokens,
        stream: request.stream ?? false,
        ...(request.stream ? { stream_options: { include_usage: true } } : {}),
      },
    }
  }

  parseResponse(payload: unknown): NormalizedAiResponse { return chatCompletionResponse(payload) }
  parseStreamChunk(payload: unknown): NormalizedAiStreamChunk { return chatCompletionStreamChunk(payload) }
  apiError(payload: unknown, status: number): string { return apiErrorMessage(payload, status) }
}

export class OpenAiProviderAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly model: string
  readonly endpoint: string
  private readonly apiKey: string

  constructor(options: ProviderAdapterOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.endpoint = options.apiUrl
  }

  buildRequest(request: AiProviderRequest): AiHttpRequest {
    return {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: {
        model: this.model,
        messages: [
          { role: 'developer', content: request.system },
          { role: 'user', content: request.input },
        ],
        ...(request.thinking === 'enabled' ? { reasoning_effort: request.reasoningEffort } : {}),
        response_format: { type: 'json_object' },
        max_completion_tokens: request.maxTokens,
        stream: false,
      },
    }
  }

  parseResponse(payload: unknown): NormalizedAiResponse { return chatCompletionResponse(payload) }
  apiError(payload: unknown, status: number): string { return apiErrorMessage(payload, status) }
}

export interface AnthropicAdapterOptions extends ProviderAdapterOptions {
  apiVersion?: string
}

export class AnthropicProviderAdapter implements AiProviderAdapter {
  readonly id = 'anthropic' as const
  readonly model: string
  readonly endpoint: string
  private readonly apiKey: string
  private readonly apiVersion: string

  constructor(options: AnthropicAdapterOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.endpoint = options.apiUrl
    this.apiVersion = options.apiVersion ?? '2023-06-01'
  }

  buildRequest(request: AiProviderRequest): AiHttpRequest {
    const format = request.jsonSchema
      ? { format: { type: 'json_schema', schema: request.jsonSchema } }
      : {}
    return {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: {
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.input }],
        output_config: {
          effort: request.thinking === 'enabled' ? request.reasoningEffort : 'low',
          ...format,
        },
      },
    }
  }

  parseResponse(payload: unknown): NormalizedAiResponse {
    const root = objectValue(payload)
    const usage = objectValue(root?.usage)
    const outputDetails = objectValue(usage?.output_tokens_details)
    const blocks = Array.isArray(root?.content) ? root.content : []
    const content = blocks
      .map(block => objectValue(block))
      .filter((block): block is Record<string, unknown> => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('')
    const finishReason = typeof root?.stop_reason === 'string' ? root.stop_reason : null
    const inputTokens = nullableNumber(usage?.input_tokens)
    const outputTokens = nullableNumber(usage?.output_tokens)
    return {
      content: content || null,
      responseModel: typeof root?.model === 'string' ? root.model : null,
      finishReason,
      truncated: finishReason === 'max_tokens' || finishReason === 'model_context_window_exceeded',
      refusal: finishReason === 'refusal',
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        reasoning_tokens: nullableNumber(outputDetails?.thinking_tokens),
        total_tokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
        prompt_cache_hit_tokens: nullableNumber(usage?.cache_read_input_tokens),
        prompt_cache_miss_tokens: nullableNumber(usage?.cache_creation_input_tokens),
      },
    }
  }

  apiError(payload: unknown, status: number): string { return apiErrorMessage(payload, status) }
}
