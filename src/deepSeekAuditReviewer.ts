import { buildAuditInventory, chunkSource, splitSourceChunk, type SourceChunk } from './auditInventory.js'
import { AUDIT_PIPELINE_REVISION, AuditCheckpointStore, auditCheckpointKey } from './auditCheckpoint.js'
import {
  buildAuditSynthesisRepairInput,
  buildAuditSynthesisInput,
  buildChunkAuditInput,
  buildCoverageAuditInput,
  buildEvidenceExcerpts,
  buildGlobalAuditMapInput,
  buildGlobalAuditMapRepairInput,
  chunkAuditInstructions,
  coverageAuditInstructions,
  globalAuditMapInstructions,
  globalMapRepairInstructions,
  synthesisAuditInstructions,
  synthesisRepairInstructions,
} from './auditPromptBuilder.js'
import {
  auditSynthesisJsonSchema,
  chunkAuditJsonSchema,
  coverageAuditJsonSchema,
  globalAuditMapJsonSchema,
  validateAuditSynthesis,
  validateChunkAudit,
  validateCoverageAudit,
  validateGlobalAuditMap,
  type AuditSynthesisResult,
  type ChunkAuditResult,
  type CoverageAuditResult,
  type GlobalAuditMapResult,
} from './auditSchema.js'
import { AiApiError, AiJsonClient, AiTransportError } from './aiJsonClient.js'
import { DeepSeekJsonClient, type DeepSeekClientOptions } from './deepSeekClient.js'
import { QualityReviewerError, errorMessage } from './errors.js'
import type { AuditDetails, Finding, ReviewContext, TestType } from './types.js'

export interface DeepSeekAuditReviewerOptions extends DeepSeekClientOptions {
  chunkLines?: number
  chunkConcurrency?: number
  checkpointDirectory?: string | null
}

export interface AiAuditReviewerOptions {
  client: AiJsonClient
  chunkLines?: number
  chunkConcurrency?: number
  checkpointDirectory?: string | null
  onProgress?: (message: string) => void
}

export interface AuditReviewResult {
  summary: string
  findings: Finding[]
  audit: AuditDetails
  incomplete_error?: string
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let firstFailure: unknown
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && firstFailure === undefined) {
      const index = next
      next += 1
      const item = items[index]
      if (item !== undefined) {
        try {
          results[index] = await worker(item)
        } catch (error) {
          if (firstFailure === undefined) firstFailure = error
        }
      }
    }
  })
  await Promise.all(runners)
  if (firstFailure !== undefined) throw firstFailure
  return results
}

function validateTestLines(result: AuditSynthesisResult, lineCount: number): AuditSynthesisResult {
  const valid = (line: number): boolean => line >= 1 && line <= lineCount
  for (const strength of result.strengths) {
    if (!strength.evidence_lines.every(valid)) throw new QualityReviewerError(`Audit strength has a line outside 1-${lineCount}`)
  }
  for (const finding of result.findings) {
    if (!valid(finding.line) || !valid(finding.end_line ?? finding.line) || !(finding.related_locations ?? []).every(valid)) {
      throw new QualityReviewerError(`Audit finding ${finding.rule} has a line outside 1-${lineCount}`)
    }
  }
  for (const issue of result.test_placement_issues) {
    if (!valid(issue.line)) throw new QualityReviewerError(`Audit placement issue has a line outside 1-${lineCount}`)
  }
  return result
}

function combineChunkResults(parent: SourceChunk, results: ChunkAuditResult[]): ChunkAuditResult {
  const strengths = new Map<string, ChunkAuditResult['strengths'][number]>()
  const concerns = new Map<string, ChunkAuditResult['concerns'][number]>()
  for (const result of results) {
    for (const strength of result.strengths) {
      strengths.set(`${strength.title}:${strength.evidence_lines.join(',')}`, strength)
    }
    for (const concern of result.concerns) {
      concerns.set(`${concern.title}:${concern.line}:${concern.end_line}`, concern)
    }
  }
  return {
    chunk_id: parent.id,
    summary: `Recovered ${parent.id} through ${results.length} smaller evidence review(s): ${results.map(result => result.summary).join(' ')}`,
    strengths: [...strengths.values()].slice(0, 5),
    concerns: [...concerns.values()].slice(0, 12),
    context_used: [...new Set(results.flatMap(result => result.context_used))],
  }
}

function partialFindings(chunkResults: ChunkAuditResult[]): Finding[] {
  return chunkResults.flatMap(result => result.concerns.map((concern, index): Finding => ({
    line: concern.line,
    end_line: concern.end_line,
    severity: 'info',
    rule: `AUDIT-PARTIAL-${concern.line}-${index + 1}`,
    category: 'quality',
    title: concern.title,
    message: concern.description,
    suggestion: concern.recommendation,
    replacement_code: null,
    specific_cypress_methods: [],
    context_used: [`partial audit evidence from ${result.chunk_id}`],
    confidence: concern.confidence,
    source: 'ai',
    standards_references: concern.standards_references,
    impact: concern.impact,
  })))
}

function deterministicGlobalMap(
  context: ReviewContext,
  inventory: ReturnType<typeof buildAuditInventory>,
): GlobalAuditMapResult {
  const mappedSuites = inventory.suites.slice(0, 60)
  const suites = mappedSuites.map((suite, index) => {
    const nextLine = inventory.suites[index + 1]?.line ?? inventory.metrics.line_count + 1
    const endLine = Math.max(suite.line, nextLine - 1)
    return {
      name: suite.name,
      start_line: suite.line,
      end_line: Math.min(endLine, inventory.metrics.line_count),
      purpose: 'Deterministically identified suite; purpose will be assessed by the chunk reviewer.',
      key_behaviors: inventory.tests
        .filter(test => test.line >= suite.line && test.line <= endLine)
        .slice(0, 12)
        .map(test => test.name),
    }
  })
  const infrastructureLines = [
    ...inventory.metric_locations.before_each_hooks,
    ...inventory.metric_locations.after_each_hooks,
  ].sort((left, right) => left - right)
  return {
    summary: `Deterministic fallback map for ${inventory.metrics.suite_count} suite(s) and ${inventory.metrics.test_count} test(s).`,
    suites,
    shared_infrastructure: infrastructureLines.length > 0 ? [{
      name: 'Shared Cypress hooks',
      evidence_lines: [...new Set(infrastructureLines)],
      purpose: 'Hook locations identified from the test syntax; their behavior remains for chunk review.',
    }] : [],
    cross_suite_patterns: [],
    context_used: [context.test_file.path, 'deterministic audit inventory'],
    limitations: [
      'The AI global-map pass was unavailable, so suite boundaries and test names came from deterministic syntax inventory.',
      'Cross-suite interpretation was intentionally deferred to evidence chunks and final synthesis.',
    ],
  }
}

export class AiAuditReviewer {
  private readonly client: AiJsonClient
  private readonly chunkLines: number
  private readonly chunkConcurrency: number
  private readonly onProgress: (message: string) => void
  private readonly checkpointStore: AuditCheckpointStore
  private lastTraceStart = 0

  constructor(options: AiAuditReviewerOptions) {
    this.client = options.client
    this.chunkLines = options.chunkLines ?? 700
    this.chunkConcurrency = options.chunkConcurrency ?? 2
    this.onProgress = options.onProgress ?? (() => {})
    this.checkpointStore = new AuditCheckpointStore(options.checkpointDirectory)
    if (!Number.isInteger(this.chunkConcurrency) || this.chunkConcurrency < 1 || this.chunkConcurrency > 4) {
      throw new QualityReviewerError('Audit chunk concurrency must be between 1 and 4')
    }
  }

  async audit(
    testType: TestType,
    standards: string,
    context: ReviewContext,
    deterministicFindings: Finding[],
  ): Promise<AuditReviewResult> {
    const requestsAtStart = this.client.requestsMade
    const tracesAtStart = this.client.traces.length
    this.lastTraceStart = tracesAtStart
    const inventory = buildAuditInventory(context.test_file.content)
    const chunks = chunkSource(context.test_file.content, this.chunkLines)
    const checkpointKey = auditCheckpointKey({
      testType,
      standards,
      context,
      model: this.client.requestedModel,
      provider: this.client.providerId,
      providerEndpoint: this.client.endpointIdentity,
      pipelineRevision: AUDIT_PIPELINE_REVISION,
      chunkLines: this.chunkLines,
    })
    const checkpoint = await this.checkpointStore.load(checkpointKey)
    const reusedPasses: string[] = []
    const adaptiveRecoveries: string[] = []
    const collectedChunkResults = new Map<string, ChunkAuditResult>()
    let globalMap: GlobalAuditMapResult | null = null
    let globalMapSource: 'ai' | 'checkpoint' | 'deterministic_fallback' | 'not_available' = 'not_available'
    let coverageResult: CoverageAuditResult | null = null
    checkpoint.adaptive_chunks ??= {}
    this.onProgress(
      `Inventory complete for ${context.test_file.path}: ${inventory.metrics.line_count} lines, ${inventory.metrics.test_count} tests, ${inventory.metrics.suite_count} suites, ${chunks.length} semantic audit chunks.`,
    )

    try {
      const validateGlobalMapLines = (result: GlobalAuditMapResult): GlobalAuditMapResult => {
      const valid = (line: number): boolean => line >= 1 && line <= inventory.metrics.line_count
      if (!result.suites.every(suite => valid(suite.start_line) && valid(suite.end_line))) {
        throw new QualityReviewerError('Global audit map contains a suite line outside the test file')
      }
      if (!result.shared_infrastructure.every(item => item.evidence_lines.every(valid)) ||
          !result.cross_suite_patterns.every(item => item.evidence_lines.every(valid))) {
        throw new QualityReviewerError('Global audit map contains evidence outside the test file')
      }
      return result
    }

    if (checkpoint.global_map && checkpoint.global_map_source !== 'deterministic_fallback') {
      globalMap = validateGlobalMapLines(validateGlobalAuditMap(checkpoint.global_map))
      globalMapSource = 'checkpoint'
      reusedPasses.push('global full-file map')
      this.onProgress('Reusing checkpointed global full-file map.')
    } else {
      try {
        globalMap = await this.client.requestJson({
          operation: 'audit global full-file map',
          system: globalAuditMapInstructions,
          input: buildGlobalAuditMapInput({ testType, standards, context, inventory }),
          retryInput: buildGlobalAuditMapInput({ testType, standards, context, inventory, isRetry: true }),
          validate: value => validateGlobalMapLines(validateGlobalAuditMap(value)),
          maxTokens: 20_000,
          maxRetryTokens: 40_000,
          reasoningEffort: 'high',
          retryThinking: 'disabled',
          jsonSchema: globalAuditMapJsonSchema,
          schemaName: 'audit_global_map',
          repair: {
            system: globalMapRepairInstructions,
            buildInput: buildGlobalAuditMapRepairInput,
            maxTokens: 20_000,
          },
        })
        globalMapSource = 'ai'
        if (checkpoint.global_map_source === 'deterministic_fallback') {
          checkpoint.chunks = {}
          checkpoint.adaptive_chunks = {}
          delete checkpoint.coverage
          this.onProgress('AI global map recovered; invalidated evidence checkpoints created with the deterministic fallback map.')
        }
        checkpoint.global_map = globalMap
        checkpoint.global_map_source = 'ai'
        await this.checkpointStore.save(checkpoint)
      } catch (error) {
        if (error instanceof AiApiError) throw error
        globalMap = deterministicGlobalMap(context, inventory)
        globalMapSource = 'deterministic_fallback'
        adaptiveRecoveries.push('global full-file map (deterministic fallback)')
        checkpoint.global_map = globalMap
        checkpoint.global_map_source = 'deterministic_fallback'
        await this.checkpointStore.save(checkpoint)
        this.onProgress(`Global AI map could not be completed: ${errorMessage(error)}`)
        this.onProgress('Continuing standards chunks with a deterministic suite/test map; the report will record this limitation.')
      }
    }
    if (!globalMap) throw new QualityReviewerError('Global audit map was not produced')
    const activeGlobalMap = globalMap

    const validateChunk = (chunk: SourceChunk, value: unknown): ChunkAuditResult => {
        const result = validateChunkAudit(value)
        if (result.chunk_id && result.chunk_id !== chunk.id) {
          this.onProgress(`Normalizing model chunk_id ${result.chunk_id} to orchestrator chunk_id ${chunk.id}.`)
        }
        const inChunk = (line: number): boolean => line >= chunk.start_line && line <= chunk.end_line
        for (const strength of result.strengths) {
          if (!strength.evidence_lines.every(inChunk)) throw new QualityReviewerError(`Strength evidence is outside ${chunk.id}`)
        }
        for (const concern of result.concerns) {
          if (!inChunk(concern.line) || !inChunk(concern.end_line)) throw new QualityReviewerError(`Concern evidence is outside ${chunk.id}`)
        }
        return { ...result, chunk_id: chunk.id }
    }

    const requestChunk = async (chunk: SourceChunk, recoveryMode: boolean): Promise<ChunkAuditResult> => this.client.requestJson({
      operation: `${recoveryMode ? 'adaptive ' : ''}audit standards chunk ${chunk.id}`,
      system: chunkAuditInstructions,
      input: buildChunkAuditInput({ testType, standards, context, inventory, deterministicFindings, chunk, globalMap: activeGlobalMap }),
      retryInput: buildChunkAuditInput({ testType, standards, context, inventory, deterministicFindings, chunk, globalMap: activeGlobalMap, isRetry: true }),
      validate: value => validateChunk(chunk, value),
      maxTokens: recoveryMode ? 10_000 : 20_000,
      maxRetryTokens: recoveryMode ? 20_000 : 40_000,
      reasoningEffort: 'high',
      thinking: recoveryMode ? 'disabled' : 'enabled',
      retryThinking: 'disabled',
      jsonSchema: chunkAuditJsonSchema,
      schemaName: 'audit_chunk',
    })

    const reviewChunk = async (chunk: SourceChunk, recoveryMode = false, depth = 0): Promise<ChunkAuditResult> => {
      const cached = checkpoint.chunks[chunk.id]
      if (cached) {
        const result = validateChunk(chunk, cached)
        collectedChunkResults.set(chunk.id, result)
        reusedPasses.push(`standards chunk ${chunk.id}`)
        this.onProgress(`Reusing checkpointed standards chunk ${chunk.id}.`)
        return result
      }

      const recoverFromChildren = async (children: SourceChunk[]): Promise<ChunkAuditResult> => {
        const childResults: ChunkAuditResult[] = []
        for (const child of children) {
          childResults.push(await reviewChunk(child, true, depth + 1))
        }
        const combined = combineChunkResults(chunk, childResults)
        checkpoint.chunks[chunk.id] = combined
        collectedChunkResults.set(chunk.id, combined)
        await this.checkpointStore.save(checkpoint)
        return combined
      }

      const savedChildren = checkpoint.adaptive_chunks?.[chunk.id]
      if (savedChildren?.length) {
        const children = splitSourceChunk(context.test_file.content, chunk)
        if (children.map(child => child.id).join('|') === savedChildren.join('|')) {
          adaptiveRecoveries.push(chunk.id)
          this.onProgress(`Resuming adaptive recovery for ${chunk.id} from ${children.length} smaller chunk(s).`)
          return recoverFromChildren(children)
        }
      }

      try {
        const result = await requestChunk(chunk, recoveryMode)
        checkpoint.chunks[chunk.id] = result
        collectedChunkResults.set(chunk.id, result)
        await this.checkpointStore.save(checkpoint)
        return result
      } catch (error) {
        if (!(error instanceof AiTransportError)) throw error

        const children = splitSourceChunk(context.test_file.content, chunk)
        if (children.length === 1 || depth >= 2) {
          if (!recoveryMode) {
            adaptiveRecoveries.push(`${chunk.id} (non-thinking fallback)`)
            this.onProgress(`Transport recovery for ${chunk.id}: retrying this small chunk with thinking disabled and a smaller output allowance.`)
            const result = await requestChunk(chunk, true)
            checkpoint.chunks[chunk.id] = result
            collectedChunkResults.set(chunk.id, result)
            await this.checkpointStore.save(checkpoint)
            return result
          }
          throw error
        }

        adaptiveRecoveries.push(chunk.id)
        checkpoint.adaptive_chunks![chunk.id] = children.map(child => child.id)
        await this.checkpointStore.save(checkpoint)
        this.onProgress(
          `Transport recovery for ${chunk.id}: splitting only this failed region into ${children.length} smaller chunk(s) and disabling thinking for their evidence pass.`,
        )
        return recoverFromChildren(children)
      }
    }

    const chunkResults = await mapConcurrent(chunks, this.chunkConcurrency, chunk => reviewChunk(chunk))

    const validateCoverage = (value: unknown): CoverageAuditResult => {
      const result = validateCoverageAudit(value)
      for (const issue of result.test_placement_issues) {
        if (issue.line > inventory.metrics.line_count) throw new QualityReviewerError('Coverage review returned an invalid test line')
      }
      return result
    }
    if (checkpoint.coverage) {
      coverageResult = validateCoverage(checkpoint.coverage)
      reusedPasses.push('source and coverage cross-check')
      this.onProgress('Reusing checkpointed source and coverage cross-check.')
    } else {
      coverageResult = await this.client.requestJson({
        operation: 'audit source and coverage cross-check',
        system: coverageAuditInstructions,
        input: buildCoverageAuditInput({ testType, standards, context, inventory, globalMap, chunkResults }),
        retryInput: buildCoverageAuditInput({ testType, standards, context, inventory, globalMap, chunkResults, isRetry: true }),
        validate: validateCoverage,
        maxTokens: 20_000,
        maxRetryTokens: 40_000,
        reasoningEffort: 'high',
        retryThinking: 'disabled',
        jsonSchema: coverageAuditJsonSchema,
        schemaName: 'audit_coverage',
      })
      checkpoint.coverage = coverageResult
      await this.checkpointStore.save(checkpoint)
    }

    const evidenceExcerpts = buildEvidenceExcerpts(context.test_file.content, chunkResults, deterministicFindings)

    const validateSynthesis = (value: unknown): AuditSynthesisResult => {
      const rawFindingCount = typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).findings)
        ? ((value as Record<string, unknown>).findings as unknown[]).length
        : null
      const validated = validateTestLines(
        validateAuditSynthesis(value, { lineCount: inventory.metrics.line_count }),
        inventory.metrics.line_count,
      )
      if (rawFindingCount !== null && rawFindingCount > validated.findings.length) {
        this.onProgress(
          `Normalized audit final synthesis from ${rawFindingCount} finding item(s) to ${validated.findings.length} highest-priority distinct finding(s); all returned items were validated before selection.`,
        )
      }
      return validated
    }

    const synthesis = await this.client.requestJson({
      operation: 'audit final synthesis',
      system: synthesisAuditInstructions,
      input: buildAuditSynthesisInput({
        testType,
        standards,
        context,
        inventory,
        deterministicFindings,
        globalMap,
        chunkResults,
        coverageResult,
        evidenceExcerpts,
      }),
      retryInput: buildAuditSynthesisInput({
        testType,
        standards,
        context,
        inventory,
        deterministicFindings,
        globalMap,
        chunkResults,
        coverageResult,
        evidenceExcerpts,
        isRetry: true,
      }),
      validate: validateSynthesis,
      maxTokens: 30_000,
      maxRetryTokens: 60_000,
      reasoningEffort: 'high',
      retryThinking: 'disabled',
      jsonSchema: auditSynthesisJsonSchema,
      schemaName: 'audit_synthesis',
      repair: {
        system: synthesisRepairInstructions,
        buildInput: buildAuditSynthesisRepairInput,
        maxTokens: 40_000,
      },
    })

    const requestTraces = this.client.traces.slice(tracesAtStart)
    const responseModels = [...new Set(requestTraces
      .map(trace => trace.response_model)
      .filter((model): model is string => model !== null))]

    return {
      summary: synthesis.summary,
      findings: synthesis.findings,
      audit: {
        overall_assessment: synthesis.overall_assessment,
        metrics: inventory.metrics,
        metric_locations: inventory.metric_locations,
        strengths: synthesis.strengths,
        standards_assessment: synthesis.standards_assessment,
        coverage_gaps: synthesis.coverage_gaps,
        test_placement_issues: synthesis.test_placement_issues,
        priorities: [...synthesis.priorities].sort((left, right) => left.rank - right.rank),
        limitations: [...new Set([...globalMap.limitations, ...coverageResult.limitations, ...synthesis.limitations])],
        context_actually_used: [...new Set(synthesis.context_actually_used)],
        execution: {
          complete: true,
          global_map_source: globalMapSource,
          test_chunks_reviewed: chunks.length,
          test_chunks_total: chunks.length,
          source_context_files_reviewed: context.related_files.length,
          ai_calls: this.client.requestsMade - requestsAtStart,
          provider: this.client.providerId,
          requested_model: this.client.requestedModel,
          response_models: responseModels,
          requests: requestTraces,
          checkpoint_key: checkpointKey,
          reused_passes: reusedPasses,
          adaptive_recoveries: [...new Set(adaptiveRecoveries)],
          passes: [
            'deterministic inventory',
            'global full-file structure map',
            'standards review by test chunk',
            'source and coverage cross-check',
            'evidence synthesis and prioritization',
          ],
        },
      },
    }
    } catch (error) {
      const failure = errorMessage(error)
      const evidence = [...collectedChunkResults.values()]
      const findings = partialFindings(evidence)
      const strengths = new Map<string, ChunkAuditResult['strengths'][number]>()
      for (const result of evidence) {
        for (const strength of result.strengths) {
          strengths.set(`${strength.title}:${strength.evidence_lines.join(',')}`, strength)
        }
      }
      const requestTraces = this.client.traces.slice(tracesAtStart)
      const responseModels = [...new Set(requestTraces
        .map(trace => trace.response_model)
        .filter((model): model is string => model !== null))]
      const reviewedTopLevelChunks = chunks.filter(chunk => checkpoint.chunks[chunk.id] !== undefined).length
      const limitations = [
        `The audit stopped before final synthesis: ${failure}`,
        'Completed chunk concerns are retained as informational partial evidence and have not received final severity prioritization.',
        ...(globalMap?.limitations ?? []),
        ...(coverageResult?.limitations ?? []),
      ]
      this.onProgress(
        `Preserving partial audit evidence for ${context.test_file.path}: ${reviewedTopLevelChunks}/${chunks.length} top-level chunk(s) completed before failure.`,
      )
      return {
        summary: `Audit incomplete after ${reviewedTopLevelChunks}/${chunks.length} test chunks; deterministic and completed AI evidence were preserved. ${failure}`,
        findings,
        incomplete_error: failure,
        audit: {
          overall_assessment: `This is a partial audit. ${reviewedTopLevelChunks} of ${chunks.length} top-level test chunks completed before the provider failure.`,
          metrics: inventory.metrics,
          metric_locations: inventory.metric_locations,
          strengths: [...strengths.values()].slice(0, 12),
          standards_assessment: [],
          coverage_gaps: coverageResult?.coverage_gaps ?? [],
          test_placement_issues: coverageResult?.test_placement_issues ?? [],
          priorities: [],
          limitations: [...new Set(limitations)],
          context_actually_used: [...new Set([
            ...(globalMap?.context_used ?? []),
            ...evidence.flatMap(result => result.context_used),
            ...(coverageResult?.context_used ?? []),
          ])],
        execution: {
          complete: false,
          global_map_source: globalMapSource,
            test_chunks_reviewed: reviewedTopLevelChunks,
            test_chunks_total: chunks.length,
            source_context_files_reviewed: context.related_files.length,
            ai_calls: this.client.requestsMade - requestsAtStart,
            provider: this.client.providerId,
            requested_model: this.client.requestedModel,
            response_models: responseModels,
            requests: requestTraces,
            checkpoint_key: checkpointKey,
            reused_passes: reusedPasses,
            adaptive_recoveries: [...new Set(adaptiveRecoveries)],
            passes: [
              'deterministic inventory',
              ...(globalMap ? ['global full-file structure map'] : []),
              ...(evidence.length ? ['partial standards review by test chunk'] : []),
              ...(coverageResult ? ['source and coverage cross-check'] : []),
            ],
          },
        },
      }
    }
  }

  get lastRequestTraces() {
    return this.client.traces.slice(this.lastTraceStart)
  }
}

export class DeepSeekAuditReviewer extends AiAuditReviewer {
  constructor(options: DeepSeekAuditReviewerOptions) {
    const { chunkLines, chunkConcurrency, checkpointDirectory, onProgress, ...clientOptions } = options
    super({
      client: new DeepSeekJsonClient({
        ...clientOptions,
        ...(onProgress ? { onProgress } : {}),
        timeoutMs: options.timeoutMs ?? 300_000,
      }),
      ...(chunkLines !== undefined ? { chunkLines } : {}),
      ...(chunkConcurrency !== undefined ? { chunkConcurrency } : {}),
      ...(checkpointDirectory !== undefined ? { checkpointDirectory } : {}),
      ...(onProgress ? { onProgress } : {}),
    })
  }
}
