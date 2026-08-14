import {
  auditSynthesisJsonSchema,
  chunkAuditJsonSchema,
  coverageAuditJsonSchema,
  globalAuditMapJsonSchema,
  type ChunkAuditResult,
  type CoverageAuditResult,
  type GlobalAuditMapResult,
} from './auditSchema.js'
import type { SourceChunk } from './auditInventory.js'
import type { AuditInventory, Finding, ReviewContext, TestType } from './types.js'
import { buildFindingEvidence, officialReferencesForSections, relevantStandardsSections, type StandardsGuidance } from './standardsGuidance.js'
import { findingKey, recommendationBatchJsonSchema } from './recommendationSchema.js'
import { contextManifest } from './targetedSourceRetrieval.js'

export const chunkAuditInstructions = `You are the test-quality evidence analyst in the Levelbuild Cypress audit workflow.

Your job is to inspect one numbered portion of a complete Cypress test against the supplied internal standards.

Rules:
- Perform a systematic review, not a minimal CI scan. Record both strengths and concerns.
- Consider observable behavior, assertion strength, test-name accuracy, private implementation coupling, duplicated production logic, synchronization, selectors, forced actions, conditional assertions, stubbing, cleanup, isolation, and test-level placement.
- Treat deterministic metrics and findings as leads, never as the scope of the review.
- Every evidence line must be a real global line number shown in the numbered chunk.
- Distinguish a legitimate browser/integration boundary stub from avoidable white-box testing.
- Cite the relevant heading or principle from the supplied standards when possible.
- Do not claim missing feature coverage in this pass; source behavior is cross-checked separately.
- Return at most 5 distinct strengths and 12 distinct concerns for this chunk. Consolidate repeated examples.
- Do not invent selectors, events, endpoints, methods, or expected behavior.
- Return JSON matching the supplied schema and nothing else.`

export const globalAuditMapInstructions = `You are the global test-structure analyst in the Levelbuild Cypress audit workflow.

Read the complete numbered Cypress test and build a concise map that later semantic reviewers can use.

Rules:
- Identify suites, their purpose, and the important behaviors they attempt to cover.
- Identify imports, helpers, hooks, mounting/setup conventions, and shared infrastructure that affect multiple suites.
- Identify cross-suite strengths, repetition, coupling, assertion, synchronization, and isolation patterns.
- This is an orientation map, not the final audit. Keep it compact and evidence-backed.
- Use only real global line numbers from the supplied file.
- Use the supplied internal standards as the quality frame.
- Return JSON matching the supplied schema and nothing else.`

export const coverageAuditInstructions = `You are the behavior-and-coverage analyst in the Levelbuild Cypress audit workflow.

Compare the supplied production/source context with the inventory and evidence already extracted from the Cypress test.

Rules:
- Identify important production behaviors that are clearly covered, weakly covered, or potentially absent.
- A coverage gap must cite source evidence and explain what test evidence was searched or found.
- Mark incomplete evidence as a limitation. Never turn uncertainty into a definite missing-test claim.
- Identify pure helper or implementation-detail tests that would be clearer and faster at another test level.
- Use the actual names and paths in the supplied context. Do not invent APIs, selectors, events, or behavior.
- Coverage gaps are advisory and may only use low or info severity.
- Return at most 20 covered behaviors, 15 coverage gaps, and 10 placement issues. Consolidate related behavior.
- Return JSON matching the supplied schema and nothing else.`

export const synthesisAuditInstructions = `You are the lead reviewer completing a comprehensive Levelbuild Cypress test audit.

Synthesize the deterministic inventory, standards-based chunk reviews, source coverage review, and deterministic findings into one evidence-backed report comparable to a careful senior-engineer review.

Rules:
- Explain the suite's overall quality and functional ambition, including both what is done well and what should improve.
- Consolidate repeated observations into suite-level findings while preserving representative and related line locations.
- Cover reliability, maintainability, observable behavior, assertion strength, standards alignment, coverage, and appropriate test level where evidence supports them.
- Do not prefer an artificially small finding set. Do prefer supported, distinct findings over repetition or speculation.
- Deterministic findings are seeds, not the scope. Include them and independently synthesize all other evidence.
- Use deterministic metrics exactly as supplied; do not recalculate or alter them.
- Keep positive practices in strengths, violations/design problems in findings, missing behavior in coverage_gaps, and unit/component/E2E placement in test_placement_issues.
- Findings must use real 1-based test-file lines. Use related_locations for recurring examples.
- replacement_code must be null unless exact code is fully supported by supplied evidence.
- Standards assessment should cover each materially relevant standards area; use not_assessed when evidence is insufficient.
- Priorities must be ordered by engineering value and reference finding rule IDs where applicable.
- Return at most 12 strengths, 30 consolidated findings, 20 coverage gaps, 15 placement issues, and 12 priorities.
- State important context limitations instead of hiding them.
- Treat the supplied context manifest as authoritative. A truncated source was available in part; never describe it as unavailable or missing.
- Return JSON matching the supplied schema and nothing else.`

export const synthesisRepairInstructions = `You repair a nearly valid Levelbuild Cypress audit JSON object.

Preserve all supported analysis and evidence. Change only what is required to satisfy the supplied validation error and schema. Do not add new findings, selectors, endpoints, events, or application behavior. Return the complete repaired JSON object and nothing else.`

export const coverageRepairInstructions = `You repair a malformed or nearly valid Levelbuild Cypress source-and-coverage JSON object.

Preserve all supported covered behaviors, coverage gaps, placement issues, evidence, context, and limitations. Correct only JSON syntax and the supplied validation error. Do not add new behavior, selectors, endpoints, findings, or source claims. Return one complete JSON object matching the supplied schema and nothing else.`

export const recommendationEnrichmentInstructions = `You are the recommendation engineer for a completed Levelbuild Cypress audit.

For every supplied finding, produce a concrete recommendation grounded in the exact repository evidence and internal standards.

Rules:
- Do not rediscover, remove, combine, reprioritize, or change the finding. Improve only its recommendation.
- Explain what code should change and why that change proves the intended behavior.
- Include an exact TypeScript/Cypress replacement when the supplied evidence proves every selector, alias, endpoint, method, value, and expectation.
- Do not force a snippet merely to fill the field. Prose-only is the responsible result for architectural concerns, multiple valid designs, or missing behavioral contracts.
- Use code_kind "exact" only when every repository-specific literal and behavior appears in the supplied evidence. Never invent a selector, alias, endpoint, fixture, event, method, expected value, or component state.
- Use code_kind "illustrative" only when a useful Cypress pattern can be shown but adaptation is genuinely required; list each required assumption.
- Use code_kind "unavailable" with replacement_code null only when a responsible snippet cannot be produced from the supplied context; state the missing context in assumptions.
- Internal standards are the primary policy. Cite only exact supplied section headings.
- Official Cypress documentation is supporting authority. Cite only URLs in the supplied allowlist and only when the page directly supports this recommendation. Do not claim Cypress recommends a project-specific design.
- Prefer retryable rendered assertions, request aliases, observable event details, and public behavior where those match the evidence.
- A deterministic stub or fixture value may be introduced when the replacement defines it and asserts the same value. Repository-sensitive selectors, endpoints, events, and component behavior must still come from supplied evidence.
- Return exactly one recommendation for every requested finding_key, in the same order.
- Return JSON matching the supplied schema and nothing else.`

export const recommendationRepairInstructions = `You repair a nearly valid batch of Levelbuild Cypress recommendation JSON.

Preserve every finding_key and every supported recommendation. Correct only the supplied validation error. Keep repository-specific code grounded in the object you received; do not introduce new selectors, aliases, endpoints, fixtures, events, methods, expected values, or component behavior. Cite only standard headings and official URLs already present in the invalid object. Return the complete repaired JSON object and nothing else.`

export const globalMapRepairInstructions = `You repair a nearly valid Levelbuild Cypress global-map JSON object.

Preserve every supported suite and observation. Change only what is required to satisfy the supplied validation error and schema. Evidence lines must be positive integer arrays containing real test-file line numbers. Do not repeat the source analysis or add new observations. Return the complete repaired JSON object and nothing else.`

function section(name: string, content: string): string {
  return `<${name}>\n${content}\n</${name}>`
}

function retry(input: string): string {
  return `${input}\n\nThe previous response was invalid or truncated. Return one complete JSON object matching the schema exactly. Do not use Markdown fences.`
}

function relatedContext(context: ReviewContext): string {
  if (context.related_files.length === 0) return 'No related source context was collected.'
  return context.related_files.map(file => [
    `FILE: ${file.path}`,
    `REASON: ${file.reason}`,
    `TRUNCATED: ${file.truncated}`,
    file.content,
  ].join('\n')).join('\n\n--- RELATED FILE ---\n\n')
}

function targetedSourceContext(context: ReviewContext): string {
  if (!context.targeted_source_excerpts?.length) return 'No additional full-source excerpts were selected.'
  return context.targeted_source_excerpts.map(excerpt => [
    `FILE: ${excerpt.path}`,
    `SYMBOL: ${excerpt.symbol}`,
    `LINES: ${excerpt.start_line}-${excerpt.end_line}`,
    excerpt.content,
  ].join('\n')).join('\n\n--- TARGETED SOURCE EXCERPT ---\n\n')
}

function numberedContent(content: string): string {
  return content.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')
}

export function buildGlobalAuditMapInput(options: {
  testType: TestType
  standards: string
  context: ReviewContext
  inventory: AuditInventory
  isRetry?: boolean
}): string {
  const input = [
    `File: ${options.context.test_file.path}`,
    `Test type: ${options.testType}`,
    section('standards', options.standards),
    section('deterministic_inventory', JSON.stringify(options.inventory, null, 2)),
    section('complete_numbered_test_file', numberedContent(options.context.test_file.content)),
    section('required_json_schema', JSON.stringify(globalAuditMapJsonSchema, null, 2)),
  ].join('\n\n')
  return options.isRetry ? retry(input) : input
}

export function buildGlobalAuditMapRepairInput(
  invalidValue: unknown,
  validationError: string,
): string {
  return [
    `Validation error: ${validationError}`,
    section('invalid_global_map_json', JSON.stringify(invalidValue, null, 2)),
    section('required_json_schema', JSON.stringify(globalAuditMapJsonSchema, null, 2)),
  ].join('\n\n')
}

export function buildChunkAuditInput(options: {
  testType: TestType
  standards: string
  context: ReviewContext
  inventory: AuditInventory
  deterministicFindings: Finding[]
  chunk: SourceChunk
  globalMap: GlobalAuditMapResult
  isRetry?: boolean
}): string {
  const withinChunk = (line: number): boolean => line >= options.chunk.start_line && line <= options.chunk.end_line
  const chunkInventory = {
    global_metrics: options.inventory.metrics,
    metric_locations_in_this_chunk: Object.fromEntries(
      Object.entries(options.inventory.metric_locations)
        .map(([name, lines]) => [name, lines.filter(withinChunk)])
        .filter(([, lines]) => (lines as number[]).length > 0),
    ),
    tests_in_this_chunk: options.inventory.tests.filter(test => withinChunk(test.line)),
    suites_in_this_chunk: options.inventory.suites.filter(suite => withinChunk(suite.line)),
  }
  const chunkDeterministicFindings = options.deterministicFindings.filter(finding => withinChunk(finding.line))
  const input = [
    `File: ${options.context.test_file.path}`,
    `Test type: ${options.testType}`,
    `Chunk: ${options.chunk.id} (${options.chunk.start_line}-${options.chunk.end_line})`,
    `Chunk kind: ${options.chunk.kind}`,
    section('semantic_scope', JSON.stringify(options.chunk.scope, null, 2)),
    section('standards', options.standards),
    section('global_test_map', JSON.stringify(options.globalMap, null, 2)),
    section('shared_imports_helpers_and_setup', options.chunk.shared_context || 'No separate shared context was detected.'),
    section('deterministic_inventory', JSON.stringify(chunkInventory, null, 2)),
    section('deterministic_findings_in_this_chunk', JSON.stringify(chunkDeterministicFindings, null, 2)),
    section('numbered_test_chunk', options.chunk.content),
    section('required_json_schema', JSON.stringify(chunkAuditJsonSchema, null, 2)),
  ].join('\n\n')
  return options.isRetry ? retry(input) : input
}

export function buildCoverageAuditInput(options: {
  testType: TestType
  standards: string
  context: ReviewContext
  inventory: AuditInventory
  globalMap: GlobalAuditMapResult
  chunkResults: ChunkAuditResult[]
  isRetry?: boolean
}): string {
  const testIndex = options.inventory.tests.map(test => `${test.line}: ${test.name}`).join('\n') || 'No named tests detected.'
  const input = [
    `File: ${options.context.test_file.path}`,
    `Test type: ${options.testType}`,
    section('standards', options.standards),
    section('test_inventory', testIndex),
    section('deterministic_metrics', JSON.stringify(options.inventory.metrics, null, 2)),
    section('global_test_map', JSON.stringify(options.globalMap, null, 2)),
    section('test_review_evidence', JSON.stringify(options.chunkResults, null, 2)),
    section('production_and_related_context', relatedContext(options.context)),
    section('authoritative_context_manifest', JSON.stringify(contextManifest(options.context), null, 2)),
    section('targeted_full_source_excerpts', targetedSourceContext(options.context)),
    section('required_json_schema', JSON.stringify(coverageAuditJsonSchema, null, 2)),
  ].join('\n\n')
  return options.isRetry ? retry(input) : input
}

export function buildAuditSynthesisInput(options: {
  testType: TestType
  standards: string
  context: ReviewContext
  inventory: AuditInventory
  deterministicFindings: Finding[]
  globalMap: GlobalAuditMapResult
  chunkResults: ChunkAuditResult[]
  coverageResult: CoverageAuditResult
  evidenceExcerpts: string
  isRetry?: boolean
}): string {
  const input = [
    `File: ${options.context.test_file.path}`,
    `Test type: ${options.testType}`,
    section('standards', options.standards),
    section('deterministic_inventory', JSON.stringify(options.inventory, null, 2)),
    section('deterministic_findings', JSON.stringify(options.deterministicFindings, null, 2)),
    section('global_test_map', JSON.stringify(options.globalMap, null, 2)),
    section('standards_chunk_reviews', JSON.stringify(options.chunkResults, null, 2)),
    section('source_coverage_review', JSON.stringify(options.coverageResult, null, 2)),
    section('raw_test_evidence_excerpts', options.evidenceExcerpts || 'No excerpts were selected.'),
    section('authoritative_context_manifest', JSON.stringify(contextManifest(options.context), null, 2)),
    section('targeted_full_source_excerpts', targetedSourceContext(options.context)),
    section('required_json_schema', JSON.stringify(auditSynthesisJsonSchema, null, 2)),
  ].join('\n\n')
  return options.isRetry ? retry(input) : input
}

export function buildAuditSynthesisRepairInput(
  invalidValue: unknown,
  validationError: string,
): string {
  return [
    `Validation error: ${validationError}`,
    section('invalid_audit_json', JSON.stringify(invalidValue, null, 2)),
    section('required_json_schema', JSON.stringify(auditSynthesisJsonSchema, null, 2)),
  ].join('\n\n')
}

export function buildCoverageRepairInput(invalidValue: unknown, validationError: string): string {
  return [
    `Validation or JSON error: ${validationError}`,
    section('invalid_coverage_output', typeof invalidValue === 'object' && invalidValue !== null && 'malformed_json' in invalidValue
      ? String((invalidValue as { malformed_json: unknown }).malformed_json)
      : JSON.stringify(invalidValue, null, 2)),
    section('required_json_schema', JSON.stringify(coverageAuditJsonSchema, null, 2)),
  ].join('\n\n')
}

export function buildRecommendationEnrichmentInput(options: {
  findings: Finding[]
  context: ReviewContext
  guidance: StandardsGuidance
  isRetry?: boolean
}): string {
  const sections = relevantStandardsSections(options.guidance, options.findings)
  const officialReferences = officialReferencesForSections(options.guidance, sections)
  const input = [
    section('findings_to_enrich', JSON.stringify(options.findings.map(finding => ({
      finding_key: findingKey(finding),
      title: finding.title,
      message: finding.message,
      impact: finding.impact ?? '',
      current_recommendation: finding.suggestion,
      current_replacement_code: finding.replacement_code,
      cypress_methods: finding.specific_cypress_methods,
      standards_references: finding.standards_references ?? [],
    })), null, 2)),
    section('repository_evidence', options.findings.map(finding => buildFindingEvidence(finding, options.context)).join('\n\n--- NEXT FINDING ---\n\n')),
    section('applicable_internal_standard_sections', sections.map(item => `## ${item.heading}\n\n${item.content}`).join('\n\n--- STANDARD SECTION ---\n\n')),
    section('allowed_internal_standard_headings', JSON.stringify(sections.map(item => item.heading), null, 2)),
    section('allowlisted_official_cypress_references', JSON.stringify(officialReferences, null, 2)),
    section('required_json_schema', JSON.stringify(recommendationBatchJsonSchema, null, 2)),
  ].join('\n\n')
  return options.isRetry ? retry(input) : input
}

export function buildRecommendationRepairInput(invalidValue: unknown, validationError: string): string {
  return [
    `Validation error: ${validationError}`,
    section('invalid_recommendation_json', JSON.stringify(invalidValue, null, 2)),
    section('required_json_schema', JSON.stringify(recommendationBatchJsonSchema, null, 2)),
  ].join('\n\n')
}

export function buildEvidenceExcerpts(
  content: string,
  chunkResults: ChunkAuditResult[],
  deterministicFindings: Finding[],
  maximumCharacters = 36_000,
): string {
  const lines = content.split('\n')
  const evidenceLines = new Set<number>()
  for (const finding of deterministicFindings) evidenceLines.add(finding.line)
  for (const result of chunkResults) {
    for (const strength of result.strengths) strength.evidence_lines.forEach(line => evidenceLines.add(line))
    for (const concern of result.concerns) {
      evidenceLines.add(concern.line)
      evidenceLines.add(concern.end_line)
    }
  }
  const expanded = new Set<number>()
  for (const line of evidenceLines) {
    for (let nearby = Math.max(1, line - 2); nearby <= Math.min(lines.length, line + 2); nearby += 1) expanded.add(nearby)
  }
  return [...expanded]
    .sort((left, right) => left - right)
    .map(line => `${line}: ${lines[line - 1] ?? ''}`)
    .join('\n')
    .slice(0, maximumCharacters)
}
