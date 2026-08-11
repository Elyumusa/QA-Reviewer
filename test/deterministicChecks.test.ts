import assert from 'node:assert/strict'
import test from 'node:test'

import { runDeterministicChecks } from '../src/deterministicChecks.js'

test('finds focused, fixed-wait, and skipped tests with 1-based lines', () => {
  const findings = runDeterministicChecks(`describe.only('suite', () => {
  cy.wait(3_000)
  it.skip('later', () => {})
})`)

  assert.deepEqual(
    findings.map(finding => [finding.rule, finding.line, finding.severity]),
    [
      ['CYPRESS-FOCUS-001', 1, 'critical'],
      ['CYPRESS-ASYNC-001', 2, 'high'],
      ['CYPRESS-SKIP-001', 3, 'medium'],
    ],
  )
})

test('does not flag commented examples or aliased waits', () => {
  const findings = runDeterministicChecks(`// it.only('example', () => {})
// cy.wait(1000)
cy.wait('@saveRecord')`)
  assert.deepEqual(findings, [])
})
