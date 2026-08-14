import assert from 'node:assert/strict'
import test from 'node:test'

import { contextManifest, reconcileContextLimitations, retrieveTargetedSourceExcerpts } from '../src/targetedSourceRetrieval.js'
import type { ReviewContext } from '../src/types.js'

function context(): ReviewContext {
  const fullSource = [
    'export class Chatbot {',
    '  render() { return html`<div></div>` }',
    ...Array.from({ length: 120 }, (_, index) => `  filler${index} = ${index}`),
    '  handleCopyMessage(value: string) {',
    '    return navigator.clipboard.writeText(value)',
    '  }',
    '}',
  ].join('\n')
  return {
    test_file: {
      path: 'Chatbot.cy.ts',
      content: "it('copies', () => cy.get('@chatbot').then(el => el[0].handleCopyMessage('hello')))",
    },
    diff: '',
    related_files: [{
      path: 'src/Chatbot.ts',
      reason: 'Imported by Chatbot.cy.ts',
      content: `${fullSource.slice(0, 120)}\n...[truncated]...\n${fullSource.slice(-30)}`,
      truncated: true,
      original_character_count: fullSource.length,
      full_content_hash: 'test-hash',
      full_content: fullSource,
    }],
  }
}

test('retrieves a referenced declaration omitted from bounded base context', () => {
  const reviewContext = context()
  const excerpts = retrieveTargetedSourceExcerpts(reviewContext, 'Copy handling calls handleCopyMessage.')
  const copy = excerpts.find(excerpt => excerpt.symbol === 'handleCopyMessage')

  assert.ok(copy)
  assert.match(copy.content, /navigator\.clipboard\.writeText/)
  assert.ok(copy.start_line > 100)
})

test('builds an authoritative context manifest including targeted excerpt counts', () => {
  const reviewContext = context()
  reviewContext.targeted_source_excerpts = retrieveTargetedSourceExcerpts(reviewContext, 'handleCopyMessage')
  const manifest = contextManifest(reviewContext)

  assert.equal(manifest[0]?.status, 'complete')
  assert.equal(manifest[1]?.status, 'truncated')
  assert.ok((manifest[1]?.targeted_excerpts ?? 0) > 0)
  assert.ok((manifest[1]?.original_characters ?? 0) > (manifest[1]?.supplied_characters ?? 0))
})

test('removes a false unavailable-source limitation and records the truthful truncated state', () => {
  const limitations = reconcileContextLimitations([
    'Component implementation source was not available, so private contracts could not be verified.',
    'Browser behavior was not executed.',
  ], context())

  assert.ok(!limitations.some(item => item.includes('not available')))
  assert.ok(limitations.some(item => item.includes('src/Chatbot.ts was truncated')))
  assert.ok(limitations.includes('Browser behavior was not executed.'))
})
