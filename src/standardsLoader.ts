import { readFile } from 'node:fs/promises'
import path from 'node:path'

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

export async function loadStandards(
  testType: TestType,
  paths: StandardsPaths,
): Promise<{ content: string; files: string[] }> {
  if (testType === 'component') {
    return { content: await readStandard(paths.component), files: [paths.component] }
  }

  if (testType === 'e2e') {
    return { content: await readStandard(paths.e2e), files: [paths.e2e] }
  }

  const [component, e2e] = await Promise.all([
    readStandard(paths.component),
    readStandard(paths.e2e),
  ])
  return {
    content: `# Component testing standards\n\n${component}\n\n# E2E testing standards\n\n${e2e}`,
    files: [paths.component, paths.e2e],
  }
}
