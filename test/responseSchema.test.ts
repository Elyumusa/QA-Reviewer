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

function auditFindingAt(index: number, severity: 'critical' | 'high' | 'medium' | 'low' | 'info' = 'low') {
  return {
    line: index + 1,
    end_line: index + 1,
    severity,
    rule: `AUDIT-BOUND-${index + 1}`,
    category: 'quality',
    title: `Bounded finding ${index + 1}`,
    message: `Supported issue ${index + 1}.`,
    impact: 'The test can provide weaker confidence.',
    suggestion: 'Strengthen the observable assertion.',
    replacement_code: null,
    specific_cypress_methods: [],
    context_used: ['test file'],
    confidence: index % 2 === 0 ? 'high' : 'medium',
    evidence: [`Evidence at line ${index + 1}.`],
    standards_references: ['Observable behavior'],
    related_locations: [],
  }
}

function synthesisWithFindings(findings: unknown[]) {
  return {
    overall_assessment: 'Large audit.',
    summary: 'Many supported issues.',
    strengths: [],
    findings,
    standards_assessment: [],
    coverage_gaps: [],
    test_placement_issues: [],
    priorities: [{ rank: 1, action: 'Prioritize important findings.', rationale: 'Risk based.', related_finding_rules: ['AUDIT-BOUND-68', 'AUDIT-BOUND-67'] }],
    limitations: [],
    context_actually_used: ['test file'],
  }
}

test('validates every over-limit finding and retains the strongest bounded set', () => {
  const findings = Array.from({ length: 68 }, (_, index) => auditFindingAt(index, index === 67 ? 'critical' : 'low'))
  const result = validateAuditSynthesis(synthesisWithFindings(findings))

  assert.equal(result.findings.length, 30)
  assert.ok(result.findings.some(finding => finding.rule === 'AUDIT-BOUND-68'))
  assert.ok(!result.findings.some(finding => finding.rule === 'AUDIT-BOUND-67'))
  assert.deepEqual(result.priorities[0]?.related_finding_rules, ['AUDIT-BOUND-68'])
  assert.ok(result.limitations.some(limitation => limitation.includes('returned 68 valid finding item(s)')))
  assert.ok(result.limitations.some(limitation => limitation.includes('retained the 30 highest-priority')))
})

test('does not hide an invalid finding merely because it is beyond the report limit', () => {
  const findings: unknown[] = Array.from({ length: 35 }, (_, index) => auditFindingAt(index))
  findings[34] = { ...auditFindingAt(34), line: 'invalid' }
  assert.throws(() => validateAuditSynthesis(synthesisWithFindings(findings)), /audit finding 34 has invalid lines/)
})

test('checks source-line bounds before omitting lower-priority overflow findings', () => {
  const findings: unknown[] = Array.from({ length: 35 }, (_, index) => auditFindingAt(index))
  findings[34] = { ...auditFindingAt(34), line: 999, end_line: 999 }
  assert.throws(
    () => validateAuditSynthesis(synthesisWithFindings(findings), { lineCount: 100 }),
    /AUDIT-BOUND-35 has a line outside 1-100/,
  )
})
