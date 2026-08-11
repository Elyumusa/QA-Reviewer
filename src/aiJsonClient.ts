import { QualityReviewerError, errorMessage } from './errors.js'
import { emptyTokenUsage, type AiProviderAdapter, type AiReasoningEffort, type AiThinkingMode, type FetchImplementation, type JsonSchema, type NormalizedAiResponse } from './aiProvider.js'
import type { AiRequestTrace, AiTokenUsage } from './types.js'

export interface AiJsonClientOptions {
  provider: AiProviderAdapter
  timeoutMs?: number
  fetchImplementation?: FetchImplementation
  onProgress?: (message: string) => void
  transportRetries?: number
  transportRetryDelayMs?: number
}

interface JsonRepairOptions {
  system: string
  buildInput: (invalidValue: unknown, validationError: string) => string
  maxTokens: number
}

class TruncatedCompletionError extends QualityReviewerError {}
class RefusedCompletionError extends QualityReviewerError {}

function usageText(usage: AiTokenUsage): string {
  const values = [
    usage.prompt_tokens === null ? null : `prompt=${usage.prompt_tokens}`,
    usage.completion_tokens === null ? null : `completion=${usage.completion_tokens}`,
    usage.reasoning_tokens === null ? null : `reasoning=${usage.reasoning_tokens}`,
  ].filter((value): value is string => value !== null)
  return values.length > 0 ? `; tokens ${values.join(', ')}` : ''
}

function errorWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (!(cause instanceof Error)) return error.message
  const code = 'code' in cause && typeof cause.code === 'string' ? `${cause.code}: ` : ''
  return `${error.message} (${code}${cause.message})`
}

function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError' || error instanceof QualityReviewerError) return false
  if (error instanceof TypeError && /fetch failed|network|socket/i.test(error.message)) return true
  const cause = error.cause
  if (!(cause instanceof Error)) return false
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  return ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EAI_AGAIN'].includes(code)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function extractOutputText(
  response: NormalizedAiResponse,
  operation: string,
  provider: AiProviderAdapter,
  maxTokens: number,
): string {
  if (response.truncated) {
    throw new TruncatedCompletionError(
      `${operation} was truncated (finish_reason=${response.finishReason ?? 'unknown'}; provider=${provider.id}; requested_model=${provider.model}; response_model=${response.responseModel ?? 'unknown'}; max_tokens=${maxTokens}${usageText(response.usage)})`,
    )
  }
  if (response.refusal) {
    throw new RefusedCompletionError(`${operation} was refused by ${provider.id} (model=${response.responseModel ?? provider.model})`)
  }
  if (typeof response.content === 'string' && response.content.trim()) return response.content
  throw new QualityReviewerError(`${operation} did not return message content`)
}

export class AiJsonClient {
  private readonly provider: AiProviderAdapter
  private readonly timeoutMs: number
  private readonly fetchImplementation: FetchImplementation
  private readonly onProgress: (message: string) => void
  private readonly progressEnabled: boolean
  private readonly transportRetries: number
  private readonly transportRetryDelayMs: number
  private readonly requestTraces: AiRequestTrace[] = []
  private requestCounter = 0

  constructor(options: AiJsonClientOptions) {
    this.provider = options.provider
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.onProgress = options.onProgress ?? (() => {})
    this.progressEnabled = options.onProgress !== undefined
    this.transportRetries = options.transportRetries ?? 1
    if (!Number.isInteger(this.transportRetries) || this.transportRetries < 0 || this.transportRetries > 3) {
      throw new QualityReviewerError('AI transport retries must be between 0 and 3')
    }
    this.transportRetryDelayMs = options.transportRetryDelayMs ?? 1000
    if (!Number.isInteger(this.transportRetryDelayMs) || this.transportRetryDelayMs < 0 || this.transportRetryDelayMs > 30_000) {
      throw new QualityReviewerError('AI transport retry delay must be between 0 and 30000ms')
    }
  }

  async requestJson<T>(options: {
    operation?: string
    system: string
    input: string
    retryInput: string
    validate: (value: unknown) => T
    maxTokens?: number
    maxRetryTokens?: number
    reasoningEffort?: AiReasoningEffort
    thinking?: AiThinkingMode
    retryThinking?: AiThinkingMode
    jsonSchema?: JsonSchema
    schemaName?: string
    repair?: JsonRepairOptions
  }): Promise<T> {
    const operation = options.operation ?? `${this.provider.id} review`
    const firstMaxTokens = options.maxTokens ?? 6000
    const firstResponse = await this.request(
      operation, 1, options.system, options.input, firstMaxTokens,
      options.reasoningEffort, options.thinking, options.jsonSchema, options.schemaName,
    )

    let firstError: unknown
    let firstParsed: unknown
    let firstWasParsed = false
    try {
      firstParsed = JSON.parse(extractOutputText(firstResponse, operation, this.provider, firstMaxTokens)) as unknown
      firstWasParsed = true
      return options.validate(firstParsed)
    } catch (error) {
      firstError = error
      if (error instanceof RefusedCompletionError) throw error
      if (!(error instanceof TruncatedCompletionError)) this.markTrace(operation, 1, 'schema_invalid')
    }

    if (firstWasParsed && options.repair) {
      try {
        return await this.requestRepair(operation, 2, firstParsed, firstError, options.repair, options.validate, options.jsonSchema, options.schemaName)
      } catch (repairError) {
        throw new QualityReviewerError(
          `${operation} failed validation and targeted repair. Validation: ${errorMessage(firstError)}. Repair: ${errorMessage(repairError)}`,
          { cause: repairError },
        )
      }
    }

    const retryMaxTokens = options.maxRetryTokens
      ?? (firstError instanceof TruncatedCompletionError ? firstMaxTokens * 2 : firstMaxTokens)
    const retryReason = firstError instanceof TruncatedCompletionError ? 'truncated output' : 'invalid JSON/schema output'
    this.onProgress(`${operation} first attempt could not be accepted: ${errorMessage(firstError)}`)
    this.onProgress(`Retrying ${operation} after ${retryReason}; max output tokens ${firstMaxTokens} → ${retryMaxTokens}.`)
    const retrySuffix = firstError instanceof TruncatedCompletionError
      ? '\n\nThe previous response was truncated. Be concise, consolidate repeated evidence, and complete the JSON within the larger output allowance.'
      : `\n\nThe previous response failed local validation: ${errorMessage(firstError)}. Correct that exact problem and return a complete JSON object.`
    const retryResponse = await this.request(
      operation, 2, options.system, `${options.retryInput}${retrySuffix}`, retryMaxTokens,
      options.reasoningEffort, options.retryThinking ?? options.thinking, options.jsonSchema, options.schemaName,
    )
    let retryParsed: unknown
    let retryWasParsed = false
    try {
      retryParsed = JSON.parse(extractOutputText(retryResponse, operation, this.provider, retryMaxTokens)) as unknown
      retryWasParsed = true
      return options.validate(retryParsed)
    } catch (error) {
      if (error instanceof RefusedCompletionError) throw error
      if (!(error instanceof TruncatedCompletionError)) this.markTrace(operation, 2, 'schema_invalid')
      if (retryWasParsed && options.repair) {
        try {
          return await this.requestRepair(operation, 3, retryParsed, error, options.repair, options.validate, options.jsonSchema, options.schemaName)
        } catch (repairError) {
          throw new QualityReviewerError(
            `${operation} failed after retry and targeted repair. First attempt: ${errorMessage(firstError)}. Retry: ${errorMessage(error)}. Repair: ${errorMessage(repairError)}`,
            { cause: repairError },
          )
        }
      }
      throw new QualityReviewerError(
        `${operation} returned invalid output after one retry. First attempt: ${errorMessage(firstError)}. Retry: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }

  get requestsMade(): number { return this.requestCounter }
  get requestedModel(): string { return this.provider.model }
  get providerId() { return this.provider.id }
  get endpointIdentity(): string { return this.provider.endpoint }
  get traces(): AiRequestTrace[] { return this.requestTraces.map(trace => ({ ...trace, usage: { ...trace.usage } })) }

  private async requestRepair<T>(
    operation: string,
    attempt: number,
    invalidValue: unknown,
    validationError: unknown,
    repair: JsonRepairOptions,
    validate: (value: unknown) => T,
    jsonSchema?: JsonSchema,
    schemaName?: string,
  ): Promise<T> {
    const repairOperation = `${operation} targeted schema repair`
    this.onProgress(`Starting targeted schema repair for ${operation}: ${errorMessage(validationError)}`)
    const repairResponse = await this.request(
      repairOperation, attempt, repair.system,
      repair.buildInput(invalidValue, errorMessage(validationError)), repair.maxTokens,
      'high', 'disabled', jsonSchema, schemaName,
    )
    try {
      const repaired = JSON.parse(extractOutputText(repairResponse, repairOperation, this.provider, repair.maxTokens)) as unknown
      return validate(repaired)
    } catch (error) {
      if (error instanceof RefusedCompletionError) throw error
      if (!(error instanceof TruncatedCompletionError)) this.markTrace(repairOperation, attempt, 'schema_invalid')
      throw error
    }
  }

  private markTrace(operation: string, attempt: number, status: AiRequestTrace['status']): void {
    for (let index = this.requestTraces.length - 1; index >= 0; index -= 1) {
      const trace = this.requestTraces[index]
      if (trace?.operation === operation && trace.attempt === attempt) {
        if (trace.status === 'completed') trace.status = status
        return
      }
    }
  }

  private async request(
    operation: string,
    attempt: number,
    system: string,
    input: string,
    maxTokens = 6000,
    reasoningEffort: AiReasoningEffort = 'high',
    thinking: AiThinkingMode = 'enabled',
    jsonSchema?: JsonSchema,
    schemaName?: string,
  ): Promise<NormalizedAiResponse> {
    let lastError: unknown
    let transportAttemptsMade = 0
    for (let transportAttempt = 1; transportAttempt <= this.transportRetries + 1; transportAttempt += 1) {
      transportAttemptsMade = transportAttempt
      try {
        return await this.requestOnce(operation, attempt, transportAttempt, system, input, maxTokens, reasoningEffort, thinking, jsonSchema, schemaName)
      } catch (error) {
        lastError = error
        if (!isTransientTransportError(error) || transportAttempt > this.transportRetries) break
        const waitMs = this.transportRetryDelayMs * transportAttempt
        this.onProgress(
          `${operation} hit a transient connection error: ${errorWithCause(error)}. Retrying the same request in ${waitMs}ms (transport attempt ${transportAttempt + 1}/${this.transportRetries + 1}).`,
        )
        await delay(waitMs)
      }
    }
    if (lastError instanceof QualityReviewerError) throw lastError
    throw new QualityReviewerError(
      `${operation} request failed after ${transportAttemptsMade} transport attempt(s): ${errorWithCause(lastError)}`,
      { cause: lastError },
    )
  }

  private async requestOnce(
    operation: string,
    attempt: number,
    transportAttempt: number,
    system: string,
    input: string,
    maxTokens: number,
    reasoningEffort: AiReasoningEffort,
    thinking: AiThinkingMode,
    jsonSchema?: JsonSchema,
    schemaName?: string,
  ): Promise<NormalizedAiResponse> {
    this.requestCounter += 1
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const heartbeat = this.progressEnabled
      ? setInterval(() => {
          const elapsedSeconds = Math.round((Date.now() - started) / 1000)
          this.onProgress(`Still waiting for ${operation} (attempt ${attempt}, ${elapsedSeconds}s elapsed).`)
        }, 30_000)
      : null
    let recorded = false
    const transportText = transportAttempt > 1 ? `, transport retry ${transportAttempt}` : ''
    this.onProgress(`Starting ${operation} (attempt ${attempt}${transportText}, provider ${this.provider.id}, model ${this.provider.model}, thinking ${thinking}${thinking === 'enabled' ? `/${reasoningEffort}` : ''}, max output ${maxTokens}).`)

    try {
      const providerRequest = this.provider.buildRequest({
        system, input, maxTokens, reasoningEffort, thinking,
        ...(jsonSchema ? { jsonSchema } : {}),
        ...(schemaName ? { schemaName } : {}),
      })
      const response = await this.fetchImplementation(this.provider.endpoint, {
        method: 'POST',
        headers: providerRequest.headers,
        body: JSON.stringify(providerRequest.body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let payload: unknown
      try {
        payload = raw ? JSON.parse(raw) as unknown : {}
      } catch (error) {
        if (!response.ok) payload = { error: { message: `HTTP ${response.status}: non-JSON response` } }
        else throw new QualityReviewerError(`${operation} received a non-JSON response from ${this.provider.id}`, { cause: error })
      }
      const normalized = this.provider.parseResponse(payload)
      const status = !response.ok || normalized.refusal ? 'api_error' : normalized.truncated ? 'truncated' : 'completed'
      const trace: AiRequestTrace = {
        operation,
        attempt,
        transport_attempt: transportAttempt,
        requested_model: this.provider.model,
        response_model: normalized.responseModel,
        max_tokens: maxTokens,
        thinking,
        reasoning_effort: thinking === 'enabled' ? reasoningEffort : null,
        finish_reason: normalized.finishReason,
        duration_ms: Date.now() - started,
        status,
        provider: this.provider.id,
        usage: normalized.usage,
      }
      this.requestTraces.push(trace)
      recorded = true

      if (!response.ok) {
        throw new QualityReviewerError(`${operation} request failed (${this.provider.id}): ${this.provider.apiError(payload, response.status)}`)
      }
      const modelMessage = normalized.responseModel && normalized.responseModel !== this.provider.model
        ? ` Requested ${this.provider.model}, but the API reported ${normalized.responseModel}.`
        : ''
      this.onProgress(`Finished ${operation} in ${(trace.duration_ms / 1000).toFixed(1)}s (${normalized.finishReason ?? 'unknown'}${usageText(trace.usage)}).${modelMessage}`)
      return normalized
    } catch (error) {
      if (!recorded) {
        this.requestTraces.push({
          operation,
          attempt,
          transport_attempt: transportAttempt,
          requested_model: this.provider.model,
          response_model: null,
          max_tokens: maxTokens,
          thinking,
          reasoning_effort: thinking === 'enabled' ? reasoningEffort : null,
          finish_reason: null,
          duration_ms: Date.now() - started,
          status: 'transport_error',
          provider: this.provider.id,
          usage: emptyTokenUsage(),
        })
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new QualityReviewerError(`${operation} timed out after ${this.timeoutMs}ms`, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timeout)
      if (heartbeat) clearInterval(heartbeat)
    }
  }
}
