import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekReviewer } from '../src/deepSeekReviewer.js'
import type { ReviewContext } from '../src/types.js'

const context: ReviewContext = {
  test_file: { path: 'test.cy.ts', content: "it('works', () => expect(true).to.equal(true))" },
  diff: '',
  related_files: [],
}

test('retries once when DeepSeek output is invalid JSON', async () => {
  let requests = 0
  const reviewer = new DeepSeekReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImplementation: async (_input, init) => {
      requests += 1
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key')
      const requestBody = JSON.parse(String(init?.body)) as {
        model: string
        messages: Array<{ role: string; content: string }>
        thinking: { type: string }
        reasoning_effort: string
        response_format: { type: string }
        stream: boolean
      }
      assert.equal(requestBody.model, 'test-model')
      assert.deepEqual(requestBody.messages.map(message => message.role), ['system', 'user'])
      assert.match(requestBody.messages[1]?.content ?? '', /required_json_schema/)
      assert.equal(requestBody.thinking.type, 'enabled')
      assert.equal(requestBody.reasoning_effort, 'high')
      assert.equal(requestBody.response_format.type, 'json_object')
      assert.equal(requestBody.stream, true)

      const content = requests === 1
        ? 'not json'
        : JSON.stringify({
            file: 'test.cy.ts',
            test_type: 'unknown',
            status: 'pass',
            summary: 'No issues.',
            findings: [],
          })
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          index: 0,
          message: { role: 'assistant', content },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await reviewer.review('unknown', '# Standards', context, [])
  assert.equal(result.status, 'pass')
  assert.equal(requests, 2)
})

test('requires a DeepSeek API key', () => {
  assert.throws(() => new DeepSeekReviewer({ apiKey: '', model: 'test-model' }), /DEEPSEEK_API_KEY/)
})

test('retries a temporary server failure', async () => {
  let requests = 0
  const reviewer = new DeepSeekReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    transportRetryDelayMs: 0,
    fetchImplementation: async () => {
      requests += 1
      if (requests === 3) {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            file: 'test.cy.ts', test_type: 'unknown', status: 'pass', summary: 'Recovered.', findings: [],
          }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'server busy' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await reviewer.review('unknown', '# Standards', context, [])
  assert.equal(result.summary, 'Recovered.')
  assert.equal(requests, 3)
  assert.equal(reviewer.lastRequestTraces.length, 3)
  assert.equal(reviewer.lastRequestTraces[0]?.status, 'transport_error')
})

test('retries a completion truncated by the token limit', async () => {
  let requests = 0
  const requestedLimits: number[] = []
  const reviewer = new DeepSeekReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImplementation: async (_input, init) => {
      requests += 1
      const requestBody = JSON.parse(String(init?.body)) as { max_tokens: number }
      requestedLimits.push(requestBody.max_tokens)
      const content = JSON.stringify({
        file: 'test.cy.ts',
        test_type: 'unknown',
        status: 'pass',
        summary: 'No issues.',
        findings: [],
      })
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: requests === 1 ? 'length' : 'stop',
          message: { role: 'assistant', content },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const result = await reviewer.review('unknown', '# Standards', context, [])
  assert.equal(result.status, 'pass')
  assert.equal(requests, 2)
  assert.deepEqual(requestedLimits, [6000, 12_000])
})

test('reports the operation, requested model, returned model, and token usage after repeated truncation', async () => {
  const progress: string[] = []
  const reviewer = new DeepSeekReviewer({
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    onProgress: message => progress.push(message),
    fetchImplementation: async () => new Response(JSON.stringify({
      model: 'deepseek-v4-pro',
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }],
      usage: {
        prompt_tokens: 4000,
        completion_tokens: 12_000,
        total_tokens: 16_000,
        completion_tokens_details: { reasoning_tokens: 9000 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })

  await assert.rejects(
    () => reviewer.review('unknown', '# Standards', context, []),
    error => {
      assert.match(String(error), /focused review for test\.cy\.ts returned invalid output after one retry/)
      assert.match(String(error), /requested_model=deepseek-v4-flash/)
      assert.match(String(error), /response_model=deepseek-v4-pro/)
      assert.match(String(error), /max_tokens=12000/)
      assert.match(String(error), /reasoning=9000/)
      return true
    },
  )
  assert.ok(progress.some(message => message.includes('6000 → 12000')))
  assert.ok(progress.some(message => message.includes('API reported deepseek-v4-pro')))
})
