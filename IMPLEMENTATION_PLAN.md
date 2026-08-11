# Cypress AI Quality Reviewer — Merged Implementation Plan

This document merges the original implementation plan with all amendments from “Additions to Cypress AI Quality Reviewer Implementation Plan.” Where they differed, the amendments take precedence.

## Objective

Build a focused TypeScript CLI for the Levelbuild WebApp that reviews the quality of changed Cypress component and E2E tests. Existing CI already executes Cypress, so this tool reviews written test quality only.

Primary command:

```bash
qa-review --base origin/main --output qa-review-results.json
```

The reviewer must produce standards-based, actionable findings, terminal output, a JSON report, and optional Markdown. Findings are advisory by default.

## Project-specific sources of truth

The existing documents are referenced directly rather than copied:

- Component: `WebAppComponents/ClientApp/src/components/COMPONENT_TESTING_STANDARDS.md`
- E2E: `WebAppTests/EndToEnd/TESTING_STANDARDS.md`

Known test layouts:

- Component tests: `WebAppComponents/ClientApp/src/components/**/*.cy.ts`
- E2E tests: `WebAppTests/EndToEnd/cypress/e2e/**/*.cy.ts`

Representative examples used during design:

- `WebAppComponents/ClientApp/src/components/inputs/address/Address.cy.ts`
- `WebAppTests/EndToEnd/cypress/e2e/zip-viewer/ZipViewer.cy.ts`

## MVP behavior

### File selection

- `--base <ref>` uses `git diff --name-only --diff-filter=ACMR <ref>...HEAD`.
- `--files <paths...>` supports explicit local review.
- Deleted and missing files are ignored.
- Review `*.cy.*`, `*.spec.*`, and script files under `cypress/e2e`.
- No matching files is a successful no-op.

### Classification

- Component paths map to the component standards.
- `cypress/e2e` and the WebApp E2E project map to the E2E standards.
- Unknown Cypress layouts load both standards.

### Deterministic checks

Keep the rule set deliberately small:

| Rule | Pattern | Severity |
|---|---|---|
| `CYPRESS-FOCUS-001` | `describe.only`, `it.only`, `context.only` | critical |
| `CYPRESS-ASYNC-001` | `cy.wait(number)` | high |
| `CYPRESS-SKIP-001` | `describe.skip`, `it.skip`, `context.skip` | medium |

These findings share the AI finding schema. No AST or general-purpose rule engine is part of the MVP.

### Bounded context collection

Always include the complete test. Include its Git diff when available, then collect candidates in this order:

1. Local imports
2. Referenced `cy.fixture(...)` files
3. Cypress `commands.ts`, `e2e.ts`, or `component.ts`
4. Source files whose filenames match meaningful terms from the test name

Defaults:

- Maximum related files: 5
- Maximum additional diff/related context: 50,000 characters (the mandatory complete test is excluded from this cap)
- Maximum single related file: 12,000 characters

The diff may consume at most half of the additional context budget so related implementation context is still available for large changed specs.

Large related files are condensed around imports, exports, matching names, and nearby lines. Context discovery is best effort and never expands into repository-wide semantic indexing.

### AI review

Use the DeepSeek Chat Completions API with JSON Object output and strict local runtime schema validation. The request contains:

- File path and classified type
- Applicable standards
- Complete test content
- Git diff
- Bounded related context with inclusion reasons
- Deterministic findings already discovered

The DeepSeek adapter implements a small provider-neutral `ReviewProvider` interface so another provider can be added later without changing Git detection, context collection, standards loading, finding contracts, or reporting. Provider selection is not part of this MVP.

The prompt must require evidence-based findings, forbid invented selectors/routes/endpoints/fixtures, and prefer a small number of strong findings. An invalid response is retried once with a stricter JSON instruction. A second invalid response becomes a per-file error while remaining files continue.

### Concrete recommendations

Every finding contains:

```text
line
severity
rule
category
title
message
suggestion
replacement_code
specific_cypress_methods
context_used
confidence
source
```

Suggestions must be tied to the actual scenario. `replacement_code` is nullable: when exact selectors, endpoints, routes, aliases, fixtures, or expected behavior are not proven by context, the reviewer states what is missing instead of inventing code.

For numeric waits, the AI should attempt an exact `cy.intercept(...)`, named alias, `cy.wait('@alias')`, and final observable assertion only when the context supports each detail.

### Feature coverage feedback

Coverage feedback is lightweight and cautious:

- Use category `potential_coverage_gap`.
- Require supporting source/context evidence.
- Phrase incomplete evidence as a potential gap.
- Keep severity at low or info.
- Never block CI because of a coverage finding.

### Output

The terminal lists findings by file and severity totals. JSON is machine readable and includes:

- Completion state, base, timestamp, and model
- Per-severity totals
- Per-file type, status, summary, findings, and context paths
- Tool/API errors separate from findings

Markdown is optional and contains the same actionable summary and replacement snippets.

### Exit behavior

- `0`: completed review, even with critical/high findings
- `1`: system/tool failure (Git, standards, credentials, API, schema validation, or output)

No secret may be printed. The API key is sent only through Bearer authentication.

## CI integration

Add an independent GitLab merge-request job that:

- Runs only when Cypress tests change and `DEEPSEEK_API_KEY` is configured
- Uses the merge request diff base SHA
- Does not execute Cypress
- Uploads JSON and Markdown reports as artifacts
- Remains advisory for findings while failing on reviewer malfunction

## Acceptance criteria

- [x] TypeScript package integrates with the WebApp repository.
- [x] Changed/manual Cypress file detection and project-specific classification are implemented.
- [x] Existing standards are loaded by test type; unknown types use both.
- [x] Three MVP deterministic rules emit the shared finding format.
- [x] Context includes diff, imports, fixtures, support files, and bounded source matches.
- [x] DeepSeek JSON output is validated against the exact finding schema, including concrete/nullable replacement code and context used.
- [x] Invalid AI output retries once and per-file errors do not stop later files.
- [x] Coverage feedback is explicitly potential/advisory.
- [x] Terminal, JSON, and Markdown output are supported.
- [x] Findings are non-blocking; system errors return non-zero.
- [x] GitLab CI integration and report artifacts are defined.
- [ ] Validate a live model response after `DEEPSEEK_API_KEY` is supplied.

## Explicitly out of scope

- Cypress test execution
- Dashboard, database, or historical analytics
- PR inline comments
- Automatic source/test modification
- Full repository indexing
- Semantic search
- Large deterministic rule engine
- Coverage execution or coverage dashboard
- Blocking severity gates
- Multi-model evaluation

## Audit-mode amendment

The original focused MVP remains the default CI path. A later user-requested amendment adds an opt-in `--mode audit` workflow for comprehensive reviews comparable to a senior-engineer/Codex analysis.

Audit mode adds:

- A deterministic suite inventory with counts and evidence lines.
- TypeScript-AST semantic chunks that preserve complete suites/tests and carry shared imports, helpers, hooks, and outer setup; overlapping line windows are only the oversized-suite fallback.
- A global full-file structure map before local chunk analysis.
- A separate production-source and coverage cross-check.
- A final evidence synthesis pass that consolidates repetition and prioritizes improvements.
- Content-addressed checkpoints for completed global, chunk, and coverage passes.
- A non-thinking synthesis retry, targeted JSON repair, and safe recovery of redundant presentation fields.
- Rich typed output for strengths, detailed findings, standards assessments, coverage gaps, test-level placement, priorities, limitations, and execution metadata.
- Larger but still bounded context limits and bounded chunk concurrency.
- Strict explicit-file validation with regular-file and resolved-path repository checks.
- Working-tree-aware Git discovery covering committed, staged, unstaged, and untracked Cypress tests.
- AI configuration and report-destination preflight before provider work.
- Focused and audit provider diagnostics for failed requests.
- Provider, endpoint, and audit-pipeline revision in checkpoint identity to prevent stale evidence reuse.

This is a controlled agentic workflow, not an unrestricted recursive agent. It has a fixed pass graph, validates every model response, restricts context to files collected inside the repository, and records the number of requests used. Tool-calling repository exploration and autonomous file modification remain out of scope.
