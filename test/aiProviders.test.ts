import assert from 'node:assert/strict'
import test from 'node:test'

import { AiJsonClient } from '../src/aiJsonClient.js'
import { AnthropicProviderAdapter, DeepSeekProviderAdapter, OpenAiProviderAdapter } from '../src/aiProviders.js'

const request = {
  system: 'Return JSON only.',
  input: 'Review this test and return JSON.',
  maxTokens: 1234,
  reasoningEffort: 'high' as const,
  thinking: 'enabled' as const,
  jsonSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  schemaName: 'review',
}

test('builds provider-specific authentication and request payloads', () => {
  const deepseek = new DeepSeekProviderAdapter({ apiKey: 'deep-key', model: 'deep-model', apiUrl: 'https://deep.test' })
  const openai = new OpenAiProviderAdapter({ apiKey: 'open-key', model: 'open-model', apiUrl: 'https://open.test' })
  const anthropic = new AnthropicProviderAdapter({ apiKey: 'claude-key', model: 'claude-model', apiUrl: 'https://claude.test' })

  const deepRequest = deepseek.buildRequest(request)
  assert.equal(deepRequest.headers.Authorization, 'Bearer deep-key')
  assert.equal(deepRequest.body.max_tokens, 1234)
  assert.deepEqual(deepRequest.body.thinking, { type: 'enabled' })

  const deepStreamRequest = deepseek.buildRequest({ ...request, stream: true })
  assert.equal(deepStreamRequest.body.stream, true)
  assert.deepEqual(deepStreamRequest.body.stream_options, { include_usage: true })

  const openRequest = openai.buildRequest(request)
  assert.equal(openRequest.headers.Authorization, 'Bearer open-key')
  assert.equal(openRequest.body.max_completion_tokens, 1234)
  assert.deepEqual((openRequest.body.messages as Array<{ role: string }>).map(message => message.role), ['developer', 'user'])

  const claudeRequest = anthropic.buildRequest(request)
  assert.equal(claudeRequest.headers['x-api-key'], 'claude-key')
  assert.equal(claudeRequest.headers['anthropic-version'], '2023-06-01')
  assert.equal(claudeRequest.body.system, request.system)
  assert.deepEqual(claudeRequest.body.output_config, {
    effort: 'high',
    format: { type: 'json_schema', schema: request.jsonSchema },
  })
})

test('normalizes OpenAI and Anthropic responses and usage', () => {
  const openai = new OpenAiProviderAdapter({ apiKey: 'key', model: 'requested', apiUrl: 'https://open.test' })
  assert.deepEqual(openai.parseResponse({
    model: 'returned',
    choices: [{ finish_reason: 'stop', message: { content: '{"value":"ok"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
  }), {
    content: '{"value":"ok"}', responseModel: 'returned', finishReason: 'stop', truncated: false, refusal: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 2, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: null },
  })

  const anthropic = new AnthropicProviderAdapter({ apiKey: 'key', model: 'requested', apiUrl: 'https://claude.test' })
  const normalized = anthropic.parseResponse({
    model: 'returned', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '{"value":"ok"}' }],
    usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4, output_tokens_details: { thinking_tokens: 3 } },
  })
  assert.equal(normalized.content, '{"value":"ok"}')
  assert.equal(normalized.usage.total_tokens, 28)
  assert.equal(normalized.usage.reasoning_tokens, 3)
  assert.equal(normalized.usage.prompt_cache_hit_tokens, 4)
})

test('normalizes DeepSeek streaming deltas and final usage', () => {
  const deepseek = new DeepSeekProviderAdapter({ apiKey: 'key', model: 'requested', apiUrl: 'https://deep.test' })
  const delta = deepseek.parseStreamChunk({
    model: 'returned',
    choices: [{ finish_reason: null, delta: { content: '{"value":' } }],
  })
  assert.equal(delta.contentDelta, '{"value":')
  assert.equal(delta.responseModel, 'returned')

  const final = deepseek.parseStreamChunk({
    model: 'returned', choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, completion_tokens_details: { reasoning_tokens: 2 } },
  })
  assert.equal(final.usage.total_tokens, 16)
  assert.equal(final.usage.reasoning_tokens, 2)
})

test('runs the generic JSON client through the Anthropic Messages response shape', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new AiJsonClient({
    provider: new AnthropicProviderAdapter({ apiKey: 'key', model: 'claude-sonnet-5', apiUrl: 'https://claude.test/v1/messages' }),
    fetchImplementation: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({
        model: 'claude-sonnet-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"value":"accepted"}' }],
        usage: { input_tokens: 10, output_tokens: 4 },
      }), { status: 200 })
    },
  })

  const value = await client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry',
    jsonSchema: request.jsonSchema,
    validate: candidate => (candidate as { value: string }).value,
  })
  assert.equal(value, 'accepted')
  assert.equal(client.providerId, 'anthropic')
  assert.equal(client.traces[0]?.provider, 'anthropic')
  assert.deepEqual((bodies[0]?.output_config as Record<string, unknown>).format, {
    type: 'json_schema', schema: request.jsonSchema,
  })
})

test('repairs malformed JSON from a retry without resending the full review context', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new AiJsonClient({
    provider: new AnthropicProviderAdapter({ apiKey: 'key', model: 'claude-sonnet-5', apiUrl: 'https://claude.test/v1/messages' }),
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const text = bodies.length === 1 ? null : bodies.length === 2 ? '{"value":"retry",}' : '{"value":"repaired"}'
      return new Response(JSON.stringify({
        model: 'claude-sonnet-5', stop_reason: 'end_turn',
        content: text === null ? [{ type: 'thinking', thinking: 'reasoning only' }] : [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 4 },
      }), { status: 200 })
    },
  })

  const value = await client.requestJson({
    operation: 'repairable operation', system: 'full system', input: 'very large full input', retryInput: 'very large retry input',
    validate: candidate => (candidate as { value: string }).value,
    repair: {
      system: 'small repair system', maxTokens: 1000,
      buildInput: (invalid, error) => `repair ${JSON.stringify(invalid)} because ${error}`,
    },
  })

  assert.equal(value, 'repaired')
  assert.equal(bodies.length, 3)
  assert.equal(bodies[2]?.system, 'small repair system')
  assert.doesNotMatch(JSON.stringify(bodies[2]), /very large full input/)
  assert.match(JSON.stringify(bodies[2]), /malformed_json/)
})

test('recognizes each provider token-limit finish reason as truncation', async () => {
  const cases = [
    {
      provider: new OpenAiProviderAdapter({ apiKey: 'key', model: 'model', apiUrl: 'https://open.test' }),
      response: { model: 'model', choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    },
    {
      provider: new AnthropicProviderAdapter({ apiKey: 'key', model: 'model', apiUrl: 'https://claude.test' }),
      response: { model: 'model', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] },
    },
  ]
  for (const item of cases) {
    let calls = 0
    const client = new AiJsonClient({
      provider: item.provider,
      fetchImplementation: async () => {
        calls += 1
        return new Response(JSON.stringify(item.response), { status: 200 })
      },
    })
    await assert.rejects(() => client.requestJson({
      operation: 'provider truncation test', system: 'JSON', input: 'JSON', retryInput: 'JSON',
      maxTokens: 10, maxRetryTokens: 20, validate: value => value,
    }), /truncated/)
    assert.equal(calls, 2)
    assert.deepEqual(client.traces.map(trace => trace.status), ['truncated', 'truncated'])
  }
})

test('rejects an Anthropic refusal without relabeling it as a schema failure', async () => {
  const client = new AiJsonClient({
    provider: new AnthropicProviderAdapter({ apiKey: 'key', model: 'model', apiUrl: 'https://claude.test' }),
    fetchImplementation: async () => new Response(JSON.stringify({
      model: 'model', stop_reason: 'refusal', content: [{ type: 'text', text: 'I cannot comply.' }],
    }), { status: 200 }),
  })
  await assert.rejects(() => client.requestJson({
    operation: 'refusal test', system: 'JSON', input: 'JSON', retryInput: 'JSON', validate: value => value,
  }), /refused by anthropic/)
  assert.equal(client.traces[0]?.status, 'api_error')
})
