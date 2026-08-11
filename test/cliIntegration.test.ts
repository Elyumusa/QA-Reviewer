import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url))

async function createRepository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-review-cli-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  await execFileAsync('git', ['init'], { cwd: root })
  await mkdir(path.join(root, 'tests'), { recursive: true })
  await writeFile(path.join(root, 'tests/Example.cy.ts'), "it('works', () => {})\n", 'utf8')
  await mkdir(path.join(root, 'WebAppComponents/ClientApp/src/components'), { recursive: true })
  await mkdir(path.join(root, 'WebAppTests/EndToEnd'), { recursive: true })
  await writeFile(
    path.join(root, 'WebAppComponents/ClientApp/src/components/COMPONENT_TESTING_STANDARDS.md'),
    '# Component standards\n',
    'utf8',
  )
  await writeFile(path.join(root, 'WebAppTests/EndToEnd/TESTING_STANDARDS.md'), '# E2E standards\n', 'utf8')
  return root
}

function environmentWithoutDeepSeekKey(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.QA_AI_PROVIDER
  delete environment.DEEPSEEK_API_KEY
  delete environment.DEEPSEEK_MODEL
  delete environment.DEEPSEEK_API_URL
  delete environment.OPENAI_API_KEY
  delete environment.OPENAI_MODEL
  delete environment.OPENAI_API_URL
  delete environment.ANTHROPIC_API_KEY
  delete environment.ANTHROPIC_MODEL
  delete environment.ANTHROPIC_API_URL
  delete environment.ANTHROPIC_VERSION
  return environment
}

test('missing API configuration still produces a structured error report', async t => {
  const root = await createRepository(t)
  let failure: unknown
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      '--files', 'tests/Example.cy.ts',
      '--output', 'result.json',
    ], { cwd: root, env: environmentWithoutDeepSeekKey() })
  } catch (error) {
    failure = error
  }

  assert.ok(failure)
  const report = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')) as {
    status: string
    provider: string
    files: Array<{ status: string; summary: string }>
    errors: string[]
  }
  assert.equal(report.status, 'completed_with_errors')
  assert.equal(report.provider, 'deepseek')
  assert.equal(report.files[0]?.status, 'error')
  assert.match(report.files[0]?.summary ?? '', /Missing DEEPSEEK_API_KEY/)
  assert.equal(report.errors.length, 1)
})

test('selected provider reports its own missing key and model metadata', async t => {
  const root = await createRepository(t)
  await assert.rejects(() => execFileAsync(process.execPath, [
    cliPath,
    '--provider', 'openai',
    '--files', 'tests/Example.cy.ts',
    '--output', 'openai-missing.json',
  ], { cwd: root, env: environmentWithoutDeepSeekKey() }))

  const report = JSON.parse(await readFile(path.join(root, 'openai-missing.json'), 'utf8')) as {
    provider: string
    model: string
    errors: string[]
  }
  assert.equal(report.provider, 'openai')
  assert.equal(report.model, 'gpt-5.6-sol')
  assert.match(report.errors[0] ?? '', /Missing OPENAI_API_KEY/)
})

test('an explicit missing Cypress file fails clearly instead of becoming an empty success', async t => {
  const root = await createRepository(t)
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      cliPath,
      '--files', 'tests/Missing.cy.ts',
      '--deterministic-only',
    ], { cwd: root, env: environmentWithoutDeepSeekKey() }),
    error => {
      const stderr = String((error as { stderr?: string }).stderr ?? '')
      assert.match(stderr, /Invalid --files input/)
      assert.match(stderr, /file does not exist or cannot be read/)
      return true
    },
  )
})

test('an invalid API key produces focused provider diagnostics in the report', async t => {
  const root = await createRepository(t)
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid API key' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const environment = {
    ...environmentWithoutDeepSeekKey(),
    DEEPSEEK_API_KEY: 'wrong-key',
    DEEPSEEK_MODEL: 'test-model',
    DEEPSEEK_API_URL: `http://127.0.0.1:${address.port}/chat/completions`,
  }

  await assert.rejects(() => execFileAsync(process.execPath, [
    cliPath,
    '--files', 'tests/Example.cy.ts',
    '--output', 'invalid-key.json',
  ], { cwd: root, env: environment }))

  const report = JSON.parse(await readFile(path.join(root, 'invalid-key.json'), 'utf8')) as {
    files: Array<{ status: string; provider_requests?: Array<{ status: string }> }>
  }
  assert.equal(report.files[0]?.status, 'error')
  assert.equal(report.files[0]?.provider_requests?.[0]?.status, 'api_error')
})

test('an invalid report destination fails before review work begins', async t => {
  const root = await createRepository(t)
  await mkdir(path.join(root, 'blocked.json'))

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      cliPath,
      '--files', 'tests/Example.cy.ts',
      '--deterministic-only',
      '--output', 'blocked.json',
    ], { cwd: root, env: environmentWithoutDeepSeekKey() }),
    error => {
      assert.match(String((error as { stderr?: string }).stderr ?? ''), /Report destination is not a file/)
      return true
    },
  )
})

test('running outside a Git repository fails with a clear Git-root error', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-review-no-repository-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))

  await assert.rejects(
    () => execFileAsync(process.execPath, [cliPath, '--deterministic-only'], {
      cwd: directory,
      env: environmentWithoutDeepSeekKey(),
    }),
    error => {
      assert.match(String((error as { stderr?: string }).stderr ?? ''), /Git command failed: git rev-parse --show-toplevel/)
      return true
    },
  )
})

test('bundled standards are used when the WebApp copy is absent', async t => {
  const root = await createRepository(t)
  await rm(path.join(root, 'WebAppComponents/ClientApp/src/components/COMPONENT_TESTING_STANDARDS.md'))

  await execFileAsync(process.execPath, [
    cliPath,
    '--files', 'tests/Example.cy.ts',
    '--deterministic-only',
    '--output', 'bundled-standards.json',
  ], { cwd: root, env: environmentWithoutDeepSeekKey() })

  const report = JSON.parse(await readFile(path.join(root, 'bundled-standards.json'), 'utf8')) as {
    status: string
    files: Array<{ status: string; summary: string }>
  }
  assert.equal(report.status, 'completed')
  assert.equal(report.files[0]?.status, 'pass')
  assert.match(report.files[0]?.summary ?? '', /No deterministic issues found/)
})

test('bundled E2E standards are used for an E2E file when the project copy is absent', async t => {
  const root = await createRepository(t)
  await mkdir(path.join(root, 'WebAppTests/EndToEnd/cypress/e2e'), { recursive: true })
  await writeFile(path.join(root, 'WebAppTests/EndToEnd/cypress/e2e/Example.cy.ts'), "it('works', () => {})\n", 'utf8')
  await rm(path.join(root, 'WebAppTests/EndToEnd/TESTING_STANDARDS.md'))

  await execFileAsync(process.execPath, [
    cliPath,
    '--files', 'WebAppTests/EndToEnd/cypress/e2e/Example.cy.ts',
    '--deterministic-only',
    '--output', 'bundled-e2e-standards.json',
  ], { cwd: root, env: environmentWithoutDeepSeekKey() })

  const report = JSON.parse(await readFile(path.join(root, 'bundled-e2e-standards.json'), 'utf8')) as {
    status: string
    files: Array<{ status: string; test_type: string }>
  }
  assert.equal(report.status, 'completed')
  assert.equal(report.files[0]?.status, 'pass')
  assert.equal(report.files[0]?.test_type, 'e2e')
})

test('an incomplete audit preserves deterministic findings and records partial execution', async t => {
  const root = await createRepository(t)
  await writeFile(path.join(root, 'tests/Example.cy.ts'), "it('waits', () => { cy.wait(100) })\n", 'utf8')
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw) as { messages?: Array<{ content?: string }> }
      const system = body.messages?.[0]?.content ?? ''
      if (system.includes('global test-structure analyst')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          model: 'test-model',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            summary: 'One test.',
            suites: [], shared_infrastructure: [], cross_suite_patterns: [],
            context_used: ['tests/Example.cy.ts'], limitations: [],
          }) } }],
        }))
        return
      }
      request.socket.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const environment = {
    ...environmentWithoutDeepSeekKey(),
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'test-model',
    DEEPSEEK_API_URL: `http://127.0.0.1:${address.port}/chat/completions`,
  }

  await assert.rejects(() => execFileAsync(process.execPath, [
    cliPath,
    '--mode', 'audit',
    '--test-type', 'component',
    '--transport-retries', '0',
    '--files', 'tests/Example.cy.ts',
    '--output', 'partial-audit.json',
  ], { cwd: root, env: environment }))

  const report = JSON.parse(await readFile(path.join(root, 'partial-audit.json'), 'utf8')) as {
    status: string
    summary: { high: number }
    errors: string[]
    files: Array<{
      status: string
      test_type: string
      findings: Array<{ rule: string }>
      audit?: { execution: { complete: boolean; test_chunks_reviewed: number; test_chunks_total: number } }
    }>
  }
  assert.equal(report.status, 'completed_with_errors')
  assert.equal(report.files[0]?.status, 'error')
  assert.equal(report.files[0]?.test_type, 'component')
  assert.ok(report.files[0]?.findings.some(finding => finding.rule === 'CYPRESS-ASYNC-001'))
  assert.equal(report.summary.high, 1)
  assert.equal(report.files[0]?.audit?.execution.complete, false)
  assert.equal(report.files[0]?.audit?.execution.test_chunks_reviewed, 0)
  assert.equal(report.files[0]?.audit?.execution.test_chunks_total, 1)
  assert.equal(report.errors.length, 1)
})
