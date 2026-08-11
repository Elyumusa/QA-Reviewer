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
  assert.ok(progress.some(message => message.includes('transient connection error')))
})

test('does not retry an API response error as a transport failure', async () => {
  let requests = 0
  const client = new DeepSeekJsonClient({
    apiKey: 'test-key',
    model: 'test-model',
    transportRetryDelayMs: 0,
    fetchImplementation: async () => {
      requests += 1
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await assert.rejects(
    () => client.requestJson({
      system: 'Return JSON.',
      input: 'input',
      retryInput: 'retry',
      validate: value => value,
    }),
    /rate limited/,
  )
  assert.equal(requests, 1)
})
