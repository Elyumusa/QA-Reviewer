import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { severities, type Finding, type ReviewReport, type SeveritySummary } from './types.js'

export function summarize(findings: Finding[]): SeveritySummary {
  const summary: SeveritySummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  }
  for (const finding of findings) {
    summary[finding.severity] += 1
  }
  return summary
}

export function mergeFindings(deterministic: Finding[], ai: Finding[]): Finding[] {
  const merged = new Map<string, Finding>()
  for (const finding of deterministic) {
    merged.set(`${finding.rule}:${finding.line}:${finding.category}`, finding)
  }
  for (const finding of ai) {
    const key = `${finding.rule}:${finding.line}:${finding.category}`
    const existing = merged.get(key)
    if (!existing || finding.replacement_code || !existing.replacement_code) {
      merged.set(key, finding)
    }
  }

  const severityOrder = new Map(severities.map((severity, index) => [severity, index]))
  return [...merged.values()].sort((left, right) =>
    (severityOrder.get(left.severity) ?? 99) - (severityOrder.get(right.severity) ?? 99) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule),
  )
}

export function terminalReport(report: ReviewReport): string {
  const lines = [
    'Cypress AI Quality Reviewer',
    '',
    `Mode: ${report.mode}`,
    `AI provider: ${report.provider ?? 'none (deterministic checks only)'}`,
    `Requested model: ${report.model ?? 'none (deterministic checks only)'}`,
    `Changed Cypress files reviewed: ${report.reviewed_files_count}`,
  ]

  for (const file of report.files) {
    lines.push('', file.file)
    if (file.status === 'error') {
      lines.push(`  ERROR: ${file.summary}`)
    } else if (file.findings.length === 0) {
      lines.push('  PASS: No issues found')
    } else {
      for (const finding of file.findings) {
        const category = finding.category === 'potential_coverage_gap' ? ' [potential coverage gap]' : ''
        lines.push(`  ${finding.severity.toUpperCase()}: ${finding.rule} - ${finding.title} at line ${finding.line}${category}`)
      }
    }
    if (file.audit) {
      lines.push(`  Audit requests: ${file.audit.execution.ai_calls}; API response model(s): ${file.audit.execution.response_models.join(', ') || 'not reported'}`)
    }
  }

  lines.push(
    '',
    'Summary:',
    `  Critical: ${report.summary.critical}`,
    `  High: ${report.summary.high}`,
    `  Medium: ${report.summary.medium}`,
    `  Low: ${report.summary.low}`,
    `  Info: ${report.summary.info}`,
  )

  if (report.errors.length > 0) {
    lines.push('', `Errors: ${report.errors.length}`)
  }
  return lines.join('\n')
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

export function markdownReport(report: ReviewReport): string {
  const lines = [
    '# Cypress AI Quality Review',
    '',
    `- Status: ${report.status}`,
    `- Base: ${report.base ?? 'manual file review'}`,
    `- Files reviewed: ${report.reviewed_files_count}`,
    `- AI provider: ${report.provider ?? 'none (deterministic checks only)'}`,
    `- Model: ${report.model ?? 'deterministic checks only'}`,
    `- AI provider: ${report.provider ?? 'deterministic checks only'}`,
    `- Mode: ${report.mode}`,
    '',
    '| Critical | High | Medium | Low | Info |',
    '|---:|---:|---:|---:|---:|',
    `| ${report.summary.critical} | ${report.summary.high} | ${report.summary.medium} | ${report.summary.low} | ${report.summary.info} |`,
  ]

  for (const file of report.files) {
    lines.push('', `## ${file.file}`, '', file.summary)
    if (file.audit) {
      const audit = file.audit
      lines.push('', '### Overall assessment', '', audit.overall_assessment)
      lines.push(
        '',
        '### Deterministic inventory',
        '',
        '| Metric | Count | Representative lines |',
        '|---|---:|---|',
      )
      for (const [name, count] of Object.entries(audit.metrics)) {
        const metric = name as keyof typeof audit.metric_locations
        const metricLines = audit.metric_locations[metric]
        lines.push(`| ${name.replaceAll('_', ' ')} | ${count} | ${metricLines.slice(0, 12).join(', ')}${metricLines.length > 12 ? ', …' : ''} |`)
      }

      lines.push('', '### What was done well')
      if (audit.strengths.length === 0) lines.push('', 'No supported strengths were returned.')
      for (const strength of audit.strengths) {
        lines.push(
          '',
          `#### ${strength.title}`,
          '',
          strength.description,
          '',
          `- Evidence lines: ${strength.evidence_lines.join(', ') || 'not available'}`,
          `- Standards: ${strength.standards_references.join('; ') || 'not specified'}`,
          `- Why it matters: ${strength.why_it_matters}`,
          `- Confidence: ${strength.confidence}`,
        )
      }

      lines.push('', '### Findings')
      if (file.findings.length === 0) lines.push('', 'No supported issues were found.')
      for (const finding of file.findings) {
        const location = finding.end_line && finding.end_line !== finding.line
          ? `${finding.line}-${finding.end_line}`
          : String(finding.line)
        lines.push(
          '',
          `#### ${finding.severity.toUpperCase()} — ${finding.title}`,
          '',
          `- Rule: ${finding.rule}`,
          `- Lines: ${location}${finding.related_locations?.length ? `; related: ${finding.related_locations.join(', ')}` : ''}`,
          `- Confidence: ${finding.confidence}`,
          `- Standards: ${finding.standards_references?.join('; ') || 'not specified'}`,
          '',
          finding.message,
        )
        if (finding.impact) lines.push('', `Impact: ${finding.impact}`)
        if (finding.evidence?.length) lines.push('', ...finding.evidence.map(evidence => `- Evidence: ${evidence}`))
        lines.push('', `Recommendation: ${finding.suggestion}`)
        if (finding.replacement_code) lines.push('', '```ts', finding.replacement_code, '```')
      }

      lines.push(
        '',
        '### Standards assessment',
        '',
        '| Standards area | Assessment | Positives | Concerns |',
        '|---|---|---|---|',
      )
      for (const assessment of audit.standards_assessment) {
        lines.push(`| ${escapeCell(assessment.section)} | ${assessment.assessment} | ${escapeCell(assessment.positives.join('; '))} | ${escapeCell(assessment.concerns.join('; '))} |`)
      }

      lines.push('', '### Coverage gaps')
      if (audit.coverage_gaps.length === 0) lines.push('', 'No supported coverage gaps were identified from the available source context.')
      for (const gap of audit.coverage_gaps) {
        lines.push(
          '',
          `#### ${gap.area}`,
          '',
          gap.description,
          '',
          `- Source evidence: ${gap.source_evidence.join('; ') || 'not available'}`,
          `- Test evidence: ${gap.test_evidence.join('; ') || 'not available'}`,
          `- Recommendation: ${gap.recommendation}`,
          `- Severity/confidence: ${gap.severity}/${gap.confidence}`,
        )
      }

      lines.push('', '### Test-level placement')
      if (audit.test_placement_issues.length === 0) lines.push('', 'No test-placement issues were identified.')
      for (const issue of audit.test_placement_issues) {
        lines.push('', `- **${issue.title}** (line ${issue.line}): move from ${issue.current_level} to ${issue.recommended_level}. ${issue.reason}`)
      }

      lines.push('', '### Recommended priority')
      for (const priority of audit.priorities) {
        lines.push('', `${priority.rank}. ${priority.action} — ${priority.rationale}${priority.related_finding_rules.length ? ` (${priority.related_finding_rules.join(', ')})` : ''}`)
      }

      lines.push('', '### Audit limitations')
      if (audit.limitations.length === 0) lines.push('', 'No material limitations were reported.')
      else lines.push('', ...audit.limitations.map(limitation => `- ${limitation}`))
      lines.push(
        '',
        `Audit mechanics: ${audit.execution.test_chunks_reviewed} test chunks, ${audit.execution.source_context_files_reviewed} related context files, ${audit.execution.ai_calls} API request(s). Provider: ${audit.execution.provider}. Requested model: ${audit.execution.requested_model}. API response model(s): ${audit.execution.response_models.join(', ') || 'not reported'}. Reused passes: ${audit.execution.reused_passes.join(', ') || 'none'}.`,
      )
      if (audit.execution.requests.length > 0) {
        lines.push(
          '',
          '#### Provider request diagnostics',
          '',
          '| Operation | Schema / transport attempt | Thinking | Requested | Returned | Max output | Finish | Prompt | Completion | Reasoning | Duration |',
          '|---|---:|---|---|---|---:|---|---:|---:|---:|---:|',
        )
        for (const request of audit.execution.requests) {
          lines.push(`| ${escapeCell(request.operation)} | ${request.attempt} / ${request.transport_attempt} | ${request.thinking}${request.reasoning_effort ? `/${request.reasoning_effort}` : ''} | ${request.requested_model} | ${request.response_model ?? 'not reported'} | ${request.max_tokens} | ${request.finish_reason ?? request.status} | ${request.usage.prompt_tokens ?? 'n/a'} | ${request.usage.completion_tokens ?? 'n/a'} | ${request.usage.reasoning_tokens ?? 'n/a'} | ${request.duration_ms}ms |`)
        }
      }
    } else if (file.findings.length > 0) {
      lines.push(
        '',
        '| Severity | Rule | Line | Finding | Suggestion |',
        '|---|---|---:|---|---|',
      )
      for (const finding of file.findings) {
        lines.push(`| ${finding.severity.toUpperCase()} | ${escapeCell(finding.rule)} | ${finding.line} | ${escapeCell(finding.title)} | ${escapeCell(finding.suggestion)} |`)
        if (finding.replacement_code) {
          lines.push('', '```ts', finding.replacement_code, '```')
        }
      }
    }
    if (!file.audit && file.provider_requests?.length) {
      lines.push(
        '',
        '### Provider request diagnostics before failure',
        '',
        '| Operation | Schema / transport attempt | Thinking | Requested | Returned | Max output | Status | Prompt | Completion | Reasoning | Duration |',
        '|---|---:|---|---|---|---:|---|---:|---:|---:|---:|',
      )
      for (const request of file.provider_requests) {
        lines.push(`| ${escapeCell(request.operation)} | ${request.attempt} / ${request.transport_attempt} | ${request.thinking}${request.reasoning_effort ? `/${request.reasoning_effort}` : ''} | ${request.requested_model} | ${request.response_model ?? 'not reported'} | ${request.max_tokens} | ${request.finish_reason ?? request.status} | ${request.usage.prompt_tokens ?? 'n/a'} | ${request.usage.completion_tokens ?? 'n/a'} | ${request.usage.reasoning_tokens ?? 'n/a'} | ${request.duration_ms}ms |`)
      }
    }
    if (file.context_files_used.length > 0) {
      lines.push('', `Context used: ${file.context_files_used.join(', ')}`)
    }
  }

  if (report.errors.length > 0) {
    lines.push('', '## Errors', '', ...report.errors.map(error => `- ${error}`))
  }
  return `${lines.join('\n')}\n`
}

async function writeOutput(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

export async function writeJsonReport(filePath: string, report: ReviewReport): Promise<void> {
  await writeOutput(filePath, `${JSON.stringify(report, null, 2)}\n`)
}

export async function writeMarkdownReport(filePath: string, report: ReviewReport): Promise<void> {
  await writeOutput(filePath, markdownReport(report))
}

export function markdownPathFor(outputPath: string): string {
  return path.extname(outputPath).toLowerCase() === '.json'
    ? outputPath.slice(0, -5) + '.md'
    : `${outputPath}.md`
}

export function jsonPathFor(outputPath: string): string {
  return path.extname(outputPath).toLowerCase() === '.md'
    ? outputPath.slice(0, -3) + '.json'
    : outputPath
}
