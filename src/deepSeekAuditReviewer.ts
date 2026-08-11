import { buildAuditInventory, chunkSource } from './auditInventory.js'
import { AUDIT_PIPELINE_REVISION, AuditCheckpointStore, auditCheckpointKey } from './auditCheckpoint.js'
import {
  buildAuditSynthesisRepairInput,
  buildAuditSynthesisInput,
  buildChunkAuditInput,
  buildCoverageAuditInput,
  buildEvidenceExcerpts,
  buildGlobalAuditMapInput,
  chunkAuditInstructions,
  coverageAuditInstructions,
  globalAuditMapInstructions,
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
import { AiJsonClient } from './aiJsonClient.js'
import { DeepSeekJsonClient, type DeepSeekClientOptions } from './deepSeekClient.js'
import { QualityReviewerError } from './errors.js'
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
    this.onProgress(
      `Inventory complete for ${context.test_file.path}: ${inventory.metrics.line_count} lines, ${inventory.metrics.test_count} tests, ${inventory.metrics.suite_count} suites, ${chunks.length} semantic audit chunks.`,
    )

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

    let globalMap: GlobalAuditMapResult
    if (checkpoint.global_map) {
      globalMap = validateGlobalMapLines(validateGlobalAuditMap(checkpoint.global_map))
      reusedPasses.push('global full-file map')
      this.onProgress('Reusing checkpointed global full-file map.')
    } else {
      globalMap = await this.client.requestJson({
        operation: 'audit global full-file map',
        system: globalAuditMapInstructions,
        input: buildGlobalAuditMapInput({ testType, standards, context, inventory }),
        retryInput: buildGlobalAuditMapInput({ testType, standards, context, inventory, isRetry: true }),
        validate: value => validateGlobalMapLines(validateGlobalAuditMap(value)),
        maxTokens: 20_000,
        maxRetryTokens: 40_000,
        reasoningEffort: 'high',
        jsonSchema: globalAuditMapJsonSchema,
        schemaName: 'audit_global_map',
      })
      checkpoint.global_map = globalMap
      await this.checkpointStore.save(checkpoint)
    }

    const chunkResults = await mapConcurrent(chunks, this.chunkConcurrency, async chunk => {
      const validate = (value: unknown): ChunkAuditResult => {
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
      const cached = checkpoint.chunks[chunk.id]
      if (cached) {
        const result = validate(cached)
        reusedPasses.push(`standards chunk ${chunk.id}`)
        this.onProgress(`Reusing checkpointed standards chunk ${chunk.id}.`)
        return result
      }
      const result = await this.client.requestJson({
        operation: `audit standards chunk ${chunk.id}`,
        system: chunkAuditInstructions,
        input: buildChunkAuditInput({ testType, standards, context, inventory, deterministicFindings, chunk, globalMap }),
        retryInput: buildChunkAuditInput({ testType, standards, context, inventory, deterministicFindings, chunk, globalMap, isRetry: true }),
        validate,
        maxTokens: 20_000,
        maxRetryTokens: 40_000,
        reasoningEffort: 'high',
        jsonSchema: chunkAuditJsonSchema,
        schemaName: 'audit_chunk',
      })
      checkpoint.chunks[chunk.id] = result
      await this.checkpointStore.save(checkpoint)
      return result
    })

    const validateCoverage = (value: unknown): CoverageAuditResult => {
      const result = validateCoverageAudit(value)
      for (const issue of result.test_placement_issues) {
        if (issue.line > inventory.metrics.line_count) throw new QualityReviewerError('Coverage review returned an invalid test line')
      }
      return result
    }
    let coverageResult: CoverageAuditResult
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
        jsonSchema: coverageAuditJsonSchema,
        schemaName: 'audit_coverage',
      })
      checkpoint.coverage = coverageResult
      await this.checkpointStore.save(checkpoint)
    }

    const evidenceExcerpts = buildEvidenceExcerpts(context.test_file.content, chunkResults, deterministicFindings)

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
      validate: value => validateTestLines(validateAuditSynthesis(value), inventory.metrics.line_count),
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
        limitations: [...new Set([...coverageResult.limitations, ...synthesis.limitations])],
        context_actually_used: [...new Set(synthesis.context_actually_used)],
        execution: {
          test_chunks_reviewed: chunks.length,
          source_context_files_reviewed: context.related_files.length,
          ai_calls: this.client.requestsMade - requestsAtStart,
          provider: this.client.providerId,
          requested_model: this.client.requestedModel,
          response_models: responseModels,
          requests: requestTraces,
          checkpoint_key: checkpointKey,
          reused_passes: reusedPasses,
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
