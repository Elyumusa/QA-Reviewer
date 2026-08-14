import ts from 'typescript'

import type { AuditContextManifestEntry, RelatedFile, ReviewContext, TargetedSourceExcerpt } from './types.js'

const ignoredIdentifiers = new Set([
  'after', 'afterEach', 'and', 'as', 'before', 'beforeEach', 'blur', 'body', 'called', 'catch',
  'click', 'clock', 'contains', 'context', 'document', 'each', 'eq', 'expect', 'find', 'first',
  'fixture', 'focus', 'get', 'have', 'include', 'intercept', 'invoke', 'its', 'last', 'length',
  'mount', 'not', 'request', 'response', 'should', 'spread', 'stub', 'then', 'tick', 'trigger',
  'type', 'value', 'visible', 'wait', 'window', 'within',
])

function normalizeName(name: string): string {
  return name.replace(/^_+/, '').toLowerCase()
}

function identifierTerms(text: string, includeBare = false): Set<string> {
  const terms = new Set<string>()
  const patterns = [
    /\.\s*([A-Za-z_$][\w$]{3,})/g,
    /\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]{3,})/g,
    /[`'"]([A-Za-z_$][\w$]{3,})[`'"]/g,
    ...(includeBare ? [/\b([A-Za-z_$][\w$]{3,})\b/g] : []),
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const term = match[1]
      if (term && !ignoredIdentifiers.has(term) && !ignoredIdentifiers.has(normalizeName(term))) terms.add(term)
    }
  }
  return terms
}

function nodeName(node: ts.Node): string | null {
  const named = node as ts.Node & { name?: ts.Node }
  if (!named.name) return null
  if (ts.isIdentifier(named.name) || ts.isPrivateIdentifier(named.name) || ts.isStringLiteral(named.name)) {
    return named.name.text
  }
  return null
}

function isRetrievableDeclaration(node: ts.Node): boolean {
  return ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isConstructorDeclaration(node)
}

function lineNumber(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

function boundedDeclaration(
  source: ts.SourceFile,
  content: string,
  node: ts.Node,
  symbol: string,
  maximumCharacters: number,
): TargetedSourceExcerpt {
  const start = node.getStart(source)
  const end = node.getEnd()
  const startLine = lineNumber(source, start)
  const endLine = lineNumber(source, end)
  const lines = content.slice(start, end).trim().split('\n')
  const numbered = lines.map((line, index) => `${startLine + index}: ${line}`).join('\n')
  return {
    path: source.fileName,
    symbol,
    start_line: startLine,
    end_line: endLine,
    content: numbered.length <= maximumCharacters
      ? numbered
      : `${numbered.slice(0, Math.floor(maximumCharacters * 0.72))}\n...[declaration excerpt truncated]...\n${numbered.slice(-Math.floor(maximumCharacters * 0.23))}`,
  }
}

interface DeclarationMatch {
  name: string
  node: ts.Node
  source: ts.SourceFile
  property: boolean
}

function declarations(file: RelatedFile): DeclarationMatch[] {
  const content = file.full_content ?? file.content
  const source = ts.createSourceFile(file.path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const result: DeclarationMatch[] = []
  const visit = (node: ts.Node): void => {
    if (isRetrievableDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : nodeName(node)
      if (name) result.push({ name, node, source, property: ts.isPropertyDeclaration(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function highValueDeclaration(name: string): boolean {
  return /^(?:connected|disconnected|firstUpdated|updated|willUpdate|render|handle|on|load|save|validate|clear|open|close|start|stop|send|create|delete|update)/i.test(name)
}

export function retrieveTargetedSourceExcerpts(
  context: ReviewContext,
  analysisEvidence: string,
  maximumCharacters = 36_000,
): TargetedSourceExcerpt[] {
  const testTerms = new Set([...identifierTerms(context.test_file.content)].map(normalizeName))
  const evidenceTerms = new Set([...identifierTerms(analysisEvidence, true)].map(normalizeName))
  const selected: TargetedSourceExcerpt[] = []
  let remaining = maximumCharacters

  for (const file of context.related_files) {
    if (!file.truncated || !file.full_content || remaining <= 0) continue
    const available = declarations(file)
    const behaviorSymbols = available.filter(item => !item.property)
    if (behaviorSymbols.length > 0 && remaining > 1_000) {
      const indexContent = behaviorSymbols
        .map(item => `${lineNumber(item.source, item.node.getStart(item.source))}: ${item.name}`)
        .join('\n')
        .slice(0, Math.min(8_000, remaining))
      selected.push({
        path: file.path,
        symbol: '__source_symbol_index__',
        start_line: 1,
        end_line: file.full_content.split('\n').length,
        content: indexContent,
      })
      remaining -= indexContent.length
    }

    const matched = available
      .map((item, index) => {
        const normalized = normalizeName(item.name)
        const score = (evidenceTerms.has(normalized) ? 100 : 0) +
          (testTerms.has(normalized) ? 20 : 0) +
          (!item.property ? 10 : 0) +
          (highValueDeclaration(item.name) ? 5 : 0)
        return { item, index, score }
      })
      .filter(entry => entry.score >= 20)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 24)
      .map(entry => entry.item)
    const orientation = available.filter(item => !item.property && highValueDeclaration(item.name) && !matched.includes(item)).slice(0, 6)
    for (const item of [...matched, ...orientation]) {
      if (remaining <= 600) break
      const excerpt = boundedDeclaration(item.source, file.full_content, item.node, item.name, Math.min(6_000, remaining))
      excerpt.path = file.path
      if (selected.some(existing => existing.path === excerpt.path && existing.start_line === excerpt.start_line)) continue
      selected.push(excerpt)
      remaining -= excerpt.content.length
    }
  }
  return selected
}

export function contextManifest(context: ReviewContext): AuditContextManifestEntry[] {
  const excerptCounts = new Map<string, number>()
  for (const excerpt of context.targeted_source_excerpts ?? []) {
    excerptCounts.set(excerpt.path, (excerptCounts.get(excerpt.path) ?? 0) + 1)
  }
  return [{
    path: context.test_file.path,
    role: 'test',
    status: 'complete',
    original_characters: context.test_file.content.length,
    supplied_characters: context.test_file.content.length,
    targeted_excerpts: 0,
  }, ...context.related_files.map(file => ({
    path: file.path,
    role: 'related' as const,
    status: file.truncated ? 'truncated' as const : 'complete' as const,
    original_characters: file.original_character_count ?? file.content.length,
    supplied_characters: file.content.length,
    targeted_excerpts: excerptCounts.get(file.path) ?? 0,
  }))]
}

export function reconcileContextLimitations(limitations: string[], context: ReviewContext): string[] {
  const manifest = contextManifest(context)
  const related = manifest.filter(item => item.role === 'related')
  const implementation = related.filter(item => /(?:^|\/)src\//.test(item.path) && !/\.(?:cy|spec)\.[^.]+$/i.test(item.path))
  const hasRelatedSource = implementation.length > 0
  const unavailableClaim = /\b(?:component|production|implementation)(?: implementation)? source\b.{0,45}\b(?:not available|unavailable|not provided|was missing|is missing)\b/i
  const retained = limitations.filter(limitation => !(hasRelatedSource && unavailableClaim.test(limitation)))
  if (limitations.length !== retained.length) {
    const truncated = implementation.filter(item => item.status === 'truncated').map(item => item.path)
    retained.push(truncated.length > 0
      ? `Implementation context was collected, but ${truncated.join(', ')} ${truncated.length === 1 ? 'was' : 'were'} truncated by the bounded base-context budget; targeted full-source excerpts were retrieved where matching symbols were identified.`
      : 'Implementation context was collected in full; model-generated claims that it was unavailable were removed using the deterministic context manifest.')
  }
  return [...new Set(retained)]
}
