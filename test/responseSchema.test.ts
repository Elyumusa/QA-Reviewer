import assert from 'node:assert/strict'
import test from 'node:test'

import { validateAiReview } from '../src/responseSchema.js'
import { validateAuditSynthesis } from '../src/auditSchema.js'

const validResponse = {
  file: 'test.cy.ts',
  test_type: 'component',
  status: 'fail',
  summary: 'One issue.',
  findings: [{
    line: 4,
    severity: 'high',
    rule: 'COMP-ASYNC-001',
    category: 'quality',
    title: 'Fixed wait',
    message: 'The wait is timing-dependent.',
    suggestion: 'Wait for updateComplete from the mounted component.',
    replacement_code: 'cy.get("lvl-example").then(element => element[0].updateComplete)',
    specific_cypress_methods: ['cy.get', 'cy.then'],
    context_used: ['test file', 'component source'],
    confidence: 'high',
  }],
}

test('validates and marks AI findings with their source', () => {
  const result = validateAiReview(validResponse)
  assert.equal(result.findings[0]?.source, 'ai')
})

test('rejects invalid enum values', () => {
  assert.throws(
    () => validateAiReview({
      ...validResponse,
      findings: [{ ...validResponse.findings[0], severity: 'urgent' }],
    }),
    /invalid severity/,
  )
})

test('recovers a redundant empty audit finding message from title and impact', () => {
  const result = validateAuditSynthesis({
    overall_assessment: 'Mixed quality.',
    summary: 'One issue.',
    strengths: [],
    findings: [{
      line: 4,
      end_line: 4,
      severity: 'high',
      rule: 'AUDIT-ASSERTION-001',
      category: 'quality',
      title: 'Missing assertion',
      message: '',
      impact: 'The test can pass without proving behavior.',
      suggestion: 'Assert the observable result.',
      replacement_code: null,
      specific_cypress_methods: [],
      context_used: ['test file'],
      confidence: 'high',
      evidence: ['No assertion follows the action.'],
      standards_references: ['Observable behavior'],
      related_locations: [],
    }],
    standards_assessment: [],
    coverage_gaps: [],
    test_placement_issues: [],
    priorities: [],
    limitations: [],
    context_actually_used: ['test file'],
  })

  assert.equal(result.findings[0]?.message, 'Missing assertion. The test can pass without proving behavior.')
})

test('recovers empty audit finding prose fields without discarding valid evidence', () => {
  const result = validateAuditSynthesis({
    overall_assessment: 'Mixed quality.',
    summary: 'One issue.',
    strengths: [],
    findings: [{
      line: 14,
      end_line: 16,
      severity: 'medium',
      rule: 'AUDIT-SELECTOR-001',
      category: 'quality',
      title: 'Positional selector',
      message: 'The selector depends on DOM ordering.',
      impact: '',
      suggestion: '',
      replacement_code: null,
      specific_cypress_methods: ['cy.get'],
      context_used: ['test file'],
      confidence: 'high',
      evidence: ['The test selects the last matching button.'],
      standards_references: ['Use stable selectors'],
      related_locations: [],
    }],
    standards_assessment: [],
    coverage_gaps: [],
    test_placement_issues: [],
    priorities: [],
    limitations: [],
    context_actually_used: ['test file'],
  })

  assert.equal(result.findings[0]?.impact, 'The selector depends on DOM ordering.')
  assert.match(result.findings[0]?.suggestion ?? '', /Positional selector/)
})
