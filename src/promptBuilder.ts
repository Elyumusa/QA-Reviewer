import type { Finding, ReviewContext, TestType } from './types.js'
import { aiReviewJsonSchema } from './responseSchema.js'

export const reviewerInstructions = `You are the Cypress AI Quality Reviewer for the Levelbuild WebApp.

Review only the provided Cypress test against the provided internal standards and repository context.

Rules:
- Report only issues supported by the test code and standards. Do not invent application context.
- Do not complain about general style unless it violates a provided standard.
- Prefer fewer, higher-confidence findings over speculative feedback.
- Use the changed-file diff to focus attention, but review the complete test when a file-level issue matters.
- Give concrete, scenario-specific suggestions. Use exact selectors, aliases, endpoints, routes, custom commands, and fixtures only when they appear in the provided context.
- Never invent an endpoint, selector, route, alias, fixture, variable, or expected response.
- If exact replacement code is not supported by context, set replacement_code to null and state exactly which context is missing.
- For a fixed cy.wait(number), attempt to provide the exact cy.intercept(...), alias, cy.wait('@alias'), and final observable assertion only when the context proves those values.
- Use category "potential_coverage_gap" only for coverage feedback supported by source context. Phrase it as a potential gap and use low or info severity.
- Use category "quality" for standards violations.
- Every finding must point to a real 1-based line in the test file.
- Do not repeat a deterministic finding already provided unless you can add materially more specific, context-supported replacement code. If you do, use the same rule and line so it can be merged.
- Return JSON matching the supplied schema and nothing else.`

function section(name: string, content: string): string {
  return `<${name}>\n${content}\n</${name}>`
}

export function buildReviewInput(
  testType: TestType,
  standards: string,
  context: ReviewContext,
  deterministicFindings: Finding[],
  retry = false,
): string {
  const related = context.related_files.length === 0
    ? 'No related files were found.'
    : context.related_files
        .map(file => [
          `FILE: ${file.path}`,
          `REASON: ${file.reason}`,
          `TRUNCATED: ${file.truncated}`,
          file.content,
        ].join('\n'))
        .join('\n\n--- RELATED FILE ---\n\n')

  const retryInstruction = retry
    ? '\nThe previous response was invalid. Return one complete JSON object that exactly matches the schema. Do not use Markdown fences.'
    : ''

  return [
    `File: ${context.test_file.path}`,
    `Test type: ${testType}`,
    retryInstruction,
    section('standards', standards),
    section('test_file', context.test_file.content),
    section('git_diff', context.diff || 'No diff was available (manual file review or empty diff).'),
    section('related_context', related),
    section('deterministic_findings', JSON.stringify(deterministicFindings, null, 2)),
    section('required_json_schema', JSON.stringify(aiReviewJsonSchema, null, 2)),
  ].join('\n\n')
}
