import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { collectContext } from '../src/contextCollector.js'

const execFileAsync = promisify(execFile)

async function createFile(root: string, filePath: string, content: string): Promise<void> {
  const absolute = path.join(root, filePath)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

test('collects imports, fixtures, support, and matching source files within limits', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-review-context-'))
  t.after(async () => rm(root, { recursive: true, force: true }))

  const testFile = 'WebAppTests/EndToEnd/cypress/e2e/login/Login.cy.ts'
  await createFile(root, testFile, `import { login } from '../../support/auth'
describe('login', () => {
  it('logs in', () => {
    cy.fixture('users')
    login()
  })
})`)
  await createFile(root, 'WebAppTests/EndToEnd/cypress/support/auth.ts', 'export function login() {}')
  await createFile(root, 'WebAppTests/EndToEnd/cypress/support/commands.ts', 'Cypress.Commands.add("login", () => {})')
  await createFile(root, 'WebAppTests/EndToEnd/cypress/support/e2e.ts', "import './commands'")
  await createFile(root, 'WebAppTests/EndToEnd/cypress/fixtures/users.json', '{"valid":true}')
  await createFile(root, 'WebAppComponents/ClientApp/src/pages/LoginPage.ts', 'export class LoginPage {}')

  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })

  const result = await collectContext(root, testFile, null, {
    maxRelatedFiles: 5,
    maxContextCharacters: 50_000,
    maxSingleFileCharacters: 12_000,
  })

  assert.equal(result.test_file.path, testFile)
  assert.deepEqual(
    result.related_files.map(file => file.path),
    [
      'WebAppTests/EndToEnd/cypress/support/auth.ts',
      'WebAppTests/EndToEnd/cypress/fixtures/users.json',
      'WebAppTests/EndToEnd/cypress/support/commands.ts',
      'WebAppTests/EndToEnd/cypress/support/e2e.ts',
      'WebAppComponents/ClientApp/src/pages/LoginPage.ts',
    ],
  )
})

test('resolves WebApp component import aliases', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-review-alias-'))
  t.after(async () => rm(root, { recursive: true, force: true }))

  const testFile = 'WebAppComponents/ClientApp/src/components/address/Address.cy.ts'
  await createFile(root, testFile, `import { helper } from '@test-home/support/helper'
import { Address } from './Address'
import '@/components/dialog/Dialog'
helper(Address)`)
  await createFile(root, 'WebAppComponents/ClientApp/cypress/support/helper.ts', 'export function helper(value: unknown) { return value }')
  await createFile(root, 'WebAppComponents/ClientApp/src/components/address/Address.ts', 'export class Address {}')
  await createFile(root, 'WebAppComponents/ClientApp/src/components/dialog/Dialog.ts', 'export class Dialog {}')

  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })

  const result = await collectContext(root, testFile, null, {
    maxRelatedFiles: 5,
    maxContextCharacters: 20_000,
    maxSingleFileCharacters: 5_000,
  })

  assert.deepEqual(
    result.related_files.slice(0, 3).map(file => file.path),
    [
      'WebAppComponents/ClientApp/cypress/support/helper.ts',
      'WebAppComponents/ClientApp/src/components/address/Address.ts',
      'WebAppComponents/ClientApp/src/components/dialog/Dialog.ts',
    ],
  )
})

test('does not collect imported context through a symlink outside the repository', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-review-context-boundary-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'qa-review-context-outside-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const testFile = 'tests/Boundary.cy.ts'
  await createFile(root, testFile, "import './External'\nit('stays inside', () => {})")
  await createFile(outside, 'External.ts', 'export const secret = true')
  await symlink(path.join(outside, 'External.ts'), path.join(root, 'tests/External.ts'))
  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['add', 'tests/Boundary.cy.ts'], { cwd: root })

  const result = await collectContext(root, testFile, null, {
    maxRelatedFiles: 5,
    maxContextCharacters: 20_000,
    maxSingleFileCharacters: 5_000,
  })

  assert.deepEqual(result.related_files, [])
})

test('retains complete local backing content and truthful size metadata for a truncated imported source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-review-context-full-source-'))
  t.after(async () => rm(root, { recursive: true, force: true }))

  const testFile = 'WebAppComponents/ClientApp/src/components/example/Example.cy.ts'
  const source = `export class Example {\n${'  filler = true\n'.repeat(150)}  handleSave() { return 'saved' }\n}`
  await createFile(root, testFile, "import './Example'\nit('saves', () => { cy.get('lvl-example').then(el => el[0].handleSave()) })")
  await createFile(root, 'WebAppComponents/ClientApp/src/components/example/Example.ts', source)
  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })

  const result = await collectContext(root, testFile, null, {
    maxRelatedFiles: 2,
    maxContextCharacters: 1_000,
    maxSingleFileCharacters: 300,
  })

  const implementation = result.related_files.find(file => file.path.endsWith('/Example.ts'))
  assert.equal(implementation?.truncated, true)
  assert.equal(implementation?.original_character_count, source.length)
  assert.equal(implementation?.full_content, source)
  assert.match(implementation?.full_content_hash ?? '', /^[a-f0-9]{64}$/)
})
