#!/usr/bin/env node

import { constants, realpathSync } from 'node:fs'
import { access, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defaultModelForProvider, resolveAiConfiguration, resolveAiProviderId } from './aiConfig.js'
import { AiJsonClient } from './aiJsonClient.js'
import { AiReviewer } from './deepSeekReviewer.js'
import { AiAuditReviewer } from './deepSeekAuditReviewer.js'
import { collectContext } from './contextCollector.js'
import { runDeterministicChecks } from './deterministicChecks.js'
import { QualityReviewerError, errorMessage } from './errors.js'
import { classifyTestFile } from './fileClassifier.js'
import { changedCypressFiles, filterReviewableFiles, findRepositoryRoot } from './git.js'
import {
  jsonPathFor,
  markdownPathFor,
  mergeFindings,
  summarize,
  terminalReport,
  writeJsonReport,
  writeMarkdownReport,
} from './reportWriter.js'
import { defaultStandardsPaths, loadStandards } from './standardsLoader.js'
import type { AiProviderId, ContextLimits, FileReview, ReviewMode, ReviewReport, TestType } from './types.js'

type OutputFormat = 'json' | 'markdown' | 'both'

interface CliOptions {
  base: string | null
  baseProvided: boolean
  files: string[]
  output: string
  format: OutputFormat
  deterministicOnly: boolean
  provider: AiProviderId | null
  testType: TestType | null
  mode: ReviewMode
  auditChunkLines: number
  auditConcurrency: number
  transportRetries: number
  transportRetryDelayMs: number
  requestTimeoutMs: number | null
  connectionTimeoutMs: number
  streamInactivityTimeoutMs: number
  auditCache: boolean
  quiet: boolean
  help: boolean
  limits: ContextLimits
  limitOverrides: Set<keyof ContextLimits>
}

const helpText = `Cypress AI Quality Reviewer

Usage:
  qa-review --base origin/main [options]
  qa-review --files path/to/Test.cy.ts [more files] [options]

Options:
  --base <ref>                 Git base ref (default: origin/main)
  --files <paths...>           Review explicit Cypress test files
  --output <path>              Report path (default: qa-review-results.json)
  --format <json|markdown|both>  Report format (default: json)
  --mode <focused|audit>       Focused CI review or comprehensive audit (default: focused)
  --provider <name>            deepseek, openai, or anthropic (default: QA_AI_PROVIDER or deepseek)
  --test-type <component|e2e> Override automatic test-type classification
  --deterministic-only         Skip AI review (useful without an API key)
  --audit-chunk-lines <count>  Lines per audit evidence chunk (default: 700)
  --audit-concurrency <count>  Parallel audit chunk requests, 1-4 (default: 2)
  --transport-retries <count>  Retries for recoverable transport/API errors, 0-3 (default: 2)
  --transport-retry-delay-ms <ms>  Initial exponential retry delay (default: 2000)
  --request-timeout-ms <ms>    Total safety ceiling (audit default: 900000; focused: 120000)
  --connection-timeout-ms <ms> Time allowed for response headers (default: 30000)
  --stream-inactivity-timeout-ms <ms>  Maximum silence while streaming (default: 90000)
  --no-audit-cache            Ignore and do not write reusable audit checkpoints
  --max-related-files <count>  Related context files per test (default: 5)
  --max-context-chars <count>  Additional diff/context character budget (default: 50000)
  --max-file-chars <count>     Maximum related-file characters (default: 12000)
  --quiet                      Suppress terminal summary
  --help                       Show this help

Environment:
  QA_AI_PROVIDER               Default provider when --provider is omitted
  DEEPSEEK_API_KEY             DeepSeek key; DEEPSEEK_MODEL and DEEPSEEK_API_URL are optional
  OPENAI_API_KEY               OpenAI key; OPENAI_MODEL and OPENAI_API_URL are optional
  ANTHROPIC_API_KEY            Claude key; ANTHROPIC_MODEL/API_URL/VERSION are optional
`
function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new QualityReviewerError(`${option} requires a value`)
  }
  return value
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new QualityReviewerError(`${option} must be a positive integer`)
  }
  return parsed
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new QualityReviewerError(`${option} must be a non-negative integer`)
  }
  return parsed
}

export function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = {
    base: 'origin/main',
    baseProvided: false,
    files: [],
    output: 'qa-review-results.json',
    format: 'json',
    deterministicOnly: false,
    provider: null,
    testType: null,
    mode: 'focused',
    auditChunkLines: 700,
    auditConcurrency: 2,
    transportRetries: 2,
    transportRetryDelayMs: 2000,
    requestTimeoutMs: null,
    connectionTimeoutMs: 30_000,
    streamInactivityTimeoutMs: 90_000,
    auditCache: true,
    quiet: false,
    help: false,
    limits: {
      maxRelatedFiles: 5,
      maxContextCharacters: 50_000,
      maxSingleFileCharacters: 12_000,
    },
    limitOverrides: new Set(),
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    switch (argument) {
      case '--base':
        options.base = requiredValue(args, index, '--base')
        options.baseProvided = true
        index += 1
        break
      case '--output':
        options.output = requiredValue(args, index, '--output')
        index += 1
        break
      case '--format': {
        const value = requiredValue(args, index, '--format')
        if (value !== 'json' && value !== 'markdown' && value !== 'both') {
          throw new QualityReviewerError('--format must be json, markdown, or both')
        }
        options.format = value
        index += 1
        break
      }
      case '--files': {
        let found = false
        while (args[index + 1] && !args[index + 1]?.startsWith('--')) {
          const value = args[index + 1] ?? ''
          options.files.push(...value.split(',').map(file => file.trim()).filter(Boolean))
          index += 1
          found = true
        }
        if (!found) {
          throw new QualityReviewerError('--files requires at least one path')
        }
        break
      }
      case '--deterministic-only':
        options.deterministicOnly = true
        break
      case '--provider':
        options.provider = resolveAiProviderId(requiredValue(args, index, '--provider'))
        index += 1
        break
      case '--test-type': {
        const value = requiredValue(args, index, '--test-type')
        if (value !== 'component' && value !== 'e2e') {
          throw new QualityReviewerError('--test-type must be component or e2e')
        }
        options.testType = value
        index += 1
        break
      }
      case '--mode': {
        const value = requiredValue(args, index, '--mode')
        if (value !== 'focused' && value !== 'audit') {
          throw new QualityReviewerError('--mode must be focused or audit')
        }
        options.mode = value
        index += 1
        break
      }
      case '--audit-chunk-lines':
        options.auditChunkLines = positiveInteger(requiredValue(args, index, argument), argument)
        if (options.auditChunkLines < 100) throw new QualityReviewerError('--audit-chunk-lines must be at least 100')
        index += 1
        break
      case '--audit-concurrency':
        options.auditConcurrency = positiveInteger(requiredValue(args, index, argument), argument)
        if (options.auditConcurrency > 4) throw new QualityReviewerError('--audit-concurrency must be between 1 and 4')
        index += 1
        break
      case '--transport-retries':
        options.transportRetries = nonNegativeInteger(requiredValue(args, index, argument), argument)
        if (options.transportRetries > 3) throw new QualityReviewerError('--transport-retries must be between 0 and 3')
        index += 1
        break
      case '--transport-retry-delay-ms':
        options.transportRetryDelayMs = nonNegativeInteger(requiredValue(args, index, argument), argument)
        if (options.transportRetryDelayMs > 30_000) throw new QualityReviewerError('--transport-retry-delay-ms must be between 0 and 30000')
        index += 1
        break
      case '--request-timeout-ms':
        options.requestTimeoutMs = positiveInteger(requiredValue(args, index, argument), argument)
        if (options.requestTimeoutMs > 1_800_000) throw new QualityReviewerError('--request-timeout-ms must be between 1 and 1800000')
        index += 1
        break
      case '--connection-timeout-ms':
        options.connectionTimeoutMs = positiveInteger(requiredValue(args, index, argument), argument)
        if (options.connectionTimeoutMs > 300_000) throw new QualityReviewerError('--connection-timeout-ms must be between 1 and 300000')
        index += 1
        break
      case '--stream-inactivity-timeout-ms':
        options.streamInactivityTimeoutMs = positiveInteger(requiredValue(args, index, argument), argument)
        if (options.streamInactivityTimeoutMs > 600_000) throw new QualityReviewerError('--stream-inactivity-timeout-ms must be between 1 and 600000')
        index += 1
        break
      case '--no-audit-cache':
        options.auditCache = false
        break
      case '--quiet':
        options.quiet = true
        break
      case '--max-related-files':
        options.limits.maxRelatedFiles = positiveInteger(requiredValue(args, index, argument), argument)
        options.limitOverrides.add('maxRelatedFiles')
        index += 1
        break
      case '--max-context-chars':
        options.limits.maxContextCharacters = positiveInteger(requiredValue(args, index, argument), argument)
        options.limitOverrides.add('maxContextCharacters')
        index += 1
        break
      case '--max-file-chars':
        options.limits.maxSingleFileCharacters = positiveInteger(requiredValue(args, index, argument), argument)
        options.limitOverrides.add('maxSingleFileCharacters')
        index += 1
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new QualityReviewerError(`Unknown option: ${argument ?? ''}`)
    }
  }

  if (options.files.length > 0 && !options.baseProvided) {
    options.base = null
  }
  if (options.mode === 'audit') {
    if (!options.limitOverrides.has('maxRelatedFiles')) options.limits.maxRelatedFiles = 8
    if (!options.limitOverrides.has('maxContextCharacters')) options.limits.maxContextCharacters = 180_000
    if (!options.limitOverrides.has('maxSingleFileCharacters')) options.limits.maxSingleFileCharacters = 100_000
  }
  if (options.mode === 'audit' && options.deterministicOnly) {
    throw new QualityReviewerError('--mode audit requires AI review; remove --deterministic-only or use --mode focused')
  }
  return options
}

async function writeReports(options: CliOptions, report: ReviewReport): Promise<string[]> {
  const output = path.resolve(process.cwd(), options.output)
  const written: string[] = []

  if (options.format === 'json' || options.format === 'both') {
    const jsonPath = jsonPathFor(output)
    await writeJsonReport(jsonPath, report)
    written.push(jsonPath)
  }
  if (options.format === 'markdown' || options.format === 'both') {
    const markdownPath = options.format === 'markdown' ? markdownPathFor(output) : markdownPathFor(jsonPathFor(output))
    await writeMarkdownReport(markdownPath, report)
    written.push(markdownPath)
  }
  return written
}

async function preflightReportDestinations(options: CliOptions): Promise<void> {
  const output = path.resolve(process.cwd(), options.output)
  const destinations = options.format === 'both'
    ? [jsonPathFor(output), markdownPathFor(jsonPathFor(output))]
    : options.format === 'markdown'
      ? [markdownPathFor(output)]
      : [jsonPathFor(output)]

  for (const destination of destinations) {
    const parent = path.dirname(destination)
    await mkdir(parent, { recursive: true })
    await access(parent, constants.W_OK)
    try {
      const existing = await stat(destination)
      if (!existing.isFile()) throw new QualityReviewerError(`Report destination is not a file: ${destination}`)
    } catch (error) {
      if (error instanceof QualityReviewerError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export async function run(args = process.argv.slice(2)): Promise<number> {
  const options = parseArguments(args)
  if (options.help) {
    console.log(helpText)
    return 0
  }

  await preflightReportDestinations(options)
  const repoRoot = await findRepositoryRoot()
  const files = options.files.length > 0
    ? await filterReviewableFiles(repoRoot, options.files, { strict: true })
    : await changedCypressFiles(repoRoot, options.base ?? 'origin/main')

  const selectedProvider = resolveAiProviderId(options.provider ?? process.env.QA_AI_PROVIDER)
  const modelVariable = selectedProvider === 'deepseek'
    ? 'DEEPSEEK_MODEL'
    : selectedProvider === 'openai' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'
  const configuredModel = (process.env[modelVariable] ?? defaultModelForProvider(selectedProvider)).trim()
  const model = options.deterministicOnly ? null : (configuredModel || null)
  const progress = (message: string): void => {
    if (!options.quiet) console.log(`[qa-review] ${message}`)
  }
  if (files.length > 0) {
    progress(`Starting ${options.mode} review for ${files.length} file(s); provider: ${options.deterministicOnly ? 'none' : selectedProvider}; requested model: ${model ?? 'none (deterministic only)'}.`)
  }
  let reviewProvider: AiReviewer | null = null
  let auditProvider: AiAuditReviewer | null = null
  let providerSetupError: unknown
  if (!options.deterministicOnly && files.length > 0) {
    try {
      const configuration = resolveAiConfiguration(selectedProvider, process.env)
      const client = new AiJsonClient({
        provider: configuration.adapter,
        onProgress: progress,
        timeoutMs: options.requestTimeoutMs ?? (options.mode === 'audit' ? 900_000 : 120_000),
        connectionTimeoutMs: options.connectionTimeoutMs,
        streamInactivityTimeoutMs: options.streamInactivityTimeoutMs,
        transportRetries: options.transportRetries,
        transportRetryDelayMs: options.transportRetryDelayMs,
      })
      if (options.mode === 'audit') {
        auditProvider = new AiAuditReviewer({
          client,
          chunkLines: options.auditChunkLines,
          chunkConcurrency: options.auditConcurrency,
          checkpointDirectory: options.auditCache
            ? path.join(repoRoot, '.qa-review-cache')
            : null,
          onProgress: progress,
        })
      } else {
        reviewProvider = new AiReviewer(client)
      }
    } catch (error) {
      providerSetupError = error
      progress(`AI configuration could not be initialized: ${errorMessage(error)}`)
    }
  }

  const reviews: FileReview[] = []
  const errors: string[] = []
  const standardsCache = new Map<TestType, string>()
  const standardsPaths = defaultStandardsPaths(repoRoot)

  for (const file of files) {
    const testType = options.testType ?? classifyTestFile(file)
    let providerInvoked = false
    try {
      progress(`Preparing ${file} (${testType}).`)
      if (providerSetupError !== undefined) throw providerSetupError
      let standards = standardsCache.get(testType)
      if (!standards) {
        standards = (await loadStandards(testType, standardsPaths)).content
        standardsCache.set(testType, standards)
      }

      const context = await collectContext(repoRoot, file, options.base, options.limits)
      progress(`Collected ${context.related_files.length} related context file(s) for ${file}${context.diff ? ' with a Git diff' : ''}.`)
      const deterministic = runDeterministicChecks(context.test_file.content)
      progress(`Deterministic checks found ${deterministic.length} issue(s) in ${file}.`)
      let auditResult = null
      let aiResult = null
      if (auditProvider) {
        providerInvoked = true
        auditResult = await auditProvider.audit(testType, standards, context, deterministic)
      } else if (reviewProvider) {
        providerInvoked = true
        aiResult = await reviewProvider.review(testType, standards, context, deterministic)
      }
      const findings = mergeFindings(deterministic, auditResult?.findings ?? aiResult?.findings ?? [])
      const incompleteError = auditResult?.incomplete_error
      if (incompleteError) errors.push(`${file}: ${incompleteError}`)
      reviews.push({
        file,
        test_type: testType,
        status: incompleteError ? 'error' : findings.length > 0 ? 'fail' : 'pass',
        summary: auditResult?.summary ?? aiResult?.summary ?? (findings.length > 0
          ? `${findings.length} deterministic finding(s).`
          : 'No deterministic issues found.'),
        findings,
        context_files_used: context.related_files.map(related => related.path),
        ...(auditResult ? { audit: auditResult.audit } : {}),
      })
      progress(incompleteError
        ? `Completed ${file} with a partial audit: ${findings.length} preserved finding(s).`
        : `Completed ${file}: ${findings.length} consolidated finding(s).`)
    } catch (error) {
      const message = `${file}: ${errorMessage(error)}`
      errors.push(message)
      const providerRequests = providerInvoked
        ? auditProvider?.lastRequestTraces ?? reviewProvider?.lastRequestTraces ?? []
        : []
      reviews.push({
        file,
        test_type: testType,
        status: 'error',
        summary: errorMessage(error),
        findings: [],
        context_files_used: [],
        ...(providerRequests.length
          ? { provider_requests: providerRequests }
          : {}),
      })
      progress(`Failed ${file}: ${errorMessage(error)}`)
    }
  }

  const report: ReviewReport = {
    status: errors.length > 0 ? 'completed_with_errors' : 'completed',
    base: options.base,
    reviewed_files_count: reviews.length,
    generated_at: new Date().toISOString(),
    model,
    provider: options.deterministicOnly ? null : selectedProvider,
    mode: options.mode,
    summary: summarize(reviews.flatMap(review => review.findings)),
    files: reviews,
    errors,
  }

  progress('Writing requested report files.')
  const written = await writeReports(options, report)
  if (!options.quiet) {
    if (files.length === 0) {
      console.log('No changed Cypress test files found.')
    } else {
      console.log(terminalReport(report))
    }
    for (const output of written) {
      console.log(`Report saved to ${path.relative(process.cwd(), output) || output}`)
    }
  }

  return errors.length > 0 ? 1 : 0
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false
  const directMatch = import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  if (directMatch) return true
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  run().then(
    exitCode => { process.exitCode = exitCode },
    error => {
      console.error(`qa-review: ${errorMessage(error)}`)
      process.exitCode = 1
    },
  )
}
