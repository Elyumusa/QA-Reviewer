import { QualityReviewerError } from './errors.js'
import type { Finding, RecommendationCodeKind } from './types.js'
import ts from 'typescript'

export interface RecommendationEnrichment {
  finding_key: string
  recommendation: string
  replacement_code: string | null
  code_kind: RecommendationCodeKind
  internal_standard_references: string[]
  official_reference_urls: string[]
  assumptions: string[]
}

export interface RecommendationBatchResult {
  recommendations: RecommendationEnrichment[]
}

const stringArraySchema = { type: 'array', items: { type: 'string' } } as const

export const recommendationBatchJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recommendations'],
  properties: {
    recommendations: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'finding_key', 'recommendation', 'replacement_code', 'code_kind',
          'internal_standard_references', 'official_reference_urls', 'assumptions',
        ],
        properties: {
          finding_key: { type: 'string' },
          recommendation: { type: 'string' },
          replacement_code: { type: ['string', 'null'] },
          code_kind: { type: 'string', enum: ['exact', 'illustrative', 'unavailable'] },
          internal_standard_references: stringArraySchema,
          official_reference_urls: stringArraySchema,
          assumptions: stringArraySchema,
        },
      },
    },
  },
} as const

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QualityReviewerError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new QualityReviewerError(`${label} must be a non-empty string`)
  return value.trim()
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new QualityReviewerError(`${label} must be a string array`)
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))]
}

export function findingKey(finding: Finding): string {
  return `${finding.rule}:${finding.line}`
}

const allowedCypressLiterals = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
  'exist', 'not.exist', 'be.visible', 'not.be.visible', 'be.enabled', 'be.disabled',
  'have.length', 'have.length.at.least', 'have.attr', 'have.value', 'have.text',
  'contain', 'contain.text', 'include', 'eq', 'deep.equal',
  'have.been.called', 'have.been.calledOnce', 'have.been.calledWith',
  'request.body', 'request.url', 'request.method', 'response.body', 'response.statusCode',
  'click', 'input', 'change', 'blur', 'focus',
])

function unverifiedExactLiterals(code: string, repositoryText: string): string[] {
  const values = [...code.matchAll(/(['"])(.*?)\1/g)].map(match => match[2]!.trim()).filter(Boolean)
  const supported = (value: string): boolean => {
    if (allowedCypressLiterals.has(value) || repositoryText.includes(value)) return true
    if (/^[.#\[]/.test(value)) {
      const selectorTokens = value.match(/[A-Za-z_][\w-]{2,}/g) ?? []
      return selectorTokens.length > 0 && selectorTokens.every(token => repositoryText.includes(token))
    }
    return false
  }
  return [...new Set(values.filter(value => !supported(value)))]
}

function validateTypeScriptSnippet(code: string, label: string): void {
  if (/```/.test(code)) throw new QualityReviewerError(`${label} must contain raw TypeScript without Markdown fences`)
  const result = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  })
  const syntacticError = result.diagnostics?.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (syntacticError) {
    throw new QualityReviewerError(`${label} is not syntactically valid TypeScript: ${ts.flattenDiagnosticMessageText(syntacticError.messageText, ' ')}`)
  }
}

export function validateRecommendationBatch(
  value: unknown,
  options: {
    findings: Finding[]
    allowedOfficialUrls: Set<string>
    allowedStandardHeadings: Set<string>
    repositoryText: string
  },
): RecommendationBatchResult {
  const root = object(value, 'Recommendation enrichment')
  if (!Array.isArray(root.recommendations) || root.recommendations.length > options.findings.length) {
    throw new QualityReviewerError(`recommendations must contain at most ${options.findings.length} items`)
  }
  const allowedKeys = new Set(options.findings.map(findingKey))
  const seen = new Set<string>()
  const recommendations = root.recommendations.map((value, index): RecommendationEnrichment => {
    const item = object(value, `recommendation ${index}`)
    const key = text(item.finding_key, `recommendation ${index}.finding_key`)
    if (!allowedKeys.has(key)) throw new QualityReviewerError(`recommendation ${index} has an unknown finding_key`)
    if (seen.has(key)) throw new QualityReviewerError(`recommendation ${index} duplicates finding_key ${key}`)
    seen.add(key)
    if (item.code_kind !== 'exact' && item.code_kind !== 'illustrative' && item.code_kind !== 'unavailable') {
      throw new QualityReviewerError(`recommendation ${index}.code_kind is invalid`)
    }
    if (item.replacement_code !== null && (typeof item.replacement_code !== 'string' || !item.replacement_code.trim())) {
      throw new QualityReviewerError(`recommendation ${index}.replacement_code is invalid`)
    }
    if (item.code_kind === 'unavailable' && item.replacement_code !== null) {
      throw new QualityReviewerError(`recommendation ${index} marked unavailable must not contain replacement code`)
    }
    if (item.code_kind !== 'unavailable' && item.replacement_code === null) {
      throw new QualityReviewerError(`recommendation ${index} marked ${item.code_kind} must contain replacement code`)
    }
    if (typeof item.replacement_code === 'string') {
      validateTypeScriptSnippet(item.replacement_code, `recommendation ${index}.replacement_code`)
    }
    const internalReferences = strings(item.internal_standard_references, `recommendation ${index}.internal_standard_references`)
    if (internalReferences.length === 0) {
      throw new QualityReviewerError(`recommendation ${index} must cite at least one supplied internal standard heading`)
    }
    if (!internalReferences.every(reference => options.allowedStandardHeadings.has(reference))) {
      throw new QualityReviewerError(`recommendation ${index} cited an internal standard heading that was not supplied`)
    }
    const officialUrls = strings(item.official_reference_urls, `recommendation ${index}.official_reference_urls`)
    if (!officialUrls.every(url => options.allowedOfficialUrls.has(url))) {
      throw new QualityReviewerError(`recommendation ${index} cited an official URL that is not allowlisted by the standards`)
    }
    const assumptions = strings(item.assumptions, `recommendation ${index}.assumptions`)
    if (item.code_kind !== 'exact' && assumptions.length === 0) {
      throw new QualityReviewerError(`recommendation ${index} marked ${item.code_kind} must describe the required assumptions or missing context`)
    }
    if (item.code_kind === 'exact') {
      const unknown = unverifiedExactLiterals(item.replacement_code as string, options.repositoryText)
      if (unknown.length > 0) {
        throw new QualityReviewerError(
          `recommendation ${index} exact code contains unverified literal(s): ${unknown.slice(0, 5).join(', ')}`,
        )
      }
    }
    return {
      finding_key: key,
      recommendation: text(item.recommendation, `recommendation ${index}.recommendation`),
      replacement_code: item.replacement_code === null ? null : item.replacement_code.trim(),
      code_kind: item.code_kind,
      internal_standard_references: internalReferences,
      official_reference_urls: officialUrls,
      assumptions,
    }
  })

  if (recommendations.length !== options.findings.length) {
    throw new QualityReviewerError(`recommendation enrichment returned ${recommendations.length}/${options.findings.length} requested items`)
  }
  return { recommendations }
}
