import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAuditInventory, chunkSource } from '../src/auditInventory.js'

test('builds a deterministic audit inventory with evidence lines', () => {
  const inventory = buildAuditInventory(`describe('address', () => {
  beforeEach(() => {})
  afterEach(() => {})
  it('updates', () => {
    const picker = subject as any
    picker._map = {}
    if ($button.length > 0) {
      expect(picker).to.exist
    }
    cy.get('input').click({ force: true })
    cy.wait(150)
  })
})`)

  assert.equal(inventory.metrics.suite_count, 1)
  assert.equal(inventory.metrics.test_count, 1)
  assert.equal(inventory.metrics.any_cast_lines, 1)
  assert.equal(inventory.metrics.private_member_access_lines, 1)
  assert.equal(inventory.metrics.silent_conditional_assertion_blocks, 1)
  assert.equal(inventory.metrics.forced_interactions, 1)
  assert.equal(inventory.metrics.fixed_waits, 1)
  assert.deepEqual(inventory.metric_locations.fixed_waits, [11])
  assert.deepEqual(inventory.tests, [{ name: 'updates', line: 4 }])
})

test('chunks source with global line numbers and bounded overlap', () => {
  const content = Array.from({ length: 230 }, (_, index) => `line ${index + 1}`).join('\n')
  const chunks = chunkSource(content, 100, 10)
  assert.deepEqual(chunks.map(chunk => [chunk.start_line, chunk.end_line]), [[1, 100], [91, 190], [181, 230]])
  assert.match(chunks[1]?.content ?? '', /^91: line 91/m)
})

test('groups complete top-level suites into semantic chunks and carries shared setup', () => {
  const content = `import './component'
const mountAddress = () => cy.mount('<x-address />')

describe('rendering', () => {
  beforeEach(() => mountAddress())
  it('renders', () => cy.get('x-address').should('exist'))
})

describe('editing', () => {
  it('edits', () => cy.get('input').type('A'))
})`

  const chunks = chunkSource(content, 100, 10)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]?.kind, 'semantic')
  assert.deepEqual(chunks[0]?.scope, ['suite: rendering', 'suite: editing'])
  assert.match(chunks[0]?.shared_context ?? '', /mountAddress/)
  assert.match(chunks[0]?.content ?? '', /describe\('rendering'/)
  assert.match(chunks[0]?.content ?? '', /describe\('editing'/)
})

test('descends into an oversized outer suite and preserves its shared hooks', () => {
  const filler = Array.from({ length: 55 }, (_, index) => `    // detail ${index}`).join('\n')
  const content = `describe('outer', () => {
  beforeEach(() => cy.mount('<x-demo />'))
  describe('first area', () => {
${filler}
    it('first', () => cy.get('x-demo').should('exist'))
  })
  describe('second area', () => {
${filler}
    it('second', () => cy.get('x-demo').should('exist'))
  })
})`

  const chunks = chunkSource(content, 100, 10)
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every(chunk => chunk.kind === 'semantic'))
  assert.deepEqual(chunks[0]?.scope, ['suite: outer', 'suite: first area'])
  assert.deepEqual(chunks[1]?.scope, ['suite: outer', 'suite: second area'])
  assert.ok(chunks.every(chunk => chunk.shared_context.includes('beforeEach')))
})
