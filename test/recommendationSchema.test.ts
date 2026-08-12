import assert from 'node:assert/strict'
import test from 'node:test'

import { findingKey, validateRecommendationBatch } from '../src/recommendationSchema.js'
import type { Finding } from '../src/types.js'

const finding: Finding = {
  line: 10,
  severity: 'medium',
  rule: 'CYPRESS-CONDITIONAL-001',
  category: 'quality',
  title: 'Silent conditional assertion',
  message: 'The branch can skip the assertion.',
  suggestion: 'Assert the rendered result.',
  replacement_code: null,
  specific_cypress_methods: ['cy.get', 'should'],
  context_used: ['Chatbot.cy.ts'],
  confidence: 'high',
  source: 'ai',
}

const officialUrl = 'https://docs.cypress.io/app/guides/conditional-testing'
const heading = '8. Handling Async State & Conditional UI'
const valid = {
  recommendations: [{
    finding_key: findingKey(finding),
    recommendation: 'Wait for the existing request and assert the rendered title through a retryable query.',
    replacement_code: "cy.wait('@getUserInfoError')\ncy.get('@chatbot').shadow().find('.chat-title-text').should('contain.text', 'User')",
    code_kind: 'exact',
    internal_standard_references: [heading],
    official_reference_urls: [officialUrl],
    assumptions: [],
  }],
}

const options = {
  findings: [finding],
  allowedOfficialUrls: new Set([officialUrl]),
  allowedStandardHeadings: new Set([heading]),
  repositoryText: "cy.wait('@getUserInfoError')\ncy.get('@chatbot')\n.chat-title-text\nUser",
}

test('validates an exact recommendation whose repository literals and references are supported', () => {
  const result = validateRecommendationBatch(valid, options)
  assert.equal(result.recommendations[0]?.code_kind, 'exact')
  assert.equal(result.recommendations[0]?.official_reference_urls[0], officialUrl)
})

test('rejects official references that did not come from the supplied standards', () => {
  const invalid = structuredClone(valid)
  invalid.recommendations[0]!.official_reference_urls = ['https://docs.cypress.io/untrusted-page']
  assert.throws(() => validateRecommendationBatch(invalid, options), /not allowlisted/)
})

test('rejects exact code that invents a repository-specific selector', () => {
  const invalid = structuredClone(valid)
  invalid.recommendations[0]!.replacement_code = "cy.get('.invented-selector').should('exist')"
  assert.throws(() => validateRecommendationBatch(invalid, options), /unverified literal/)
})

test('requires unavailable recommendations to explain why code cannot be produced', () => {
  const unavailable: {
    recommendations: Array<{
      finding_key: string
      recommendation: string
      replacement_code: string | null
      code_kind: 'exact' | 'illustrative' | 'unavailable'
      internal_standard_references: string[]
      official_reference_urls: string[]
      assumptions: string[]
    }>
  } = structuredClone(valid) as unknown as {
    recommendations: Array<{
      finding_key: string
      recommendation: string
      replacement_code: string | null
      code_kind: 'exact' | 'illustrative' | 'unavailable'
      internal_standard_references: string[]
      official_reference_urls: string[]
      assumptions: string[]
    }>
  }
  unavailable.recommendations[0]!.replacement_code = null
  unavailable.recommendations[0]!.code_kind = 'unavailable'
  unavailable.recommendations[0]!.assumptions = ['The observable selector is not present in the supplied repository context.']
  const result = validateRecommendationBatch(unavailable, options)
  assert.equal(result.recommendations[0]?.replacement_code, null)
})
