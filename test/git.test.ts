import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { changedCypressFiles, fileDiff, filterReviewableFiles } from '../src/git.js'

const execFileAsync = promisify(execFile)

async function createFile(root: string, relativePath: string, content: string): Promise<void> {
  const destination = path.join(root, relativePath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, content, 'utf8')
}

async function createRepository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-review-git-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'qa-review@example.test'], { cwd: root })
  await execFileAsync('git', ['config', 'user.name', 'QA Reviewer'], { cwd: root })
  return root
}

test('strict explicit input rejects missing, non-test, non-file, and escaping paths', async t => {
  const root = await createRepository(t)
  await createFile(root, 'Valid.cy.ts', "it('works', () => {})")
  await createFile(root, 'NotATest.ts', 'export {}')
  await mkdir(path.join(root, 'Directory.cy.ts'))

  assert.deepEqual(await filterReviewableFiles(root, ['Valid.cy.ts'], { strict: true }), ['Valid.cy.ts'])
  await assert.rejects(
    () => filterReviewableFiles(root, ['Missing.cy.ts'], { strict: true }),
    /file does not exist or cannot be read/,
  )
  await assert.rejects(
    () => filterReviewableFiles(root, ['NotATest.ts'], { strict: true }),
    /not a recognized Cypress test file/,
  )
  await assert.rejects(
    () => filterReviewableFiles(root, ['Directory.cy.ts'], { strict: true }),
    /path is not a file/,
  )
  await assert.rejects(
    () => filterReviewableFiles(root, ['../Outside.ts'], { strict: true }),
    /outside the repository/,
  )

  const outside = await mkdtemp(path.join(tmpdir(), 'qa-review-outside-'))
  t.after(async () => rm(outside, { recursive: true, force: true }))
  await createFile(outside, 'External.cy.ts', "it('escapes', () => {})")
  await symlink(path.join(outside, 'External.cy.ts'), path.join(root, 'Linked.cy.ts'))
  await assert.rejects(
    () => filterReviewableFiles(root, ['Linked.cy.ts'], { strict: true }),
    /resolves outside the repository/,
  )
})

test('base discovery and file diffs include staged, unstaged, and untracked tests', async t => {
  const root = await createRepository(t)
  await createFile(root, 'Tracked.cy.ts', "it('initial', () => {})\n")
  await createFile(root, 'Staged.cy.ts', "it('initial staged', () => {})\n")
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root })

  await createFile(root, 'Tracked.cy.ts', "it('working tree', () => {})\n")
  await createFile(root, 'Staged.cy.ts', "it('staged change', () => {})\n")
  await execFileAsync('git', ['add', 'Staged.cy.ts'], { cwd: root })
  await createFile(root, 'Untracked.cy.ts', "it('untracked', () => {})\n")

  assert.deepEqual(await changedCypressFiles(root, 'HEAD'), [
    'Staged.cy.ts',
    'Tracked.cy.ts',
    'Untracked.cy.ts',
  ])
  assert.match(await fileDiff(root, 'HEAD', 'Tracked.cy.ts'), /working tree/)
  assert.match(await fileDiff(root, 'HEAD', 'Staged.cy.ts'), /staged change/)
})
