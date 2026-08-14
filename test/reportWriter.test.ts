import assert from 'node:assert/strict'
import test from 'node:test'

import { markdownReport } from '../src/reportWriter.js'
import type { ReviewReport } from '../src/types.js'

test('renders enriched recommendation code, assumptions, and official Cypress guidance', () => {
  const report: ReviewReport = {
    status: 'completed', base: null, reviewed_files_count: 1, generated_at: '2026-08-12T00:00:00.000Z',
    model: 'test-model', provider: 'deepseek', mode: 'audit',
    summary: { critical: 0, high: 0, medium: 1, low: 0, info: 0 }, errors: [],
    files: [{
      file: 'Chatbot.cy.ts', test_type: 'component', status: 'fail', summary: 'One conditional test can repair its own state.', context_files_used: ['Chatbot.ts'],
      findings: [{
        line: 10, severity: 'medium', rule: 'CYPRESS-CONDITIONAL-001', category: 'quality', title: 'Conditional state repair',
        message: 'The test conditionally calls production behavior.', impact: 'A lifecycle regression can pass.',
        suggestion: 'Assert the rendered fallback through a retryable query.',
        replacement_code: "cy.get('@chatbot').shadow().find('.chat-title-text').should('contain.text', 'User')",
        recommendation_code_kind: 'exact', recommendation_assumptions: [],
        official_references: [{ title: 'Cypress conditional testing', url: 'https://docs.cypress.io/app/guides/conditional-testing' }],
        specific_cypress_methods: ['cy.get', 'should'], context_used: ['Chatbot.cy.ts', 'Chatbot.ts'], confidence: 'high', source: 'ai',
        standards_references: ['8. Handling Async State & Conditional UI'], evidence: ['Line 10 branches before asserting.'],
      }],
      audit: {
        overall_assessment: 'The fallback test needs an observable assertion.',
        metrics: { line_count: 20, suite_count: 1, test_count: 1, any_cast_lines: 1, forced_interactions: 0, before_each_hooks: 0, after_each_hooks: 0, fixed_waits: 0, skipped_tests: 0, focused_tests: 0, conditional_blocks: 1, silent_conditional_assertion_blocks: 1, private_member_access_lines: 0, broad_exception_handlers: 0, generic_selector_calls: 0 },
        metric_locations: { line_count: [], suite_count: [], test_count: [], any_cast_lines: [9], forced_interactions: [], before_each_hooks: [], after_each_hooks: [], fixed_waits: [], skipped_tests: [], focused_tests: [], conditional_blocks: [10], silent_conditional_assertion_blocks: [10], private_member_access_lines: [], broad_exception_handlers: [], generic_selector_calls: [] },
        strengths: [], standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [], limitations: [], context_actually_used: ['Chatbot.cy.ts'],
        context_manifest: [{ path: 'Chatbot.ts', role: 'related', status: 'truncated', original_characters: 200000, supplied_characters: 100000, targeted_excerpts: 4 }],
        execution: { complete: true, global_map_source: 'ai', test_chunks_reviewed: 1, test_chunks_total: 1, source_context_files_reviewed: 1, ai_calls: 5, provider: 'deepseek', passes: ['standards-grounded recommendation enrichment'], requested_model: 'test-model', response_models: ['test-model'], requests: [], checkpoint_key: null, reused_passes: [], adaptive_recoveries: [] },
      },
    }],
  }

  const markdown = markdownReport(report)
  assert.match(markdown, /Recommendation: Assert the rendered fallback/)
  assert.match(markdown, /Suggested-code confidence: exact/)
  assert.match(markdown, /```ts\ncy\.get\('@chatbot'\)/)
  assert.match(markdown, /### Context manifest/)
  assert.match(markdown, /Chatbot\.ts \| related \| truncated \| 200000 \| 100000 \| 4/)
  assert.match(markdown, /\[Cypress conditional testing\]\(https:\/\/docs\.cypress\.io\/app\/guides\/conditional-testing\)/)
})
