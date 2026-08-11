import type { AiReviewResult } from './responseSchema.js'
import type { Finding, ReviewContext, TestType } from './types.js'

/**
 * The provider boundary for context-aware AI review.
 *
 * The CLI depends on this contract rather than on DeepSeek request/response types,
 * which keeps future provider additions localized to a new adapter.
 */
export interface ReviewProvider {
  review(
    testType: TestType,
    standards: string,
    context: ReviewContext,
    deterministicFindings: Finding[],
  ): Promise<AiReviewResult>
}
