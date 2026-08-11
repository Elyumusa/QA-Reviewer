import path from 'node:path'

import type { TestType } from './types.js'

const CYPRESS_TEST_EXTENSION = /\.(?:cy|spec)\.(?:[cm]?[jt]sx?)$/i
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i

function portablePath(filePath: string): string {
  return filePath.split(path.sep).join('/').toLowerCase()
}

export function isCypressTestFile(filePath: string): boolean {
  const normalized = portablePath(filePath)

  if (CYPRESS_TEST_EXTENSION.test(normalized)) {
    return true
  }

  return /(^|\/)cypress\/e2e\//.test(normalized) && SCRIPT_EXTENSION.test(normalized)
}

export function classifyTestFile(filePath: string): TestType {
  const normalized = portablePath(filePath)

  if (
    normalized.includes('/webapptests/endtoend/cypress/e2e/') ||
    normalized.includes('/cypress/e2e/') ||
    /(^|\/)e2e(\/|$)/.test(normalized)
  ) {
    return 'e2e'
  }

  if (
    /(^|\/)webappcomponents\/clientapp\/src\//.test(normalized) ||
    normalized.includes('/cypress/component/') ||
    normalized.includes('/components/') ||
    normalized.includes('/component/')
  ) {
    return 'component'
  }

  return 'unknown'
}
