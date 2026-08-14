export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const
export const confidences = ['high', 'medium', 'low'] as const
export const testTypes = ['component', 'e2e', 'unknown'] as const
export const findingCategories = ['quality', 'potential_coverage_gap'] as const
export const reviewModes = ['focused', 'audit'] as const
export const aiProviders = ['deepseek', 'openai', 'anthropic'] as const

export type Severity = (typeof severities)[number]
export type Confidence = (typeof confidences)[number]
export type TestType = (typeof testTypes)[number]
export type FindingCategory = (typeof findingCategories)[number]
export type ReviewMode = (typeof reviewModes)[number]
export type AiProviderId = (typeof aiProviders)[number]

export type RecommendationCodeKind = 'exact' | 'illustrative' | 'unavailable'

export interface OfficialReference {
  title: string
  url: string
}

export interface Finding {
  line: number
  severity: Severity
  rule: string
  category: FindingCategory
  title: string
  message: string
  suggestion: string
  replacement_code: string | null
  specific_cypress_methods: string[]
  context_used: string[]
  confidence: Confidence
  source: 'deterministic' | 'ai'
  end_line?: number
  evidence?: string[]
  standards_references?: string[]
  impact?: string
  related_locations?: number[]
  official_references?: OfficialReference[]
  recommendation_code_kind?: RecommendationCodeKind
  recommendation_assumptions?: string[]
}

export interface AuditMetrics {
  line_count: number
  suite_count: number
  test_count: number
  any_cast_lines: number
  forced_interactions: number
  before_each_hooks: number
  after_each_hooks: number
  fixed_waits: number
  skipped_tests: number
  focused_tests: number
  conditional_blocks: number
  silent_conditional_assertion_blocks: number
  private_member_access_lines: number
  broad_exception_handlers: number
  generic_selector_calls: number
}

export type AuditMetricName = keyof AuditMetrics

export interface AuditInventory {
  metrics: AuditMetrics
  metric_locations: Record<AuditMetricName, number[]>
  tests: Array<{ name: string; line: number }>
  suites: Array<{ name: string; line: number }>
}

export interface AuditStrength {
  title: string
  description: string
  evidence_lines: number[]
  standards_references: string[]
  why_it_matters: string
  confidence: Confidence
}

export interface AuditCoverageGap {
  area: string
  description: string
  source_evidence: string[]
  test_evidence: string[]
  recommendation: string
  severity: 'low' | 'info'
  confidence: Confidence
}

export interface AuditPlacementIssue {
  title: string
  line: number
  current_level: 'component' | 'e2e' | 'unknown'
  recommended_level: 'unit' | 'component' | 'e2e'
  reason: string
}

export interface AuditStandardsAssessment {
  section: string
  assessment: 'strong' | 'mixed' | 'weak' | 'not_assessed'
  positives: string[]
  concerns: string[]
}

export interface AuditPriority {
  rank: number
  action: string
  rationale: string
  related_finding_rules: string[]
}

export interface AuditExecution {
  complete: boolean
  global_map_source: 'ai' | 'checkpoint' | 'deterministic_fallback' | 'not_available'
  test_chunks_reviewed: number
  test_chunks_total: number
  source_context_files_reviewed: number
  ai_calls: number
  provider: string
  passes: string[]
  requested_model: string
  response_models: string[]
  requests: AiRequestTrace[]
  checkpoint_key: string | null
  reused_passes: string[]
  adaptive_recoveries: string[]
}

export interface AuditContextManifestEntry {
  path: string
  role: 'test' | 'related'
  status: 'complete' | 'truncated'
  original_characters: number
  supplied_characters: number
  targeted_excerpts: number
}

export interface AiTokenUsage {
  prompt_tokens: number | null
  completion_tokens: number | null
  reasoning_tokens: number | null
  total_tokens: number | null
  prompt_cache_hit_tokens: number | null
  prompt_cache_miss_tokens: number | null
}

export interface AiRequestTrace {
  operation: string
  attempt: number
  transport_attempt: number
  requested_model: string
  response_model: string | null
  max_tokens: number
  thinking: 'enabled' | 'disabled'
  reasoning_effort: 'high' | 'max' | null
  finish_reason: string | null
  duration_ms: number
  status: 'completed' | 'truncated' | 'schema_invalid' | 'api_error' | 'transport_error'
  provider: AiProviderId
  usage: AiTokenUsage
}

/** Backwards-compatible aliases for integrations importing the original names. */
export type DeepSeekTokenUsage = AiTokenUsage
export type DeepSeekRequestTrace = AiRequestTrace

export interface AuditDetails {
  overall_assessment: string
  metrics: AuditMetrics
  metric_locations: Record<AuditMetricName, number[]>
  strengths: AuditStrength[]
  standards_assessment: AuditStandardsAssessment[]
  coverage_gaps: AuditCoverageGap[]
  test_placement_issues: AuditPlacementIssue[]
  priorities: AuditPriority[]
  limitations: string[]
  context_actually_used: string[]
  context_manifest?: AuditContextManifestEntry[]
  execution: AuditExecution
}

export interface RelatedFile {
  path: string
  reason: string
  content: string
  truncated: boolean
  /** Original size before prompt-budget condensation. */
  original_character_count?: number
  /** Digest of the complete file, used to invalidate audit checkpoints safely. */
  full_content_hash?: string
  /** Local-only backing content. Prompt builders must expose only targeted excerpts. */
  full_content?: string
}

export interface TargetedSourceExcerpt {
  path: string
  symbol: string
  start_line: number
  end_line: number
  content: string
}

export interface ReviewContext {
  test_file: {
    path: string
    content: string
  }
  diff: string
  related_files: RelatedFile[]
  targeted_source_excerpts?: TargetedSourceExcerpt[]
}

export interface FileReview {
  file: string
  test_type: TestType
  status: 'pass' | 'fail' | 'error'
  summary: string
  findings: Finding[]
  context_files_used: string[]
  audit?: AuditDetails
  provider_requests?: AiRequestTrace[]
}

export interface SeveritySummary {
  critical: number
  high: number
  medium: number
  low: number
  info: number
}

export interface ReviewReport {
  status: 'completed' | 'completed_with_errors'
  base: string | null
  reviewed_files_count: number
  generated_at: string
  model: string | null
  provider: string | null
  mode: ReviewMode
  summary: SeveritySummary
  files: FileReview[]
  errors: string[]
}

export interface StandardsPaths {
  component: string
  e2e: string
}

export interface ContextLimits {
  maxRelatedFiles: number
  maxContextCharacters: number
  maxSingleFileCharacters: number
}
