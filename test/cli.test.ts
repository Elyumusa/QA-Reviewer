import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import { parseArguments } from '../src/cli.js'

const execFileAsync = promisify(execFile)

test('manual files do not require the default Git base', () => {
  const options = parseArguments(['--files', 'one.cy.ts', 'two.cy.ts', '--format', 'both'])
  assert.deepEqual(options.files, ['one.cy.ts', 'two.cy.ts'])
  assert.equal(options.base, null)
  assert.equal(options.format, 'both')
})

test('explicit base is retained during manual review', () => {
  const options = parseArguments(['--base', 'main', '--files', 'one.cy.ts'])
  assert.equal(options.base, 'main')
})

test('rejects unsupported formats', () => {
  assert.throws(() => parseArguments(['--format', 'xml']), /json, markdown, or both/)
})

test('audit mode raises context limits and accepts bounded chunk settings', () => {
  const options = parseArguments(['--mode', 'audit', '--audit-chunk-lines', '500', '--audit-concurrency', '3'])
  assert.equal(options.mode, 'audit')
  assert.equal(options.auditChunkLines, 500)
  assert.equal(options.auditConcurrency, 3)
  assert.deepEqual(options.limits, {
    maxRelatedFiles: 8,
    maxContextCharacters: 180_000,
    maxSingleFileCharacters: 100_000,
  })
})

test('audit mode rejects deterministic-only execution', () => {
  assert.throws(() => parseArguments(['--mode', 'audit', '--deterministic-only']), /requires AI review/)
})

test('can disable audit checkpoints explicitly', () => {
  assert.equal(parseArguments(['--mode', 'audit', '--no-audit-cache']).auditCache, false)
})

test('accepts supported AI providers and the Claude alias', () => {
  assert.equal(parseArguments(['--provider', 'openai']).provider, 'openai')
  assert.equal(parseArguments(['--provider', 'anthropic']).provider, 'anthropic')
  assert.equal(parseArguments(['--provider', 'claude']).provider, 'anthropic')
  assert.throws(() => parseArguments(['--provider', 'other']), /deepseek, openai, or anthropic/)
})

test('runs the CLI when invoked through the npm bin symlink', async t => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'qa-review-bin-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const linkPath = path.join(directory, 'qa-review')
  await symlink(cliPath, linkPath)
  const result = await execFileAsync(process.execPath, [linkPath, '--help'])
  assert.match(result.stdout, /Cypress AI Quality Reviewer/)
})
