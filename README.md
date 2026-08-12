# Cypress AI Quality Reviewer

`qa-review` is a command-line quality reviewer for the Levelbuild WebApp Cypress tests. It checks component and E2E tests against the standards already maintained in the WebApp repository, adds deterministic Cypress checks, and can ask an AI provider for a focused review or a detailed multi-pass audit.

The reviewer is advisory. It does not execute Cypress, change your files, apply suggestions, or replace a human code review.

## Requirements

- Node.js 20 or newer
- Git
- A checkout of the Levelbuild WebApp repository
- A DeepSeek, OpenAI, or Anthropic API key for AI review

The tool must be run with the WebApp checkout as its working directory, or from a subdirectory inside that checkout. It uses the repository root to find changed files, source context, fixtures, Cypress support files, and the project standards when they are available:

- Component tests: `WebAppComponents/ClientApp/src/components/COMPONENT_TESTING_STANDARDS.md`
- E2E tests: `WebAppTests/EndToEnd/TESTING_STANDARDS.md`

The package also carries copies of both standards in its `standards/` directory. The WebApp copy is preferred so project-specific updates are respected; if a standards file is absent, the bundled copy is used automatically. This makes the reviewer usable from a standalone install without requiring the WebApp repository to carry those documents.

## Installation

### Install from GitHub

Install it as a development dependency from the WebApp checkout:

```bash
cd /path/to/WebApp
npm install --save-dev git+https://github.com/Elyumusa/QA-Reviewer.git#v0.1.4
```

Then run the installed command from the WebApp root:

```bash
npx qa-review --help
```

The package builds its TypeScript CLI during installation. The compiled `qa-review` executable is exposed through the package `bin` entry.

To upgrade an earlier GitHub installation to the standards-grounded recommendation release, run the same command with `#v0.1.4`; this updates the commit pinned in `package-lock.json`.

### Use a local checkout

This is useful while developing or testing a new version of the reviewer:

```bash
git clone https://github.com/Elyumusa/QA-Reviewer.git
cd QA-Reviewer
npm ci
npm test
npm run typecheck
npm run build
```

Run the built CLI from the WebApp checkout:

```bash
cd /path/to/WebApp
node /path/to/QA-Reviewer/dist/src/cli.js --help
```

Alternatively, install the local checkout into WebApp with `npm install --save-dev /path/to/QA-Reviewer` and use `npx qa-review` from WebApp.

## Configure an AI provider

DeepSeek is the default provider for backwards compatibility. Select a provider with `--provider` or `QA_AI_PROVIDER`.

| Provider | Selection | Required environment variable | Default model |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.6-sol` |
| Claude | `anthropic` or `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |

Example DeepSeek setup:

```bash
export DEEPSEEK_API_KEY="your-deepseek-key"
```

Example OpenAI setup:

```bash
export OPENAI_API_KEY="your-openai-key"
```

Example Claude setup:

```bash
export ANTHROPIC_API_KEY="your-anthropic-key"
```

Optional provider variables:

| Provider | Model | Endpoint | Other |
| --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_MODEL` | `DEEPSEEK_API_URL` | — |
| OpenAI | `OPENAI_MODEL` | `OPENAI_API_URL` | — |
| Claude | `ANTHROPIC_MODEL` | `ANTHROPIC_API_URL` | `ANTHROPIC_VERSION` (defaults to `2023-06-01`) |

Endpoint overrides must be absolute `http://` or `https://` URLs implementing the selected provider’s API protocol. API keys are never printed in progress logs or written to reports.

If you are using only DeepSeek, you do not need to configure the OpenAI or Anthropic variables.

## Basic usage

All commands below are run from the WebApp repository root.

### Review changed Cypress files

The default focused mode reviews component/E2E Cypress files changed relative to `origin/main`:

```bash
npx qa-review --base origin/main
```

The change detector includes committed, staged, unstaged, and untracked reviewable Cypress files.

### Review explicit files

Explicit paths are useful when studying one test. They do not require a Git diff:

```bash
npx qa-review --files \
  WebAppComponents/ClientApp/src/components/inputs/address/Address.cy.ts \
  WebAppTests/EndToEnd/cypress/e2e/zip-viewer/ZipViewer.cy.ts
```

Every explicit path must exist, be a regular Cypress test file, and remain inside the repository. Typos, source files, support files, and paths outside the checkout fail clearly.

### Choose a provider

```bash
npx qa-review --provider deepseek --files path/to/Test.cy.ts
npx qa-review --provider openai --files path/to/Test.cy.ts
npx qa-review --provider claude --files path/to/Test.cy.ts
```

`--provider` takes precedence over `QA_AI_PROVIDER`. If neither is set, DeepSeek is selected.

### Run a detailed audit

Audit mode is intended for studying a test thoroughly. It reports what is strong, what is weak, standards alignment, coverage gaps, test-placement concerns, priorities, evidence lines, and limitations.

```bash
npx qa-review --provider deepseek \
  --mode audit \
  --files WebAppComponents/ClientApp/src/components/inputs/address/Address.cy.ts \
  --format both \
  --output address-audit.json
```

This writes:

- `address-audit.json`
- `address-audit.md`

Audit mode uses the correct standard automatically. Cypress specs anywhere under `WebAppComponents/ClientApp/src/` use the component standard; E2E paths use the E2E standard. Unknown layouts require both standards. For an unusual repository layout, use `--test-type component` or `--test-type e2e`.

### Run deterministic checks only

Focused mode can run without any API key:

```bash
npx qa-review \
  --deterministic-only \
  --files WebAppComponents/ClientApp/src/components/inputs/address/Address.cy.ts \
  --format both \
  --output deterministic-review.json
```

This checks the file locally for the deterministic rules and makes no AI request. `--deterministic-only` cannot be combined with `--mode audit`.

## Command options

Run `npx qa-review --help` to see the current help text. The options are:

| Option | Description | Default |
| --- | --- | --- |
| `--base <ref>` | Git base ref used to find changed tests and compute file diffs | `origin/main` |
| `--files <paths...>` | Explicit Cypress test paths; accepts multiple paths and comma-separated values | changed files |
| `--provider <name>` | `deepseek`, `openai`, `anthropic`, or the `claude` alias | `QA_AI_PROVIDER` or `deepseek` |
| `--test-type <component\|e2e>` | Override automatic test-type classification for all selected files | automatic |
| `--output <path>` | Output report path | `qa-review-results.json` |
| `--format <json\|markdown\|both>` | Report format | `json` |
| `--mode <focused\|audit>` | Concise CI review or comprehensive multi-pass audit | `focused` |
| `--deterministic-only` | Skip AI and run local deterministic checks | disabled |
| `--audit-chunk-lines <count>` | Approximate lines per semantic audit evidence chunk; minimum 100 | `700` |
| `--audit-concurrency <count>` | Number of parallel audit chunk requests; range 1–4 | `2` |
| `--transport-retries <count>` | Retries for recoverable connection, DNS, rate-limit, and server failures; range 0–3 | `2` |
| `--transport-retry-delay-ms <ms>` | Initial connection retry delay; DNS uses longer adaptive intervals | `2,000` |
| `--request-timeout-ms <ms>` | Total safety ceiling per provider request | `120,000` focused, `900,000` audit |
| `--connection-timeout-ms <ms>` | Maximum wait for response headers | `30,000` |
| `--stream-inactivity-timeout-ms <ms>` | Maximum silence after a streaming response begins | `90,000` |
| `--no-audit-cache` | Ignore and do not write reusable audit checkpoints | cache enabled |
| `--max-related-files <count>` | Maximum related context files per test | `5` focused, `8` audit |
| `--max-context-chars <count>` | Additional diff/context character budget | `50,000` focused, `180,000` audit |
| `--max-file-chars <count>` | Maximum characters from one related file | `12,000` focused, `100,000` audit |
| `--quiet` | Suppress progress and terminal summary | disabled |
| `--help` | Display usage information | disabled |

## Output and exit codes

JSON reports contain provider/model metadata, per-file status, findings, context files used, audit details, request diagnostics, and errors. Markdown reports provide the same information in a study-friendly format.

The process exits with:

- `0` when the review completed, even if findings were found
- `1` when the reviewer could not complete reliably, for example because of a missing key, invalid provider configuration, invalid file path, API failure, malformed model output after retries, or an invalid report destination

Findings are advisory and do not make the command fail by themselves.

## What happens during a review

Focused mode performs deterministic checks and one AI review using the complete test, applicable standards, Git diff, and bounded related context.

Audit mode performs a bounded sequence of passes:

1. Deterministic inventory of the test file.
2. Global full-file structure map.
3. Standards review over semantic test chunks.
4. Source and coverage cross-check.
5. Final evidence synthesis and prioritization.
6. Batched recommendation enrichment for the final findings, using exact repository windows, relevant internal-standard sections, and only official Cypress links already allowlisted by those standards.

The CLI prints progress while the work is running, including the current pass, retries, provider, model, duration, stream activity, and token usage. DeepSeek uses SSE streaming so long reasoning responses and keep-alives continuously move data over the connection. The client separates connection, stream-inactivity, and total safety timeouts instead of aborting every active stream after one fixed duration.

Parseable schema-invalid global maps receive a small non-thinking repair containing only the invalid object, validation error, and schema. If the global AI map remains unavailable, a conservative deterministic suite/test map lets standards chunks continue and the report records the fallback as a limitation. If a semantic chunk still fails with a transport error, the reviewer splits only that region into smaller overlapping chunks and reviews those recovery chunks with thinking disabled and a smaller output allowance. Completed recovery work is checkpointed under the repository-root `.qa-review-cache/`. If a required pass ultimately fails, the report retains deterministic findings and completed chunk evidence, marks the audit incomplete, and exits `1` instead of returning an empty result. Use `--no-audit-cache` for a clean run.

The final audit report is bounded to 30 synthesized findings so it remains usable. If a provider returns more, the reviewer validates every item and every source line first, merges exact rule/title repeats, and retains the strongest 30 using severity, confidence, evidence, and recurrence. The report records the original and retained counts in its limitations. A presentation-count overflow therefore does not turn an otherwise complete audit into an error.

After synthesis, audit mode improves recommendations in batches of at most ten findings. Internal standards remain the policy source; official Cypress pages linked by those standards are supporting authority. Each recommendation receives the exact faulty code window, matching test helpers, and matching related-source windows. Returned snippets are labelled `exact`, `illustrative`, or `unavailable`. Exact snippets are checked for valid TypeScript and for repository-specific selectors, aliases, endpoints, and expected strings before they are accepted. A provider failure in this optional enrichment stage preserves the completed audit's original validated recommendation and records a limitation instead of discarding the audit.

An enriched Markdown finding resembles:

```text
Recommendation: Remove the conditional production-method call and assert the rendered fallback title after the existing failed request completes.
Recommendation code: exact
```

```ts
cy.wait('@getUserInfoError')
    .its('response.statusCode')
    .should('eq', 500)

cy.get('@chatbot')
    .shadow()
    .find('.chat-title-text')
    .should('contain.text', 'User')
```

The report then lists the applicable internal-standard heading and clickable allowlisted Cypress guidance. The reviewer never browses documentation during an audit.

## Troubleshooting

### `Missing DEEPSEEK_API_KEY` / `Missing OPENAI_API_KEY` / `Missing ANTHROPIC_API_KEY`

Set the key for the selected provider, or run focused deterministic mode:

```bash
npx qa-review --deterministic-only --files path/to/Test.cy.ts
```

### The command says it cannot determine the Git repository root

Change directory to the WebApp checkout and run the command again. The reviewer needs Git to discover files and context.

### Which standards are used?

The reviewer classifies each Cypress file automatically. Component specs under `WebAppComponents/ClientApp/src/` use the component standard, E2E specs use the E2E standard, and unknown layouts use both. A project standards file wins when present; the matching bundled standard is the fallback when it is absent. Use `--test-type` when a custom path cannot be inferred safely.

### The command reports an invalid explicit file

Use a repository-relative path to a `.cy.*` or `.spec.*` Cypress test file. Do not pass a component source file, Cypress support file, fixture, directory, or path outside the checkout.

### The API rejects the key, model, or endpoint

Confirm that the provider selection matches the key, the model is available to that account, and any endpoint override implements that provider’s API. Permanent client/authentication errors are not retried. Rate limits and temporary 5xx responses receive bounded retries, including `Retry-After` when supplied.

### A large audit is slow or reaches a token limit

This is expected for a large test. The audit uses semantic chunks, bounded concurrency, larger retry allowances, and checkpoint reuse. Reduce `--audit-concurrency` for provider rate limits or use focused mode for a quicker review.

### `ECONNRESET`, `UND_ERR_SOCKET`, or a request timeout

These mean the provider connection ended before a complete response arrived. DeepSeek streaming, activity-aware timeouts, two default retries, exponential backoff, and failed-chunk subdivision are automatic. DNS failures use longer 5/15/30-second intervals when three retries are selected with the default base delay. If the provider remains unstable, try `--audit-concurrency 1`, increase `--transport-retries` up to `3`, or rerun later; completed checkpoints and partial evidence are preserved.

## CI usage

The WebApp integration is intentionally disabled for now. The reviewer is a local, opt-in tool for the tester running it and does not run merely because an API key exists in CI. The retained GitLab job is guarded by `QA_REVIEW_CI_ENABLED=true` for a future approval; until that decision is made, run reviews locally from the WebApp checkout.

Store provider keys as masked/protected variables if CI is enabled later. Never commit them to the WebApp or reviewer repository.

## Development and verification

From the QualityReviewer checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The test suite uses mocked provider responses and does not require paid OpenAI, Anthropic, or DeepSeek calls.

## Additional documentation

- [Provider guide](./PROVIDER_GUIDE.md) — provider configuration and limitations
- [Audit mode guide](./AUDIT_MODE_GUIDE.md) — audit passes and report contract
- [Architecture guide](./REVIEWER_ARCHITECTURE_GUIDE.md) — implementation study reference
