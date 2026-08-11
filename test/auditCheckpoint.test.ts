import assert from 'node:assert/strict'
import test from 'node:test'

import { auditCheckpointKey } from '../src/auditCheckpoint.js'
import type { ReviewContext } from '../src/types.js'

const context: ReviewContext = {
  test_file: { path: 'Example.cy.ts', content: "it('works', () => {})" },
  diff: '',
  related_files: [],
}

function key(overrides: Partial<Parameters<typeof auditCheckpointKey>[0]> = {}): string {
  return auditCheckpointKey({
    testType: 'component',
    standards: '# Standards',
    context,
    model: 'model',
    provider: 'deepseek',
    providerEndpoint: 'https://api.deepseek.com/chat/completions',
    pipelineRevision: 'audit-pipeline-v2',
    chunkLines: 700,
    ...overrides,
  })
}

test('checkpoint identity changes with provider endpoint and pipeline revision', () => {
  assert.notEqual(key(), key({ providerEndpoint: 'https://gateway.example.test/chat/completions' }))
  assert.notEqual(key(), key({ provider: 'another-provider' }))
  assert.notEqual(key(), key({ pipelineRevision: 'audit-pipeline-v3' }))
})
