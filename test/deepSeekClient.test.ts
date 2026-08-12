import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekJsonClient } from '../src/deepSeekClient.js'

function apiResponse(content: string | null): Response {
  return new Response(JSON.stringify({
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('uses a non-thinking targeted repair after a parsed retry fails schema validation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (bodies.length === 1) return apiResponse(null)
      if (bodies.length === 2) return apiResponse(JSON.stringify({ value: '' }))
      return apiResponse(JSON.stringify({ value: 'repaired' }))
    },
  })

  const result = await client.requestJson({
    operation: 'test synthesis',
    system: 'Return JSON.',
    input: 'input',
    retryInput: 'retry',
    validate: value => {
      const candidate = value as { value?: unknown }
      if (typeof candidate.value !== 'string' || !candidate.value) throw new Error('value must be non-empty')
      return candidate.value
    },
    maxTokens: 100,
    maxRetryTokens: 200,
    retryThinking: 'disabled',
    repair: {
      system: 'Repair JSON.',
      buildInput: (value, error) => `${error}\n${JSON.stringify(value)}`,
      maxTokens: 300,
    },
  })

  assert.equal(result, 'repaired')
  assert.equal(bodies.length, 3)
  assert.deepEqual(bodies[1]?.thinking, { type: 'disabled' })
  assert.equal('reasoning_effort' in (bodies[1] ?? {}), false)
  assert.deepEqual(bodies[2]?.thinking, { type: 'disabled' })
})

test('repairs a parsed first response without repeating the full-context request', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return bodies.length === 1
        ? apiResponse(JSON.stringify({ value: '' }))
        : apiResponse(JSON.stringify({ value: 'repaired' }))
    },
  })

  const result = await client.requestJson({
    operation: 'test synthesis',
    system: 'Return JSON.',
    input: 'large original context',
    retryInput: 'large retry context',
    validate: value => {
      const candidate = value as { value?: unknown }
      if (typeof candidate.value !== 'string' || !candidate.value) throw new Error('value must be non-empty')
      return candidate.value
    },
    repair: {
      system: 'Repair JSON.',
      buildInput: (value, error) => `${error}\n${JSON.stringify(value)}`,
      maxTokens: 300,
    },
  })

  assert.equal(result, 'repaired')
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1]?.thinking, { type: 'disabled' })
  const repairMessages = bodies[1]?.messages as Array<{ content: string }>
  assert.doesNotMatch(repairMessages[1]?.content ?? '', /large retry context/)
})

test('retries one transient fetch failure and records both transport attempts', async () => {
  let requests = 0
  const progress: string[] = []
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    transportRetryDelayMs: 0,
    onProgress: message => progress.push(message),
    fetchImplementation: async () => {
      requests += 1
      if (requests === 1) {
        const cause = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' })
        throw new TypeError('fetch failed', { cause })
      }
      return apiResponse(JSON.stringify({ value: 'accepted' }))
    },
  })

  const result = await client.requestJson({
    system: 'Return JSON.',
    input: 'input',
    retryInput: 'retry',
    validate: value => (value as { value: string }).value,
  })

  assert.equal(result, 'accepted')
  assert.equal(requests, 2)
  assert.equal(client.requestsMade, 2)
  assert.deepEqual(client.traces.map(trace => [trace.transport_attempt, trace.status]), [
    [1, 'transport_error'],
    [2, 'completed'],
  ])
  assert.ok(progress.some(message => message.includes('recoverable connection error')))
})

test('assembles a DeepSeek SSE response while keeping streaming enabled', async () => {
  let requestBody: Record<string, unknown> = {}
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImplementation: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const events = [
        'data: {"model":"test-model","choices":[{"finish_reason":null,"delta":{"reasoning_content":"thinking"}}]}',
        'data: {"model":"test-model","choices":[{"finish_reason":null,"delta":{"content":"{\\"value\\":\\"accepted"}}]}',
        'data: {"model":"test-model","choices":[{"finish_reason":"stop","delta":{"content":"\\"}"}}]}',
        'data: {"model":"test-model","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"completion_tokens_details":{"reasoning_tokens":2}}}',
        'data: [DONE]',
      ].join('\n\n') + '\n\n'
      return new Response(events, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
  })

  const result = await client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry',
    validate: value => (value as { value: string }).value,
  })

  assert.equal(result, 'accepted')
  assert.equal(requestBody.stream, true)
  assert.deepEqual(requestBody.stream_options, { include_usage: true })
  assert.equal(client.traces[0]?.finish_reason, 'stop')
  assert.equal(client.traces[0]?.usage.reasoning_tokens, 2)
})

test('treats a stream without the required DONE event as interrupted transport', async () => {
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key', model: 'test-model', transportRetries: 0,
    fetchImplementation: async () => new Response(
      'data: {"model":"test-model","choices":[{"finish_reason":"stop","delta":{"content":"{\\"value\\":\\"partial\\"}"}}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ),
  })
  await assert.rejects(() => client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry', validate: value => value,
  }), /ended before the \[DONE\] event/)
  assert.equal(client.traces[0]?.status, 'transport_error')
})

test('uses configurable exponential backoff for repeated transport resets', async () => {
  let requests = 0
  const progress: string[] = []
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    transportRetries: 3,
    transportRetryDelayMs: 1,
    onProgress: message => progress.push(message),
    fetchImplementation: async () => {
      requests += 1
      if (requests <= 3) {
        const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        throw new TypeError('terminated', { cause })
      }
      return apiResponse(JSON.stringify({ value: 'accepted' }))
    },
  })

  const result = await client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry',
    validate: value => (value as { value: string }).value,
  })

  assert.equal(result, 'accepted')
  assert.equal(requests, 4)
  assert.ok(progress.some(message => message.includes('in 1ms')))
  assert.ok(progress.some(message => message.includes('in 2ms')))
  assert.ok(progress.some(message => message.includes('in 4ms')))
})

test('retries a rate-limit response and honors Retry-After', async () => {
  let requests = 0
  const delays: number[] = []
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    transportRetryDelayMs: 0,
    delayImplementation: async milliseconds => { delays.push(milliseconds) },
    fetchImplementation: async () => {
      requests += 1
      if (requests < 3) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '3' },
        })
      }
      return apiResponse(JSON.stringify({ value: 'accepted' }))
    },
  })

  const result = await client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry',
    validate: value => (value as { value: string }).value,
  })
  assert.equal(result, 'accepted')
  assert.equal(requests, 3)
  assert.deepEqual(delays, [3000, 3000])
})

test('does not retry a permanent API response error', async () => {
  let requests = 0
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key', model: 'test-model', transportRetryDelayMs: 0,
    fetchImplementation: async () => {
      requests += 1
      return new Response(JSON.stringify({ error: { message: 'invalid request' } }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  await assert.rejects(() => client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry', validate: value => value,
  }), /invalid request/)
  assert.equal(requests, 1)
})

test('uses longer DNS recovery intervals without sleeping in the test', async () => {
  let requests = 0
  const delays: number[] = []
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key', model: 'test-model', transportRetries: 3, transportRetryDelayMs: 2000,
    delayImplementation: async milliseconds => { delays.push(milliseconds) },
    fetchImplementation: async () => {
      requests += 1
      if (requests < 4) {
        const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.deepseek.com'), { code: 'ENOTFOUND' })
        throw new TypeError('fetch failed', { cause })
      }
      return apiResponse(JSON.stringify({ value: 'accepted' }))
    },
  })
  const result = await client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry',
    validate: value => (value as { value: string }).value,
  })
  assert.equal(result, 'accepted')
  assert.deepEqual(delays, [5000, 15000, 30000])
})

test('keeps an active SSE stream alive beyond the inactivity interval', async () => {
  const encoder = new TextEncoder()
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key', model: 'test-model', timeoutMs: 500, connectionTimeoutMs: 50,
    streamInactivityTimeoutMs: 35, transportRetries: 0,
    fetchImplementation: async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of [
          ': keep-alive\n\n',
          'data: {"model":"test-model","choices":[{"finish_reason":null,"delta":{"content":"{\\"value\\":"}}]}\n\n',
          ': keep-alive\n\n',
          'data: {"model":"test-model","choices":[{"finish_reason":"stop","delta":{"content":"\\"accepted\\"}"}}]}\n\n',
          'data: [DONE]\n\n',
        ]) {
          await new Promise(resolve => setTimeout(resolve, 20))
          controller.enqueue(encoder.encode(event))
        }
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  })
  const result = await client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry',
    validate: value => (value as { value: string }).value,
  })
  assert.equal(result, 'accepted')
})

test('aborts a silent SSE stream using the inactivity timeout', async () => {
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key', model: 'test-model', timeoutMs: 500, connectionTimeoutMs: 50,
    streamInactivityTimeoutMs: 20, transportRetries: 0,
    fetchImplementation: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  })
  await assert.rejects(() => client.requestJson({
    system: 'Return JSON.', input: 'input', retryInput: 'retry', validate: value => value,
  }), /stream was inactive for 20ms/)
})
