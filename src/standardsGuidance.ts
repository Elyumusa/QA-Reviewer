import type { Finding, OfficialReference, ReviewContext } from './types.js'

export interface StandardsSection {
  heading: string
  content: string
}

export interface StandardsGuidance {
  sections: StandardsSection[]
  officialReferences: OfficialReference[]
}

const CYPRESS_DOCUMENTATION_HOST = 'docs.cypress.io'
const maximumSectionCharacters = 7_000

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function words(value: string): Set<string> {
  return new Set(normalize(value).split(' ').filter(word => word.length >= 4))
}

export function parseStandardsGuidance(standards: string): StandardsGuidance {
  const lines = standards.split('\n')
  const sections: StandardsSection[] = []
  let heading = 'Standards introduction'
  let sectionLines: string[] = []

  const flush = (): void => {
    const content = sectionLines.join('\n').trim()
    if (content) sections.push({ heading, content: content.slice(0, maximumSectionCharacters) })
    sectionLines = []
  }

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/)
    if (match) {
      flush()
      heading = match[1]!.trim()
    } else {
      sectionLines.push(line)
    }
  }
  flush()

  const officialReferences = new Map<string, OfficialReference>()
  const linkPattern = /\[([^\]]+)]\((https:\/\/[^)]+)\)/g
  for (const match of standards.matchAll(linkPattern)) {
    try {
      const url = new URL(match[2]!)
      if (url.hostname !== CYPRESS_DOCUMENTATION_HOST) continue
      const normalizedUrl = url.toString()
      officialReferences.set(normalizedUrl, { title: match[1]!.trim(), url: normalizedUrl })
    } catch {
      // Invalid Markdown links are ignored rather than exposed to the model as trusted references.
    }
  }

  return { sections, officialReferences: [...officialReferences.values()] }
}

function sectionScore(section: StandardsSection, finding: Finding): number {
  const sectionWords = words(`${section.heading} ${section.content.slice(0, 1_500)}`)
  const findingWords = words([
    finding.title,
    finding.message,
    finding.suggestion,
    ...(finding.standards_references ?? []),
    ...finding.specific_cypress_methods,
  ].join(' '))
  let score = 0
  for (const word of findingWords) if (sectionWords.has(word)) score += 1
  const normalizedHeading = normalize(section.heading)
  for (const reference of finding.standards_references ?? []) {
    const normalizedReference = normalize(reference)
    if (normalizedReference.includes(normalizedHeading) || normalizedHeading.includes(normalizedReference)) score += 20
  }
  return score
}

export function relevantStandardsSections(
  guidance: StandardsGuidance,
  findings: Finding[],
  maximum = 6,
): StandardsSection[] {
  return guidance.sections
    .map((section, index) => ({ section, index, score: Math.max(...findings.map(finding => sectionScore(section, finding)), 0) }))
    .filter(entry => entry.score > 0 && !/^(references|table of contents|review checklist)$/i.test(entry.section.heading))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximum)
    .map(entry => entry.section)
}

export function officialReferencesForSections(
  guidance: StandardsGuidance,
  sections: StandardsSection[],
): OfficialReference[] {
  return guidance.officialReferences.filter(reference => sections.some(section => section.content.includes(reference.url)))
}

function numberedWindow(content: string, startLine: number, endLine: number, padding: number): string {
  const lines = content.split('\n')
  const start = Math.max(1, startLine - padding)
  const end = Math.min(lines.length, endLine + padding)
  return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')
}

function identifiers(value: string): string[] {
  const matches = value.match(/[A-Za-z_$][\w$-]{3,}/g) ?? []
  const ignored = new Set(['const', 'await', 'async', 'return', 'should', 'expect', 'describe', 'context', 'function', 'undefined'])
  return [...new Set(matches.filter(match => !ignored.has(match.toLowerCase())))].slice(0, 30)
}

function matchingWindows(content: string, terms: string[], maximum: number): string[] {
  const lines = content.split('\n')
  const selected: number[] = []
  for (let index = 0; index < lines.length && selected.length < maximum; index += 1) {
    if (!terms.some(term => lines[index]!.includes(term))) continue
    if (selected.some(line => Math.abs(line - index) <= 8)) continue
    selected.push(index)
  }
  return selected.map(index => numberedWindow(content, index + 1, index + 1, 4))
}

export function buildFindingEvidence(finding: Finding, context: ReviewContext): string {
  const endLine = finding.end_line ?? finding.line
  const primary = numberedWindow(context.test_file.content, finding.line, endLine, 12)
  const terms = identifiers(`${primary}\n${finding.title}\n${finding.message}\n${finding.evidence?.join('\n') ?? ''}`)
  const supportingTestWindows = matchingWindows(context.test_file.content, terms, 3)
    .filter(window => !window.includes(`${finding.line}:`))
  const related = context.related_files.flatMap(file => {
    const source = file.full_content ?? file.content
    const windows = matchingWindows(source, terms, 2)
    return windows.map(window => `FILE: ${file.path}${file.truncated && file.full_content ? ' (targeted from complete local source)' : ''}\n${window}`)
  }).slice(0, 4)

  return [
    `FINDING: ${finding.rule} at ${finding.line}-${endLine}`,
    'PRIMARY TEST WINDOW:',
    primary,
    ...(supportingTestWindows.length ? ['SUPPORTING WINDOWS FROM THE SAME TEST:', ...supportingTestWindows] : []),
    ...(related.length ? ['MATCHING PRODUCTION/RELATED WINDOWS:', ...related] : []),
  ].join('\n\n')
}
