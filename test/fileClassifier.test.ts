import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTestFile, isCypressTestFile } from '../src/fileClassifier.js'

test('recognizes the WebApp component and E2E layouts', () => {
  assert.equal(
    classifyTestFile('WebAppComponents/ClientApp/src/components/inputs/address/Address.cy.ts'),
    'component',
  )
  assert.equal(
    classifyTestFile('WebAppComponents/ClientApp/src/services/chatbot/Chatbot.cy.ts'),
    'component',
  )
  assert.equal(
    classifyTestFile('WebAppTests/EndToEnd/cypress/e2e/zip-viewer/ZipViewer.cy.ts'),
    'e2e',
  )
  assert.equal(classifyTestFile('tests/Smoke.cy.ts'), 'unknown')
})

test('filters test specs without treating support files as tests', () => {
  assert.equal(isCypressTestFile('src/components/Address.cy.ts'), true)
  assert.equal(isCypressTestFile('cypress/e2e/login.ts'), true)
  assert.equal(isCypressTestFile('cypress/support/commands.ts'), false)
  assert.equal(isCypressTestFile('src/components/Address.ts'), false)
})
