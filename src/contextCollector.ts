import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { fileDiff, trackedFiles } from './git.js'
import type { ContextLimits, RelatedFile, ReviewContext } from './types.js'

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.json']
const GENERIC_NAME_TERMS = new Set(['test', 'tests', 'spec', 'cypress', 'component', 'components', 'page'])

interface Candidate {
  path: string
  reason: string
  terms: string[]
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function resolveExistingFile(basePath: string): Promise<string | null> {
  const candidates = path.extname(basePath)
    ? [basePath]
    : [
        ...DEFAULT_EXTENSIONS.map(extension => `${basePath}${extension}`),
        ...DEFAULT_EXTENSIONS.map(extension => path.join(basePath, `index${extension}`)),
      ]

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return await realpath(candidate)
      }
    } catch {
      // Try the next supported extension.
    }
  }
  return null
}

function importSpecifiers(content: string): string[] {
  const imports = new Set<string>()
  const patterns = [
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) {
        imports.add(specifier)
      }
    }
  }
  return [...imports]
}

function fixtureNames(content: string): string[] {
  return [...content.matchAll(/cy\.fixture\(\s*['"]([^'"]+)['"]/g)]
    .map(match => match[1])
    .filter((name): name is string => Boolean(name))
}

function cypressRootFor(testFile: string): string | null {
  const normalized = normalize(testFile)
  const parts = normalized.split('/')
  const cypressIndex = parts.lastIndexOf('cypress')
  if (cypressIndex >= 0) {
    return parts.slice(0, cypressIndex + 1).join('/')
  }
  if (normalized.startsWith('WebAppComponents/ClientApp/')) {
    return 'WebAppComponents/ClientApp/cypress'
  }
  return null
}

function testNameTerms(filePath: string): string[] {
  const stem = path.basename(filePath).replace(/\.(?:cy|spec)\.[^.]+$/i, '')
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map(term => term.toLowerCase())
    .filter(term => term.length >= 3 && !GENERIC_NAME_TERMS.has(term))
}

function relevantSourceFiles(files: string[], testFile: string): Candidate[] {
  const terms = testNameTerms(testFile)
  if (terms.length === 0) {
    return []
  }

  const sourcePrefixes = [
    'WebAppComponents/ClientApp/src/',
    'WebApp/ClientApp/src/',
    'WebApp/src/',
  ]

  return files
    .filter(file => sourcePrefixes.some(prefix => normalize(file).startsWith(prefix)))
    .filter(file => DEFAULT_EXTENSIONS.includes(path.extname(file).toLowerCase()))
    .filter(file => !/\.(?:cy|spec)\.[^.]+$/i.test(file))
    .map(file => {
      const fileName = path.basename(file).toLowerCase()
      const matches = terms.filter(term => fileName.includes(term))
      return { file, matches }
    })
    .filter(candidate => candidate.matches.length > 0)
    .sort((left, right) => {
      const matchDifference = right.matches.length - left.matches.length
      return matchDifference || left.file.length - right.file.length || left.file.localeCompare(right.file)
    })
    .map(candidate => ({
      path: candidate.file,
      reason: `Source filename matched test term(s): ${candidate.matches.join(', ')}`,
      terms,
    }))
}

function condenseLargeFile(content: string, terms: string[], limit: number): string {
  if (content.length <= limit) {
    return content
  }

  const lines = content.split('\n')
  const selected = new Set<number>()
  const loweredTerms = terms.map(term => term.toLowerCase())

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lowered = line.toLowerCase()
    if (
      /^\s*(?:import|export)\b/.test(line) ||
      loweredTerms.some(term => lowered.includes(term))
    ) {
      for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 2); nearby += 1) {
        selected.add(nearby)
      }
    }
  }

  const condensed = [...selected]
    .sort((left, right) => left - right)
    .map(index => `${index + 1}: ${lines[index] ?? ''}`)
    .join('\n')

  const fallback = `${content.slice(0, Math.floor(limit * 0.7))}\n\n...[truncated]...\n\n${content.slice(-Math.floor(limit * 0.25))}`
  const result = condensed.length >= 200 ? condensed : fallback
  return result.slice(0, limit)
}

function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) {
    return diff
  }
  const headLength = Math.floor(limit * 0.6)
  const tailLength = Math.max(0, limit - headLength - 32)
  return `${diff.slice(0, headLength)}\n\n...[diff truncated]...\n\n${diff.slice(-tailLength)}`
}

async function addCandidate(
  repoRoot: string,
  candidate: Candidate,
  selected: RelatedFile[],
  seen: Set<string>,
  limits: ContextLimits,
  remainingCharacters: { value: number },
): Promise<void> {
  if (selected.length >= limits.maxRelatedFiles || remainingCharacters.value <= 0) {
    return
  }

  const relativePath = normalize(candidate.path)
  if (seen.has(relativePath)) {
    return
  }

  try {
    const absolutePath = path.resolve(repoRoot, relativePath)
    const [realRoot, realCandidate] = await Promise.all([realpath(repoRoot), realpath(absolutePath)])
    if (!pathWithin(realRoot, realCandidate)) return
    const original = await readFile(realCandidate, 'utf8')
    const allowed = Math.min(limits.maxSingleFileCharacters, remainingCharacters.value)
    const content = condenseLargeFile(original, candidate.terms, allowed)
    if (!content.trim()) {
      return
    }
    selected.push({
      path: relativePath,
      reason: candidate.reason,
      content,
      truncated: content.length < original.length,
    })
    seen.add(relativePath)
    remainingCharacters.value -= content.length
  } catch {
    // Related context is best effort; a missing candidate must not fail the review.
  }
}

export async function collectContext(
  repoRoot: string,
  testFile: string,
  base: string | null,
  limits: ContextLimits,
): Promise<ReviewContext> {
  const resolvedRepoRoot = await realpath(repoRoot)
  const normalizedTestFile = normalize(path.relative(repoRoot, path.resolve(repoRoot, testFile)))
  const absoluteTestFile = path.resolve(repoRoot, normalizedTestFile)
  const content = await readFile(absoluteTestFile, 'utf8')
  const rawDiff = await fileDiff(repoRoot, base, normalizedTestFile)

  // The complete test file is mandatory even when it exceeds the configured budget.
  // The limit therefore caps the additional diff and related context.
  const diffBudget = Math.floor(limits.maxContextCharacters / 2)
  let remaining = limits.maxContextCharacters
  const diff = truncateDiff(rawDiff, diffBudget)
  remaining -= diff.length

  const candidates: Candidate[] = []
  for (const specifier of importSpecifiers(content)) {
    let importBase: string | null = null
    if (specifier.startsWith('.')) {
      importBase = path.resolve(path.dirname(absoluteTestFile), specifier)
    } else if (specifier.startsWith('@/')) {
      importBase = path.resolve(repoRoot, 'WebAppComponents/ClientApp/src', specifier.slice(2))
    } else if (specifier.startsWith('@test-home/')) {
      importBase = path.resolve(repoRoot, 'WebAppComponents/ClientApp/cypress', specifier.slice('@test-home/'.length))
    }
    if (!importBase) {
      continue
    }

    const resolved = await resolveExistingFile(importBase)
    if (resolved && pathWithin(resolvedRepoRoot, resolved)) {
      candidates.push({
        path: path.relative(resolvedRepoRoot, resolved),
        reason: `Imported by ${normalizedTestFile}`,
        terms: testNameTerms(testFile),
      })
    }
  }

  const cypressRoot = cypressRootFor(normalizedTestFile)
  if (cypressRoot) {
    for (const fixture of fixtureNames(content)) {
      const fixtureBase = path.resolve(repoRoot, cypressRoot, 'fixtures', fixture)
      const resolved = await resolveExistingFile(fixtureBase)
      if (resolved && pathWithin(resolvedRepoRoot, resolved)) {
        candidates.push({
          path: path.relative(resolvedRepoRoot, resolved),
          reason: `Referenced by cy.fixture('${fixture}')`,
          terms: [path.basename(fixture).toLowerCase()],
        })
      }
    }

    for (const supportFile of ['commands.ts', 'e2e.ts', 'component.ts']) {
      candidates.push({
        path: path.join(cypressRoot, 'support', supportFile),
        reason: 'Cypress support file',
        terms: testNameTerms(testFile),
      })
    }
  }

  candidates.push(...relevantSourceFiles(await trackedFiles(repoRoot), normalizedTestFile))

  const relatedFiles: RelatedFile[] = []
  const seen = new Set<string>([normalizedTestFile])
  const remainingCharacters = { value: remaining }
  for (const candidate of candidates) {
    await addCandidate(repoRoot, candidate, relatedFiles, seen, limits, remainingCharacters)
  }

  return {
    test_file: { path: normalizedTestFile, content },
    diff,
    related_files: relatedFiles,
  }
}
