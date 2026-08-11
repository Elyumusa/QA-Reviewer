import type { AuditInventory, AuditMetricName, AuditMetrics } from './types.js'
import ts from 'typescript'

function matchesOnLine(line: string, pattern: RegExp): number {
  return [...line.matchAll(pattern)].length
}

function executableLine(line: string): boolean {
  const trimmed = line.trimStart()
  return !trimmed.startsWith('//') && !trimmed.startsWith('*')
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

export function buildAuditInventory(content: string): AuditInventory {
  const lines = content.split('\n')
  const locations: Record<AuditMetricName, number[]> = {
    line_count: [],
    suite_count: [],
    test_count: [],
    any_cast_lines: [],
    forced_interactions: [],
    before_each_hooks: [],
    after_each_hooks: [],
    fixed_waits: [],
    skipped_tests: [],
    focused_tests: [],
    conditional_blocks: [],
    silent_conditional_assertion_blocks: [],
    private_member_access_lines: [],
    broad_exception_handlers: [],
    generic_selector_calls: [],
  }

  const tests: AuditInventory['tests'] = []
  const suites: AuditInventory['suites'] = []

  lines.forEach((line, index) => {
    if (!executableLine(line)) return
    const lineNumber = index + 1

    const testMatch = line.match(/\b(?:it|test|specify)(?:\.(?:only|skip))?\s*\(\s*(['"`])(.+?)\1/)
    if (testMatch?.[2]) {
      tests.push({ name: testMatch[2], line: lineNumber })
      locations.test_count.push(lineNumber)
    }

    const suiteMatch = line.match(/\b(?:describe|context)(?:\.(?:only|skip))?\s*\(\s*(['"`])(.+?)\1/)
    if (suiteMatch?.[2]) {
      suites.push({ name: suiteMatch[2], line: lineNumber })
      locations.suite_count.push(lineNumber)
    }

    if (/\bas\s+any\b/.test(line)) locations.any_cast_lines.push(lineNumber)
    for (let count = matchesOnLine(line, /\bforce\s*:\s*true\b/g); count > 0; count -= 1) {
      locations.forced_interactions.push(lineNumber)
    }
    for (let count = matchesOnLine(line, /\bbeforeEach\s*\(/g); count > 0; count -= 1) {
      locations.before_each_hooks.push(lineNumber)
    }
    for (let count = matchesOnLine(line, /\bafterEach\s*\(/g); count > 0; count -= 1) {
      locations.after_each_hooks.push(lineNumber)
    }
    for (let count = matchesOnLine(line, /\bcy\.wait\(\s*\d[\d_]*\s*\)/g); count > 0; count -= 1) {
      locations.fixed_waits.push(lineNumber)
    }
    if (/\b(?:describe|context|it|test|specify)\.skip\s*\(/.test(line)) locations.skipped_tests.push(lineNumber)
    if (/\b(?:describe|context|it|test|specify)\.only\s*\(/.test(line)) locations.focused_tests.push(lineNumber)
    for (let count = matchesOnLine(line, /\bif\s*\(/g); count > 0; count -= 1) {
      locations.conditional_blocks.push(lineNumber)
    }
    if (/\bif\s*\([^)]*(?:\.length|\?\.|!==?\s*(?:null|undefined))/.test(line)) {
      const nearbyBody = lines.slice(index, Math.min(lines.length, index + 18)).join('\n')
      if (/\.(?:should|and)\s*\(|\bexpect\s*\(|\bassert\./.test(nearbyBody)) {
        locations.silent_conditional_assertion_blocks.push(lineNumber)
      }
    }
    if (/\.\_[A-Za-z][\w$]*/.test(line)) locations.private_member_access_lines.push(lineNumber)
    if (/\b(?:Cypress|cy)\.on\(\s*['"]uncaught:exception['"]/.test(line)) {
      locations.broad_exception_handlers.push(lineNumber)
    }
    for (let count = matchesOnLine(line, /\bcy\.get\(\s*['"](?:input|label|button|textarea|select|\.[A-Za-z][\w-]*)['"]\s*\)/g); count > 0; count -= 1) {
      locations.generic_selector_calls.push(lineNumber)
    }
  })

  for (const name of Object.keys(locations) as AuditMetricName[]) {
    if (name === 'forced_interactions' || name === 'generic_selector_calls') continue
    locations[name] = unique(locations[name])
  }
  locations.line_count = lines.length > 0 ? [1, lines.length] : []

  const metrics: AuditMetrics = {
    line_count: lines.length,
    suite_count: suites.length,
    test_count: tests.length,
    any_cast_lines: locations.any_cast_lines.length,
    forced_interactions: locations.forced_interactions.length,
    before_each_hooks: locations.before_each_hooks.length,
    after_each_hooks: locations.after_each_hooks.length,
    fixed_waits: locations.fixed_waits.length,
    skipped_tests: locations.skipped_tests.length,
    focused_tests: locations.focused_tests.length,
    conditional_blocks: locations.conditional_blocks.length,
    silent_conditional_assertion_blocks: locations.silent_conditional_assertion_blocks.length,
    private_member_access_lines: locations.private_member_access_lines.length,
    broad_exception_handlers: locations.broad_exception_handlers.length,
    generic_selector_calls: locations.generic_selector_calls.length,
  }

  return { metrics, metric_locations: locations, tests, suites }
}

export interface SourceChunk {
  id: string
  start_line: number
  end_line: number
  content: string
  kind: 'semantic' | 'line_fallback'
  scope: string[]
  shared_context: string
}

function numberedLines(lines: string[], start: number, end: number): string {
  return lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join('\n')
}

function calledTestFunction(statement: ts.Statement): { kind: 'suite' | 'test'; name: string } | null {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null
  let expression: ts.Expression = statement.expression.expression
  if (ts.isPropertyAccessExpression(expression) && (expression.name.text === 'only' || expression.name.text === 'skip')) {
    expression = expression.expression
  }
  if (!ts.isIdentifier(expression)) return null
  const kind = expression.text === 'describe' || expression.text === 'context'
    ? 'suite'
    : expression.text === 'it' || expression.text === 'test' || expression.text === 'specify'
      ? 'test'
      : null
  if (!kind) return null
  const firstArgument = statement.expression.arguments[0]
  const name = firstArgument && (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument))
    ? firstArgument.text
    : `${kind} at top level`
  return { kind, name }
}

function suiteBody(statement: ts.Statement): ts.Block | null {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null
  for (const argument of statement.expression.arguments) {
    if ((ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && ts.isBlock(argument.body)) return argument.body
  }
  return null
}

function lineFallbackChunks(
  lines: string[],
  maxLines: number,
  overlapLines: number,
  rangeStart = 0,
  rangeEnd = lines.length,
  scope: string[] = [],
  sharedContext = '',
): SourceChunk[] {
  const chunks: SourceChunk[] = []
  const step = maxLines - overlapLines
  for (let start = rangeStart; start < rangeEnd; start += step) {
    const end = Math.min(rangeEnd, start + maxLines)
    chunks.push({
      id: `lines-${start + 1}-${end}`,
      start_line: start + 1,
      end_line: end,
      content: numberedLines(lines, start, end),
      kind: 'line_fallback',
      scope,
      shared_context: sharedContext,
    })
    if (end === rangeEnd) break
  }
  return chunks
}

export function chunkSource(content: string, maxLines = 700, overlapLines = 30): SourceChunk[] {
  const lines = content.split('\n')
  if (maxLines < 100) throw new Error('Audit chunks must contain at least 100 lines')
  if (overlapLines < 0 || overlapLines >= maxLines) throw new Error('Audit chunk overlap must be smaller than the chunk size')

  const source = ts.createSourceFile('reviewed-test.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  type SemanticUnit = { statement: ts.Statement; start: number; end: number; scope: string }
  const unitsFromStatements = (statements: ts.NodeArray<ts.Statement>): SemanticUnit[] => statements
    .map(statement => ({ statement, call: calledTestFunction(statement) }))
    .filter((entry): entry is { statement: ts.Statement; call: { kind: 'suite' | 'test'; name: string } } => entry.call !== null)
    .map(entry => {
      const start = source.getLineAndCharacterOfPosition(entry.statement.getStart(source)).line
      const end = source.getLineAndCharacterOfPosition(entry.statement.getEnd()).line + 1
      return { statement: entry.statement, start, end, scope: `${entry.call.kind}: ${entry.call.name}` }
    })
  const semanticStatements = unitsFromStatements(source.statements)

  if (semanticStatements.length === 0) return lineFallbackChunks(lines, maxLines, overlapLines)

  const semanticNodes = new Set(source.statements.filter(statement => calledTestFunction(statement) !== null))
  const sharedParts = source.statements
    .filter(statement => !semanticNodes.has(statement))
    .map(statement => {
      const start = source.getLineAndCharacterOfPosition(statement.getStart(source)).line
      const end = source.getLineAndCharacterOfPosition(statement.getEnd()).line + 1
      return numberedLines(lines, start, end)
    })
  const sharedContext = sharedParts.join('\n\n').slice(0, 24_000)

  const chunks: SourceChunk[] = []
  let group: SemanticUnit[] = []
  let activeSharedContext = sharedContext
  let parentScopes: string[] = []
  const flush = (): void => {
    if (group.length === 0) return
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) return
    chunks.push({
      id: `semantic-${first.start + 1}-${last.end}`,
      start_line: first.start + 1,
      end_line: last.end,
      content: numberedLines(lines, first.start, last.end),
      kind: 'semantic',
      scope: [...parentScopes, ...group.map(unit => unit.scope)],
      shared_context: activeSharedContext,
    })
    group = []
  }

  for (const unit of semanticStatements) {
    if (unit.end - unit.start > maxLines) {
      flush()
      const body = suiteBody(unit.statement)
      const nestedUnits = body ? unitsFromStatements(body.statements) : []
      if (body && nestedUnits.length > 0) {
        const nestedNodes = new Set(nestedUnits.map(nested => nested.statement))
        const outerShared = body.statements
          .filter(statement => !nestedNodes.has(statement))
          .map(statement => {
            const start = source.getLineAndCharacterOfPosition(statement.getStart(source)).line
            const end = source.getLineAndCharacterOfPosition(statement.getEnd()).line + 1
            return numberedLines(lines, start, end)
          })
          .join('\n\n')
        const header = `${unit.start + 1}: ${lines[unit.start] ?? ''}`
        activeSharedContext = [sharedContext, header, outerShared].filter(Boolean).join('\n\n').slice(0, 30_000)
        parentScopes = [unit.scope]
        for (const nested of nestedUnits) {
          if (nested.end - nested.start > maxLines) {
            flush()
            chunks.push(...lineFallbackChunks(
              lines,
              maxLines,
              overlapLines,
              nested.start,
              nested.end,
              [unit.scope, nested.scope],
              activeSharedContext,
            ))
            continue
          }
          const projectedStart = group[0]?.start ?? nested.start
          if (group.length > 0 && nested.end - projectedStart > maxLines) flush()
          group.push(nested)
        }
        flush()
        activeSharedContext = sharedContext
        parentScopes = []
      } else {
        chunks.push(...lineFallbackChunks(lines, maxLines, overlapLines, unit.start, unit.end, [unit.scope], sharedContext))
      }
      continue
    }
    const projectedStart = group[0]?.start ?? unit.start
    if (group.length > 0 && unit.end - projectedStart > maxLines) flush()
    group.push(unit)
  }
  flush()
  return chunks
}
