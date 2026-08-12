import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ChunkAuditResult, CoverageAuditResult, GlobalAuditMapResult } from './auditSchema.js'
import type { ReviewContext, TestType } from './types.js'

const CHECKPOINT_VERSION = 3
export const AUDIT_PIPELINE_REVISION = 'audit-pipeline-v6-recommendation-enrichment'

export interface AuditCheckpoint {
  version: number
  key: string
  global_map?: GlobalAuditMapResult
  global_map_source?: 'ai' | 'deterministic_fallback'
  chunks: Record<string, ChunkAuditResult>
  adaptive_chunks?: Record<string, string[]>
  coverage?: CoverageAuditResult
}

export function auditCheckpointKey(options: {
  testType: TestType
  standards: string
  context: ReviewContext
  model: string
  provider: string
  providerEndpoint: string
  pipelineRevision: string
  chunkLines: number
}): string {
  return createHash('sha256').update(JSON.stringify({
    version: CHECKPOINT_VERSION,
    testType: options.testType,
    standards: options.standards,
    testFile: options.context.test_file,
    relatedFiles: options.context.related_files,
    model: options.model,
    provider: options.provider,
    providerEndpoint: options.providerEndpoint,
    pipelineRevision: options.pipelineRevision,
    chunkLines: options.chunkLines,
  })).digest('hex')
}

export class AuditCheckpointStore {
  private readonly directory: string | null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(directory?: string | null) {
    this.directory = directory ?? null
  }

  async load(key: string): Promise<AuditCheckpoint> {
    if (!this.directory) return { version: CHECKPOINT_VERSION, key, chunks: {} }
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, `${key}.json`), 'utf8')) as AuditCheckpoint
      if (parsed.version === CHECKPOINT_VERSION && parsed.key === key && parsed.chunks && typeof parsed.chunks === 'object') {
        return parsed
      }
    } catch {
      // A missing or invalid checkpoint is a cache miss, not a review failure.
    }
    return { version: CHECKPOINT_VERSION, key, chunks: {} }
  }

  async save(checkpoint: AuditCheckpoint): Promise<void> {
    if (!this.directory) return
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`
    const directory = this.directory
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(directory, { recursive: true })
      const destination = path.join(directory, `${checkpoint.key}.json`)
      const temporary = path.join(directory, `${checkpoint.key}.${process.pid}.${randomUUID()}.tmp`)
      await writeFile(temporary, serialized, 'utf8')
      await rename(temporary, destination)
    })
    await this.writeChain
  }
}
