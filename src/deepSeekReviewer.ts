import { AiJsonClient } from './aiJsonClient.js'
import { DeepSeekJsonClient, type DeepSeekClientOptions } from './deepSeekClient.js'
import { buildReviewInput, reviewerInstructions } from './promptBuilder.js'
import type { ReviewProvider } from './reviewProvider.js'
import { aiReviewJsonSchema, validateAiReview, type AiReviewResult } from './responseSchema.js'
import type { Finding, ReviewContext, TestType } from './types.js'

export type DeepSeekReviewerOptions = DeepSeekClientOptions

export class AiReviewer implements ReviewProvider {
  private readonly client: AiJsonClient
  private lastTraceStart = 0

  constructor(client: AiJsonClient) {
    this.client = client
  }

  async review(
    testType: TestType,
    standards: string,
    context: ReviewContext,
    deterministicFindings: Finding[],
  ): Promise<AiReviewResult> {
    this.lastTraceStart = this.client.traces.length
    return this.client.requestJson({
      operation: `focused review for ${context.test_file.path}`,
      system: reviewerInstructions,
      input: buildReviewInput(testType, standards, context, deterministicFindings),
      retryInput: buildReviewInput(testType, standards, context, deterministicFindings, true),
      validate: validateAiReview,
      maxTokens: 6000,
      maxRetryTokens: 12_000,
      jsonSchema: aiReviewJsonSchema,
      schemaName: 'focused_review',
    })
  }

  get lastRequestTraces() {
    return this.client.traces.slice(this.lastTraceStart)
  }
}

export class DeepSeekReviewer extends AiReviewer {
  constructor(options: DeepSeekReviewerOptions) {
    super(new DeepSeekJsonClient(options))
  }
}
