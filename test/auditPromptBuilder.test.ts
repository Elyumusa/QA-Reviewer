import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAuditInventory, chunkSource } from '../src/auditInventory.js'
import { buildChunkAuditInput } from '../src/auditPromptBuilder.js'
import type { Finding, ReviewContext } from '../src/types.js'

test('chunk prompts include only evidence locations and deterministic findings inside that chunk', () => {
  const content = Array.from({ length: 220 }, (_, index) => index === 179
    ? 'cy.wait(150)'
    : `// line ${index + 1}`).join('\n')
  const context: ReviewContext = {
    test_file: { path: 'Large.cy.ts', content },
    diff: '',
    related_files: [],
  }
  const finding: Finding = {
    line: 180,
    severity: 'high',
    rule: 'CYPRESS-ASYNC-001',
    category: 'quality',
    title: 'Fixed wait',
    message: 'Fixed wait.',
    suggestion: 'Replace it.',
    replacement_code: null,
    specific_cypress_methods: ['cy.wait'],
    context_used: ['test file'],
    confidence: 'high',
    source: 'deterministic',
  }
  const inventory = buildAuditInventory(content)
  const firstChunk = chunkSource(content, 100, 10)[0]
  assert.ok(firstChunk)

  const input = buildChunkAuditInput({
    testType: 'component',
    standards: '# Standards',
    context,
    inventory,
    deterministicFindings: [finding],
    chunk: firstChunk,
    globalMap: {
      summary: 'Fixture map.',
      suites: [],
      shared_infrastructure: [],
      cross_suite_patterns: [],
      context_used: ['Large.cy.ts'],
      limitations: [],
    },
  })

  assert.match(input, /"fixed_waits": 1/)
  assert.doesNotMatch(input, /"line": 180/)
  assert.doesNotMatch(input, /180: cy\.wait/)
})
