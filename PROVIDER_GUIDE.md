# AI Provider Guide

The Cypress AI Quality Reviewer supports DeepSeek, OpenAI, and Anthropic Claude through one provider-neutral TypeScript pipeline. Provider selection changes the HTTP request and model. It does not change file discovery, Cypress classification, standards selection, deterministic checks, context collection, audit passes, runtime schemas, report structure, or exit-code policy.

## Quick setup

Choose exactly one provider for a run:

```bash
# DeepSeek (backwards-compatible default)
export DEEPSEEK_API_KEY="..."
npm run qa-review -- --provider deepseek --files path/to/Test.cy.ts

# OpenAI
export OPENAI_API_KEY="..."
npm run qa-review -- --provider openai --files path/to/Test.cy.ts

# Claude
export ANTHROPIC_API_KEY="..."
npm run qa-review -- --provider anthropic --files path/to/Test.cy.ts
```

`--provider claude` is an alias for `--provider anthropic`. `--provider` takes precedence over `QA_AI_PROVIDER`; when neither is set, the reviewer uses `deepseek` so existing commands continue to work.

The selected provider is recorded in the top-level report and in every request trace. The selected model, the model reported by the API, token usage, finish/stop reason, duration, schema attempt, and transport attempt are also recorded. API keys are never recorded.

## Configuration

| Provider | Key | Model override | Endpoint override | Default |
| --- | --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `DEEPSEEK_API_URL` | `deepseek-v4-pro` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `OPENAI_API_URL` | `gpt-5.6-sol` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `ANTHROPIC_API_URL` | `claude-sonnet-5` |

Anthropic also accepts `ANTHROPIC_VERSION`; it defaults to `2023-06-01`, the required version header used by the Messages API.

Endpoint overrides must be absolute HTTP(S) URLs. They are intended for vendor-compatible company gateways and test doubles. An override must implement the selected vendor's protocol; selecting `openai` does not make an arbitrary endpoint OpenAI-compatible.

Examples:

```bash
QA_AI_PROVIDER=openai \
OPENAI_API_KEY="..." \
OPENAI_MODEL="gpt-5.6-sol" \
npm run qa-review -- --mode audit --files path/to/Test.cy.ts

ANTHROPIC_API_KEY="..." \
ANTHROPIC_MODEL="claude-opus-5" \
npm run qa-review -- --provider claude --mode audit --files path/to/Test.cy.ts
```

## Architecture

```text
CLI/provider selection
        |
        v
resolveAiConfiguration
        |
        v
AiProviderAdapter -------------------------------+
        |                                        |
        | vendor request/response translation    |
        v                                        |
AiJsonClient                                     |
  - timeout and heartbeat                        |
  - SSE streaming when the adapter supports it   |
  - exponential bounded transport retry          |
  - truncation and refusal handling              |
  - JSON parse and schema retry                  |
  - targeted schema repair                       |
  - request traces                               |
        |                                        |
        +--> AiReviewer (focused)                 |
        +--> AiAuditReviewer (multi-pass)         |
                  |                              |
                  +--> runtime validators <------+
                  +--> provider-neutral reports
```

`AiProviderAdapter` is deliberately small. An adapter declares its ID, requested model, endpoint, request builder, response normalizer, and API-error extractor. It does not decide what a good Cypress test is. `AiJsonClient` does not know vendor headers or response shapes. This separation prevents provider changes from leaking into audit reasoning or output contracts.

The original `DeepSeekJsonClient`, `DeepSeekReviewer`, and `DeepSeekAuditReviewer` exports remain as compatibility wrappers. The CLI uses the provider-neutral classes.

## Provider mechanics

### DeepSeek

DeepSeek uses `POST /chat/completions`, Bearer authentication, `system` and `user` messages, `max_tokens`, thinking controls, and JSON Object mode. It requests SSE streaming and reconstructs the final JSON from `content` deltas while ignoring private reasoning deltas. The final usage event supplies prompt, completion, reasoning, and cache-token telemetry. Streaming keeps long-running reasoning requests active at the HTTP layer and a reset during the stream safely retries the complete stateless request.

### OpenAI

OpenAI uses `POST /v1/chat/completions`, Bearer authentication, a `developer` instruction message plus a `user` message, `max_completion_tokens`, optional reasoning effort, and JSON Object mode. The prompt includes the exact schema and the same local validator used for every provider is authoritative.

The default is the current coding-oriented `gpt-5.6-sol` model. A teammate may set `OPENAI_MODEL`, but the chosen model must support Chat Completions and JSON Object response format. If it does not, OpenAI returns an API error and the reviewer writes that error to the report instead of silently changing behavior.

### Anthropic Claude

Claude uses `POST /v1/messages`, `x-api-key`, `anthropic-version`, a top-level `system` prompt, `user` messages, and `max_tokens`. Audit effort maps to `output_config.effort`; a non-thinking schema-repair pass uses low effort.

Claude receives the exact requested JSON Schema through `output_config.format`. Text is extracted from text content blocks, while non-text thinking blocks are ignored. `max_tokens` and `model_context_window_exceeded` stop reasons are normalized as truncation. A `refusal` stop reason is treated as an API-level failure rather than accepted as review JSON.

The default `claude-sonnet-5` model provides the speed/capability balance intended for these large audit prompts. A custom `ANTHROPIC_MODEL` must support Messages and structured outputs.

## What remains identical across providers

Every run still:

1. Resolves the Git repository and validates explicit files.
2. Classifies a test as component or E2E and loads the matching WebApp standard, falling back to the copy bundled in the package when the project file is absent.
3. Collects bounded source/support/fixture context.
4. Runs deterministic checks.
5. Runs focused review or the same global-map, semantic-chunk, coverage, and synthesis audit passes.
6. Parses JSON and validates every field with the local TypeScript schema.
7. Retries malformed/truncated output under the same bounded policy.
8. Writes the same JSON and Markdown report shapes.

Switching providers does not bypass standards. Component tests still use `COMPONENT_TESTING_STANDARDS.md`; E2E tests still use `TESTING_STANDARDS.md`.

## Errors and edge cases

- Unknown provider: configuration fails before any model request.
- Missing key: the report names the exact required variable, such as `Missing OPENAI_API_KEY`.
- Empty model: preflight fails instead of sending an ambiguous request.
- Malformed/non-HTTP endpoint: preflight fails before paid work.
- Wrong or expired key: the vendor's HTTP error is written to the file error and request diagnostics; authentication failures are not retried.
- Rate limit or unsupported model: treated as an HTTP/API failure and not blindly retried.
- Socket/connect reset: two retries are attempted by default, using exponential delays of 2 and 4 seconds. DNS failures use longer adaptive intervals (5/15/30 seconds with three retries and the default base delay). Timeouts receive one same-request retry before the audit chooses a smaller or fallback strategy.
- HTTP 429 and temporary 500/502/503/504 responses are retried; `Retry-After` is honored up to 60 seconds. Permanent 4xx responses, including invalid credentials or request parameters, fail immediately.
- DeepSeek streaming uses a 30-second header timeout, 90-second inactivity timeout that resets on every received byte, and a 15-minute audit safety ceiling. All three limits have CLI overrides.
- A parseable malformed global map is repaired without resending the original source prompt. If no valid AI map can be recovered, deterministic suite/test inventory lets chunk review continue with an explicit report limitation.
- Repeated standards-chunk transport failure: only that semantic region is subdivided, recovery chunks use non-thinking mode and smaller output limits, and their results are checkpointed.
- Token limit: the logical pass retries once with the configured larger allowance.
- Invalid JSON/schema: the logical pass performs the existing correction or targeted-repair path.
- Vendor refusal: rejected; it cannot become a successful audit.
- Exhausted recovery: the file is marked incomplete, exits `1`, and retains deterministic findings plus completed AI evidence and diagnostics.
- No key desired: `--deterministic-only` works in focused mode and makes no provider request.

Checkpoint identity includes provider, model, endpoint, pipeline revision, source, context, standards, and chunk configuration. Changing from DeepSeek to Claude therefore cannot reuse DeepSeek evidence checkpoints.

## GitLab CI

The WebApp merge-request job is disabled while the reviewer is being approved. If the retained job is enabled later, it requires `QA_REVIEW_CI_ENABLED=true` in addition to the normal change and provider-key conditions. If `QA_AI_PROVIDER` is set, the CLI uses it; otherwise the job chooses the available key in DeepSeek → OpenAI → Anthropic order. Set `QA_AI_PROVIDER` whenever CI stores more than one key so provider choice is unambiguous.

## Adding another provider later

Adding a fourth provider requires:

1. Add its ID to `aiProviders` in `src/types.ts`.
2. Implement `AiProviderAdapter` request building, response normalization, token usage, truncation, refusal, and API error extraction.
3. Add key/model/endpoint preflight in `src/aiConfig.ts`.
4. Add it to `--provider` help and validation.
5. Add mocked request/response/error/truncation tests.
6. Document model capability requirements.

No changes should be needed in file discovery, standards loading, context collection, prompt builders, audit inventory/chunking, runtime validators, checkpoint storage, or report writers.

## Relevant files

| File | Responsibility |
| --- | --- |
| `src/aiProvider.ts` | Provider-neutral HTTP and normalized-response contracts |
| `src/aiProviders.ts` | DeepSeek, OpenAI, and Anthropic wire adapters |
| `src/aiConfig.ts` | Provider selection, defaults, keys, models, URLs, and preflight |
| `src/aiJsonClient.ts` | Shared retries, timeouts, progress, validation orchestration, and traces |
| `src/deepSeekClient.ts` | Backwards-compatible DeepSeek client wrapper |
| `src/deepSeekReviewer.ts` | Provider-neutral focused reviewer plus compatibility wrapper |
| `src/deepSeekAuditReviewer.ts` | Provider-neutral multi-pass audit plus compatibility wrapper |
| `src/cli.ts` | `--provider`/environment selection and report metadata |
| `test/aiProviders.test.ts` | Vendor payload, normalization, structured-output, and truncation tests |
| `test/aiConfig.test.ts` | Provider aliases, defaults, missing keys, and invalid override tests |
