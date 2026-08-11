import { QualityReviewerError } from './errors.js'
import {
  confidences,
  findingCategories,
  severities,
  type AuditCoverageGap,
  type AuditPlacementIssue,
  type AuditPriority,
  type AuditStandardsAssessment,
  type AuditStrength,
  type Confidence,
  type Finding,
  type FindingCategory,
  type Severity,
} from './types.js'

export interface AuditConcern {
  line: number
  end_line: number
  title: string
  description: string
  impact: string
  recommendation: string
  standards_references: string[]
  confidence: Confidence
}

export interface ChunkAuditResult {
  chunk_id: string
  summary: string
  strengths: AuditStrength[]
  concerns: AuditConcern[]
  context_used: string[]
}

export interface GlobalAuditMapResult {
  summary: string
  suites: Array<{
    name: string
    start_line: number
    end_line: number
    purpose: string
    key_behaviors: string[]
  }>
  shared_infrastructure: Array<{
    name: string
    evidence_lines: number[]
    purpose: string
  }>
  cross_suite_patterns: Array<{
    title: string
    description: string
    evidence_lines: number[]
    assessment: 'strength' | 'concern' | 'mixed'
  }>
  context_used: string[]
  limitations: string[]
}

export interface CoverageAuditResult {
  summary: string
  covered_behaviors: Array<{
    behavior: string
    source_evidence: string[]
    test_evidence: string[]
    assessment: string
  }>
  coverage_gaps: AuditCoverageGap[]
  test_placement_issues: AuditPlacementIssue[]
  context_used: string[]
  limitations: string[]
}

export interface AuditSynthesisResult {
  overall_assessment: string
  summary: string
  strengths: AuditStrength[]
  findings: Finding[]
  standards_assessment: AuditStandardsAssessment[]
  coverage_gaps: AuditCoverageGap[]
  test_placement_issues: AuditPlacementIssue[]
  priorities: AuditPriority[]
  limitations: string[]
  context_actually_used: string[]
}

const stringArraySchema = { type: 'array', items: { type: 'string' } } as const
const confidenceSchema = { type: 'string', enum: [...confidences] } as const

const strengthSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'evidence_lines', 'standards_references', 'why_it_matters', 'confidence'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    evidence_lines: { type: 'array', items: { type: 'integer', minimum: 1 } },
    standards_references: stringArraySchema,
    why_it_matters: { type: 'string' },
    confidence: confidenceSchema,
  },
} as const

const coverageGapSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'description', 'source_evidence', 'test_evidence', 'recommendation', 'severity', 'confidence'],
  properties: {
    area: { type: 'string' },
    description: { type: 'string' },
    source_evidence: stringArraySchema,
    test_evidence: stringArraySchema,
    recommendation: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'info'] },
    confidence: confidenceSchema,
  },
} as const

const placementIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'line', 'current_level', 'recommended_level', 'reason'],
  properties: {
    title: { type: 'string' },
    line: { type: 'integer', minimum: 1 },
    current_level: { type: 'string', enum: ['component', 'e2e', 'unknown'] },
    recommended_level: { type: 'string', enum: ['unit', 'component', 'e2e'] },
    reason: { type: 'string' },
  },
} as const

export const chunkAuditJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'strengths', 'concerns', 'context_used'],
  properties: {
    summary: { type: 'string' },
    strengths: { type: 'array', maxItems: 5, items: strengthSchema },
    concerns: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'end_line', 'title', 'description', 'impact', 'recommendation', 'standards_references', 'confidence'],
        properties: {
          line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          description: { type: 'string' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          standards_references: stringArraySchema,
          confidence: confidenceSchema,
        },
      },
    },
    context_used: stringArraySchema,
  },
} as const

export const globalAuditMapJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suites', 'shared_infrastructure', 'cross_suite_patterns', 'context_used', 'limitations'],
  properties: {
    summary: { type: 'string' },
    suites: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'start_line', 'end_line', 'purpose', 'key_behaviors'],
        properties: {
          name: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
          purpose: { type: 'string' },
          key_behaviors: stringArraySchema,
        },
      },
    },
    shared_infrastructure: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'evidence_lines', 'purpose'],
        properties: {
          name: { type: 'string' },
          evidence_lines: { type: 'array', items: { type: 'integer', minimum: 1 } },
          purpose: { type: 'string' },
        },
      },
    },
    cross_suite_patterns: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'evidence_lines', 'assessment'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          evidence_lines: { type: 'array', items: { type: 'integer', minimum: 1 } },
          assessment: { type: 'string', enum: ['strength', 'concern', 'mixed'] },
        },
      },
    },
    context_used: stringArraySchema,
    limitations: stringArraySchema,
  },
} as const

export const coverageAuditJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'covered_behaviors', 'coverage_gaps', 'test_placement_issues', 'context_used', 'limitations'],
  properties: {
    summary: { type: 'string' },
    covered_behaviors: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['behavior', 'source_evidence', 'test_evidence', 'assessment'],
        properties: {
          behavior: { type: 'string' },
          source_evidence: stringArraySchema,
          test_evidence: stringArraySchema,
          assessment: { type: 'string' },
        },
      },
    },
    coverage_gaps: { type: 'array', maxItems: 15, items: coverageGapSchema },
    test_placement_issues: { type: 'array', maxItems: 10, items: placementIssueSchema },
    context_used: stringArraySchema,
    limitations: stringArraySchema,
  },
} as const

const auditFindingSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'line', 'end_line', 'severity', 'rule', 'category', 'title', 'message', 'impact', 'suggestion',
    'replacement_code', 'specific_cypress_methods', 'context_used', 'confidence', 'evidence',
    'standards_references', 'related_locations',
  ],
  properties: {
    line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
    severity: { type: 'string', enum: [...severities] },
    rule: { type: 'string' },
    category: { type: 'string', enum: [...findingCategories] },
    title: { type: 'string' },
    message: { type: 'string' },
    impact: { type: 'string' },
    suggestion: { type: 'string' },
    replacement_code: { type: ['string', 'null'] },
    specific_cypress_methods: stringArraySchema,
    context_used: stringArraySchema,
    confidence: confidenceSchema,
    evidence: stringArraySchema,
    standards_references: stringArraySchema,
    related_locations: { type: 'array', items: { type: 'integer', minimum: 1 } },
  },
} as const

export const auditSynthesisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overall_assessment', 'summary', 'strengths', 'findings', 'standards_assessment', 'coverage_gaps',
    'test_placement_issues', 'priorities', 'limitations', 'context_actually_used',
  ],
  properties: {
    overall_assessment: { type: 'string' },
    summary: { type: 'string' },
    strengths: { type: 'array', maxItems: 12, items: strengthSchema },
    findings: { type: 'array', maxItems: 30, items: auditFindingSchema },
    standards_assessment: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'assessment', 'positives', 'concerns'],
        properties: {
          section: { type: 'string' },
          assessment: { type: 'string', enum: ['strong', 'mixed', 'weak', 'not_assessed'] },
          positives: stringArraySchema,
          concerns: stringArraySchema,
        },
      },
    },
    coverage_gaps: { type: 'array', maxItems: 20, items: coverageGapSchema },
    test_placement_issues: { type: 'array', maxItems: 15, items: placementIssueSchema },
    priorities: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'action', 'rationale', 'related_finding_rules'],
        properties: {
          rank: { type: 'integer', minimum: 1 },
          action: { type: 'string' },
          rationale: { type: 'string' },
          related_finding_rules: stringArraySchema,
        },
      },
    },
    limitations: stringArraySchema,
    context_actually_used: stringArraySchema,
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
  return value
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new QualityReviewerError(`${label} must be a string array`)
  }
  return value
}

function integers(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || !value.every(item => Number.isInteger(item) && item >= 1)) {
    throw new QualityReviewerError(`${label} must be a positive integer array`)
  }
  return value as number[]
}

function confidence(value: unknown, label: string): Confidence {
  if (typeof value !== 'string' || !confidences.includes(value as Confidence)) {
    throw new QualityReviewerError(`${label} has invalid confidence`)
  }
  return value as Confidence
}

function array(value: unknown, label: string, maxItems?: number): unknown[] {
  if (!Array.isArray(value)) throw new QualityReviewerError(`${label} must be an array`)
  if (maxItems !== undefined && value.length > maxItems) throw new QualityReviewerError(`${label} must contain at most ${maxItems} items`)
  return value
}

function strength(value: unknown, label: string): AuditStrength {
  const item = object(value, label)
  return {
    title: text(item.title, `${label}.title`),
    description: text(item.description, `${label}.description`),
    evidence_lines: integers(item.evidence_lines, `${label}.evidence_lines`),
    standards_references: strings(item.standards_references, `${label}.standards_references`),
    why_it_matters: text(item.why_it_matters, `${label}.why_it_matters`),
    confidence: confidence(item.confidence, label),
  }
}

function coverageGap(value: unknown, label: string): AuditCoverageGap {
  const item = object(value, label)
  if (item.severity !== 'low' && item.severity !== 'info') throw new QualityReviewerError(`${label}.severity is invalid`)
  return {
    area: text(item.area, `${label}.area`),
    description: text(item.description, `${label}.description`),
    source_evidence: strings(item.source_evidence, `${label}.source_evidence`),
    test_evidence: strings(item.test_evidence, `${label}.test_evidence`),
    recommendation: text(item.recommendation, `${label}.recommendation`),
    severity: item.severity,
    confidence: confidence(item.confidence, label),
  }
}

function placementIssue(value: unknown, label: string): AuditPlacementIssue {
  const item = object(value, label)
  if (!Number.isInteger(item.line) || (item.line as number) < 1) throw new QualityReviewerError(`${label}.line is invalid`)
  if (item.current_level !== 'component' && item.current_level !== 'e2e' && item.current_level !== 'unknown') {
    throw new QualityReviewerError(`${label}.current_level is invalid`)
  }
  if (item.recommended_level !== 'unit' && item.recommended_level !== 'component' && item.recommended_level !== 'e2e') {
    throw new QualityReviewerError(`${label}.recommended_level is invalid`)
  }
  return {
    title: text(item.title, `${label}.title`),
    line: item.line as number,
    current_level: item.current_level,
    recommended_level: item.recommended_level,
    reason: text(item.reason, `${label}.reason`),
  }
}

export function validateChunkAudit(value: unknown): ChunkAuditResult {
  const result = object(value, 'Chunk audit')
  return {
    chunk_id: typeof result.chunk_id === 'string' ? result.chunk_id : '',
    summary: text(result.summary, 'Chunk audit summary'),
    strengths: array(result.strengths, 'Chunk audit strengths', 5).map((item, index) => strength(item, `strength ${index}`)),
    concerns: array(result.concerns, 'Chunk audit concerns', 12).map((value, index) => {
      const item = object(value, `concern ${index}`)
      if (!Number.isInteger(item.line) || !Number.isInteger(item.end_line)) throw new QualityReviewerError(`concern ${index} has invalid lines`)
      return {
        line: item.line as number,
        end_line: item.end_line as number,
        title: text(item.title, `concern ${index}.title`),
        description: text(item.description, `concern ${index}.description`),
        impact: text(item.impact, `concern ${index}.impact`),
        recommendation: text(item.recommendation, `concern ${index}.recommendation`),
        standards_references: strings(item.standards_references, `concern ${index}.standards_references`),
        confidence: confidence(item.confidence, `concern ${index}`),
      }
    }),
    context_used: strings(result.context_used, 'Chunk audit context_used'),
  }
}

export function validateGlobalAuditMap(value: unknown): GlobalAuditMapResult {
  const result = object(value, 'Global audit map')
  return {
    summary: text(result.summary, 'Global audit map summary'),
    suites: array(result.suites, 'Global audit map suites', 60).map((value, index) => {
      const item = object(value, `global suite ${index}`)
      if (!Number.isInteger(item.start_line) || !Number.isInteger(item.end_line)) {
        throw new QualityReviewerError(`global suite ${index} has invalid lines`)
      }
      return {
        name: text(item.name, `global suite ${index}.name`),
        start_line: item.start_line as number,
        end_line: item.end_line as number,
        purpose: text(item.purpose, `global suite ${index}.purpose`),
        key_behaviors: strings(item.key_behaviors, `global suite ${index}.key_behaviors`),
      }
    }),
    shared_infrastructure: array(result.shared_infrastructure, 'shared_infrastructure', 30).map((value, index) => {
      const item = object(value, `shared infrastructure ${index}`)
      return {
        name: text(item.name, `shared infrastructure ${index}.name`),
        evidence_lines: integers(item.evidence_lines, `shared infrastructure ${index}.evidence_lines`),
        purpose: text(item.purpose, `shared infrastructure ${index}.purpose`),
      }
    }),
    cross_suite_patterns: array(result.cross_suite_patterns, 'cross_suite_patterns', 20).map((value, index) => {
      const item = object(value, `cross-suite pattern ${index}`)
      if (item.assessment !== 'strength' && item.assessment !== 'concern' && item.assessment !== 'mixed') {
        throw new QualityReviewerError(`cross-suite pattern ${index}.assessment is invalid`)
      }
      return {
        title: text(item.title, `cross-suite pattern ${index}.title`),
        description: text(item.description, `cross-suite pattern ${index}.description`),
        evidence_lines: integers(item.evidence_lines, `cross-suite pattern ${index}.evidence_lines`),
        assessment: item.assessment,
      }
    }),
    context_used: strings(result.context_used, 'Global audit map context_used'),
    limitations: strings(result.limitations, 'Global audit map limitations'),
  }
}

export function validateCoverageAudit(value: unknown): CoverageAuditResult {
  const result = object(value, 'Coverage audit')
  return {
    summary: text(result.summary, 'Coverage audit summary'),
    covered_behaviors: array(result.covered_behaviors, 'covered_behaviors', 20).map((value, index) => {
      const item = object(value, `covered behavior ${index}`)
      return {
        behavior: text(item.behavior, `covered behavior ${index}.behavior`),
        source_evidence: strings(item.source_evidence, `covered behavior ${index}.source_evidence`),
        test_evidence: strings(item.test_evidence, `covered behavior ${index}.test_evidence`),
        assessment: text(item.assessment, `covered behavior ${index}.assessment`),
      }
    }),
    coverage_gaps: array(result.coverage_gaps, 'coverage_gaps', 15).map((item, index) => coverageGap(item, `coverage gap ${index}`)),
    test_placement_issues: array(result.test_placement_issues, 'test_placement_issues', 10).map((item, index) => placementIssue(item, `placement issue ${index}`)),
    context_used: strings(result.context_used, 'Coverage audit context_used'),
    limitations: strings(result.limitations, 'Coverage audit limitations'),
  }
}

function auditFinding(value: unknown, index: number): Finding {
  const item = object(value, `audit finding ${index}`)
  if (!Number.isInteger(item.line) || !Number.isInteger(item.end_line)) throw new QualityReviewerError(`audit finding ${index} has invalid lines`)
  if (typeof item.severity !== 'string' || !severities.includes(item.severity as Severity)) throw new QualityReviewerError(`audit finding ${index} has invalid severity`)
  if (typeof item.category !== 'string' || !findingCategories.includes(item.category as FindingCategory)) throw new QualityReviewerError(`audit finding ${index} has invalid category`)
  if (item.replacement_code !== null && typeof item.replacement_code !== 'string') throw new QualityReviewerError(`audit finding ${index} has invalid replacement_code`)
  const title = text(item.title, `audit finding ${index}.title`)
  const rawMessage = typeof item.message === 'string' ? item.message.trim() : ''
  const rawImpact = typeof item.impact === 'string' ? item.impact.trim() : ''
  const impact = rawImpact || rawMessage || title
  const message = rawMessage || `${title}. ${impact}`
  const suggestion = typeof item.suggestion === 'string' && item.suggestion.trim()
    ? item.suggestion
    : `Revise the test at this location to address "${title}" using the cited standards and the observable behavior described in this finding.`
  return {
    line: item.line as number,
    end_line: item.end_line as number,
    severity: item.severity as Severity,
    rule: text(item.rule, `audit finding ${index}.rule`),
    category: item.category as FindingCategory,
    title,
    message,
    impact,
    suggestion,
    replacement_code: item.replacement_code as string | null,
    specific_cypress_methods: strings(item.specific_cypress_methods, `audit finding ${index}.specific_cypress_methods`),
    context_used: strings(item.context_used, `audit finding ${index}.context_used`),
    confidence: confidence(item.confidence, `audit finding ${index}`),
    evidence: strings(item.evidence, `audit finding ${index}.evidence`),
    standards_references: strings(item.standards_references, `audit finding ${index}.standards_references`),
    related_locations: integers(item.related_locations, `audit finding ${index}.related_locations`),
    source: 'ai',
  }
}

export function validateAuditSynthesis(value: unknown): AuditSynthesisResult {
  const result = object(value, 'Audit synthesis')
  return {
    overall_assessment: text(result.overall_assessment, 'overall_assessment'),
    summary: text(result.summary, 'summary'),
    strengths: array(result.strengths, 'strengths', 12).map((item, index) => strength(item, `strength ${index}`)),
    findings: array(result.findings, 'findings', 30).map(auditFinding),
    standards_assessment: array(result.standards_assessment, 'standards_assessment').map((value, index) => {
      const item = object(value, `standards assessment ${index}`)
      if (item.assessment !== 'strong' && item.assessment !== 'mixed' && item.assessment !== 'weak' && item.assessment !== 'not_assessed') {
        throw new QualityReviewerError(`standards assessment ${index}.assessment is invalid`)
      }
      return {
        section: text(item.section, `standards assessment ${index}.section`),
        assessment: item.assessment,
        positives: strings(item.positives, `standards assessment ${index}.positives`),
        concerns: strings(item.concerns, `standards assessment ${index}.concerns`),
      }
    }),
    coverage_gaps: array(result.coverage_gaps, 'coverage_gaps', 20).map((item, index) => coverageGap(item, `coverage gap ${index}`)),
    test_placement_issues: array(result.test_placement_issues, 'test_placement_issues', 15).map((item, index) => placementIssue(item, `placement issue ${index}`)),
    priorities: array(result.priorities, 'priorities', 12).map((value, index) => {
      const item = object(value, `priority ${index}`)
      if (!Number.isInteger(item.rank) || (item.rank as number) < 1) throw new QualityReviewerError(`priority ${index}.rank is invalid`)
      return {
        rank: item.rank as number,
        action: text(item.action, `priority ${index}.action`),
        rationale: text(item.rationale, `priority ${index}.rationale`),
        related_finding_rules: strings(item.related_finding_rules, `priority ${index}.related_finding_rules`),
      }
    }),
    limitations: strings(result.limitations, 'limitations'),
    context_actually_used: strings(result.context_actually_used, 'context_actually_used'),
  }
}
