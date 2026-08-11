import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { QualityReviewerError } from './errors.js'
import type { StandardsPaths, TestType } from './types.js'

export function defaultStandardsPaths(repoRoot: string): StandardsPaths {
  return {
    component: path.join(
      repoRoot,
      'WebAppComponents/ClientApp/src/components/COMPONENT_TESTING_STANDARDS.md',
    ),
    e2e: path.join(repoRoot, 'WebAppTests/EndToEnd/TESTING_STANDARDS.md'),
  }
}

function bundledStandardsPaths(): StandardsPaths {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDirectory, '../standards'),
    path.resolve(moduleDirectory, '../../standards'),
  ]
  const directory = candidates.find(candidate =>
    existsSync(path.join(candidate, 'COMPONENT_TESTING_STANDARDS.md')) &&
    existsSync(path.join(candidate, 'TESTING_STANDARDS.md')),
  ) ?? candidates[candidates.length - 1]!

  return {
    component: path.join(directory, 'COMPONENT_TESTING_STANDARDS.md'),
    e2e: path.join(directory, 'TESTING_STANDARDS.md'),
  }
}

async function readStandard(filePath: string): Promise<string> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new QualityReviewerError(`Missing standards file: ${filePath}`, { cause: error })
  }

  if (!content.trim()) {
    throw new QualityReviewerError(`Standards file is empty: ${filePath}`)
  }
  return content
}

function isMissingStandardsFile(error: unknown): boolean {
  if (!(error instanceof QualityReviewerError)) return false
  const cause = error.cause
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
}

async function readPreferredStandard(primaryPath: string, bundledPath: string): Promise<{ content: string; path: string }> {
  try {
    return { content: await readStandard(primaryPath), path: primaryPath }
  } catch (error) {
    if (!isMissingStandardsFile(error) || primaryPath === bundledPath) throw error
    return { content: await readStandard(bundledPath), path: bundledPath }
  }
}

export async function loadStandards(
  testType: TestType,
  paths: StandardsPaths,
): Promise<{ content: string; files: string[] }> {
  const bundledPaths = bundledStandardsPaths()

  if (testType === 'component') {
    const standard = await readPreferredStandard(paths.component, bundledPaths.component)
    return { content: standard.content, files: [standard.path] }
  }

  if (testType === 'e2e') {
    const standard = await readPreferredStandard(paths.e2e, bundledPaths.e2e)
    return { content: standard.content, files: [standard.path] }
  }

  const [component, e2e] = await Promise.all([
    readPreferredStandard(paths.component, bundledPaths.component),
    readPreferredStandard(paths.e2e, bundledPaths.e2e),
  ])
  return {
    content: `# Component testing standards\n\n${component.content}\n\n# E2E testing standards\n\n${e2e.content}`,
    files: [component.path, e2e.path],
  }
}
