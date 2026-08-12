import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFindingEvidence, parseStandardsGuidance, relevantStandardsSections } from '../src/standardsGuidance.js'
import type { Finding, ReviewContext } from '../src/types.js'

const finding: Finding = {
  line: 4,
  end_line: 7,
  severity: 'medium',
  rule: 'CYPRESS-CONDITIONAL-001',
  category: 'quality',
  title: 'Conditional assertion can pass silently',
  message: 'The test branches on displayTitle inside then.',
  impact: 'The test can repair the behavior it should verify.',
  suggestion: 'Assert the rendered title with a retryable query.',
  replacement_code: null,
  specific_cypress_methods: ['cy.get', 'then', 'should'],
  context_used: ['Chatbot.cy.ts'],
  confidence: 'high',
  source: 'ai',
  evidence: ['The if block calls loadUserInfo.'],
  standards_references: ['8. Handling Async State & Conditional UI'],
}

test('extracts only official Cypress links and selects relevant standards sections', () => {
  const guidance = parseStandardsGuidance(`# Standards

## 8. Handling Async State & Conditional UI

Avoid conditional assertions. [Conditional testing](https://docs.cypress.io/app/guides/conditional-testing)

## Unrelated

[Other](https://example.com/not-trusted)`)

  assert.deepEqual(guidance.officialReferences, [{
    title: 'Conditional testing',
    url: 'https://docs.cypress.io/app/guides/conditional-testing',
  }])
  assert.equal(relevantStandardsSections(guidance, [finding], 1)[0]?.heading, '8. Handling Async State & Conditional UI')
})

test('builds numbered repository evidence around a finding and matching source behavior', () => {
  const context: ReviewContext = {
    test_file: {
      path: 'Chatbot.cy.ts',
      content: [
        "cy.intercept('GET', '/Api/User').as('load')",
        "cy.get('@chatbot').then($el => {",
        '  const chatbot = $el[0] as any',
        '  if (!chatbot.displayTitle) {',
        '    chatbot.loadUserInfo()',
        '  }',
        "  expect(chatbot.displayTitle).to.include('User')",
        '})',
      ].join('\n'),
    },
    diff: '',
    related_files: [{
      path: 'Chatbot.ts',
      reason: 'Imported component',
      content: "render() { return html`<div class='chat-title-text'>${this.displayTitle}</div>` }",
      truncated: false,
    }],
  }

  const evidence = buildFindingEvidence(finding, context)
  assert.match(evidence, /4:   if \(!chatbot\.displayTitle\)/)
  assert.match(evidence, /FILE: Chatbot\.ts/)
  assert.match(evidence, /chat-title-text/)
})
