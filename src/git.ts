import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { QualityReviewerError } from './errors.js'
import { isCypressTestFile } from './fileClassifier.js'

const execFileAsync = promisify(execFile)

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return result.stdout.trim()
  } catch (error) {
    throw new QualityReviewerError(`Git command failed: git ${args.join(' ')}`, { cause: error })
  }
}

export async function findRepositoryRoot(startDirectory = process.cwd()): Promise<string> {
  const result = await git(startDirectory, ['rev-parse', '--show-toplevel'])
  if (!result) {
    throw new QualityReviewerError(`Could not determine the Git repository root from ${startDirectory}`)
  }
  return result
}

export async function changedCypressFiles(repoRoot: string, base: string): Promise<string[]> {
  const [committed, unstaged, staged, untracked] = await Promise.all([
    git(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--']),
    git(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', '--']),
    git(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--']),
    git(repoRoot, ['ls-files', '--others', '--exclude-standard']),
  ])

  const files = [committed, unstaged, staged, untracked]
    .flatMap(output => output.split('\n'))
    .filter(Boolean)
  return filterReviewableFiles(repoRoot, files)
}

export async function filterReviewableFiles(
  repoRoot: string,
  files: string[],
  options: { strict?: boolean } = {},
): Promise<string[]> {
  const unique = [...new Set(files.map(file => path.normalize(file)))]
  const accepted: string[] = []
  const rejected: string[] = []
  const absoluteRoot = path.resolve(repoRoot)
  const realRoot = await realpath(absoluteRoot)

  const reject = (file: string, reason: string): void => {
    if (options.strict) rejected.push(`${file} (${reason})`)
  }

  for (const file of unique) {
    const absolutePath = path.resolve(absoluteRoot, file)
    const lexicalRelative = path.relative(absoluteRoot, absolutePath)
    if (lexicalRelative === '' || lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
      throw new QualityReviewerError(`File is outside the repository: ${file}`)
    }

    if (!isCypressTestFile(file)) {
      reject(file, 'not a recognized Cypress test file')
      continue
    }

    try {
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile()) {
        reject(file, 'path is not a file')
        continue
      }
      const realFile = await realpath(absolutePath)
      const realRelative = path.relative(realRoot, realFile)
      if (realRelative === '' || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new QualityReviewerError(`File resolves outside the repository: ${file}`)
      }
      accepted.push(path.relative(repoRoot, absolutePath))
    } catch (error) {
      if (error instanceof QualityReviewerError) throw error
      reject(file, 'file does not exist or cannot be read')
    }
  }

  if (rejected.length > 0) {
    throw new QualityReviewerError(`Invalid --files input: ${rejected.join('; ')}`)
  }

  return accepted.sort()
}

export async function fileDiff(repoRoot: string, base: string | null, filePath: string): Promise<string> {
  if (!base) {
    return ''
  }

  const mergeBase = await git(repoRoot, ['merge-base', base, 'HEAD'])
  if (!mergeBase) throw new QualityReviewerError(`Could not determine merge base for ${base} and HEAD`)
  return git(repoRoot, ['diff', '--no-ext-diff', '--unified=3', mergeBase, '--', filePath])
}

export async function trackedFiles(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, ['ls-files'])
  return output.split('\n').filter(Boolean)
}
