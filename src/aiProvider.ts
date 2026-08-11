import type { AiProviderId, AiTokenUsage } from './types.js'

export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type AiReasoningEffort = 'high' | 'max'
export type AiThinkingMode = 'enabled' | 'disabled'
export type JsonSchema = Record<string, unknown>

export interface AiProviderRequest {
  system: string
  input: string
  maxTokens: number
  reasoningEffort: AiReasoningEffort
  thinking: AiThinkingMode
  stream?: boolean
  jsonSchema?: JsonSchema
  schemaName?: string
}

export interface AiHttpRequest {
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface NormalizedAiResponse {
  content: string | null
  responseModel: string | null
  finishReason: string | null
  truncated: boolean
  refusal: boolean
  usage: AiTokenUsage
}

export interface NormalizedAiStreamChunk {
  contentDelta: string
  responseModel: string | null
  finishReason: string | null
  refusal: boolean
  usage: AiTokenUsage
}

export interface AiProviderAdapter {
  readonly id: AiProviderId
  readonly model: string
  readonly endpoint: string
  readonly supportsStreaming?: boolean
  buildRequest(request: AiProviderRequest): AiHttpRequest
  parseResponse(payload: unknown): NormalizedAiResponse
  parseStreamChunk?(payload: unknown): NormalizedAiStreamChunk
  apiError(payload: unknown, status: number): string
}

export function emptyTokenUsage(): AiTokenUsage {
  return {
    prompt_tokens: null,
    completion_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    prompt_cache_hit_tokens: null,
    prompt_cache_miss_tokens: null,
  }
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function nestedObject(value: unknown, key: string): Record<string, unknown> | null {
  return objectValue(objectValue(value)?.[key])
}

export function firstArrayObject(value: unknown, key: string): Record<string, unknown> | null {
  const items = objectValue(value)?.[key]
  return Array.isArray(items) ? objectValue(items[0]) : null
}

export function apiErrorMessage(payload: unknown, status: number): string {
  const error = nestedObject(payload, 'error')
  const message = error?.message
  return typeof message === 'string' && message.trim() ? message : `HTTP ${status}`
}
