import { QualityReviewerError } from './errors.js'
import {
  confidences,
  findingCategories,
  severities,
  testTypes,
  type Confidence,
  type Finding,
  type FindingCategory,
  type Severity,
  type TestType,
} from './types.js'

export interface AiReviewResult {
  file: string
  test_type: TestType
  status: 'pass' | 'fail'
  summary: string
  findings: Finding[]
}

export const aiReviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'test_type', 'status', 'summary', 'findings'],
  properties: {
    file: { type: 'string' },
    test_type: { type: 'string', enum: [...testTypes] },
    status: { type: 'string', enum: ['pass', 'fail'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'line',
          'severity',
          'rule',
          'category',
          'title',
          'message',
          'suggestion',
          'replacement_code',
          'specific_cypress_methods',
          'context_used',
          'confidence',
        ],
        properties: {
          line: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: [...severities] },
          rule: { type: 'string' },
          category: { type: 'string', enum: [...findingCategories] },
          title: { type: 'string' },
          message: { type: 'string' },
          suggestion: { type: 'string' },
          replacement_code: { type: ['string', 'null'] },
          specific_cypress_methods: { type: 'array', items: { type: 'string' } },
          context_used: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: [...confidences] },
        },
      },
    },
  },
} as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validateFinding(value: unknown, index: number): Finding {
  if (!isObject(value)) {
    throw new QualityReviewerError(`AI finding ${index} must be an object`)
  }

  if (!Number.isInteger(value.line) || (value.line as number) < 1) {
    throw new QualityReviewerError(`AI finding ${index} has an invalid line`)
  }
  if (!isEnumValue(severities, value.severity)) {
    throw new QualityReviewerError(`AI finding ${index} has an invalid severity`)
  }
  if (!isEnumValue(findingCategories, value.category)) {
    throw new QualityReviewerError(`AI finding ${index} has an invalid category`)
  }
  if (!isEnumValue(confidences, value.confidence)) {
    throw new QualityReviewerError(`AI finding ${index} has an invalid confidence`)
  }

  for (const property of ['rule', 'title', 'message', 'suggestion'] as const) {
    if (typeof value[property] !== 'string' || !value[property].trim()) {
      throw new QualityReviewerError(`AI finding ${index} has an invalid ${property}`)
    }
  }

  if (value.replacement_code !== null && typeof value.replacement_code !== 'string') {
    throw new QualityReviewerError(`AI finding ${index} has an invalid replacement_code`)
  }
  if (!stringArray(value.specific_cypress_methods) || !stringArray(value.context_used)) {
    throw new QualityReviewerError(`AI finding ${index} has invalid context arrays`)
  }

  return {
    line: value.line as number,
    severity: value.severity as Severity,
    rule: value.rule as string,
    category: value.category as FindingCategory,
    title: value.title as string,
    message: value.message as string,
    suggestion: value.suggestion as string,
    replacement_code: value.replacement_code as string | null,
    specific_cypress_methods: value.specific_cypress_methods,
    context_used: value.context_used,
    confidence: value.confidence as Confidence,
    source: 'ai',
  }
}

export function validateAiReview(value: unknown): AiReviewResult {
  if (!isObject(value)) {
    throw new QualityReviewerError('AI response must be an object')
  }
  if (typeof value.file !== 'string' || !isEnumValue(testTypes, value.test_type)) {
    throw new QualityReviewerError('AI response has an invalid file or test_type')
  }
  if (value.status !== 'pass' && value.status !== 'fail') {
    throw new QualityReviewerError('AI response has an invalid status')
  }
  if (typeof value.summary !== 'string' || !Array.isArray(value.findings)) {
    throw new QualityReviewerError('AI response has an invalid summary or findings list')
  }

  return {
    file: value.file,
    test_type: value.test_type,
    status: value.status,
    summary: value.summary,
    findings: value.findings.map(validateFinding),
  }
}
