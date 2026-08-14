import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DeepSeekAuditReviewer } from '../src/deepSeekAuditReviewer.js'
import type { ReviewContext } from '../src/types.js'

function response(content: unknown): Response {
  return new Response(JSON.stringify({
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 20 },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function rawResponse(content: string | null): Response {
  return new Response(JSON.stringify({
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('runs inventory, chunk, coverage, and synthesis as a bounded audit workflow', async () => {
  const context: ReviewContext = {
    test_file: {
      path: 'Address.cy.ts',
      content: `describe('address', () => {\n  it('renders', () => {\n    cy.get('lvl-address-picker').should('exist')\n  })\n})`,
    },
    diff: '',
    related_files: [{
      path: 'src/Address.ts', reason: 'Imported', content: 'export class Address { /* truncated */ }', truncated: true,
      original_character_count: 2_000, full_content_hash: 'address-source-hash',
      full_content: `export class Address {\n  render() { return html\`<slot></slot>\` }\n}`,
    }],
  }
  const systems: string[] = []
  const progress: string[] = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    chunkLines: 100,
    chunkConcurrency: 1,
    onProgress: message => progress.push(message),
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; reasoning_effort: string }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      systems.push(system)
      if (system.includes('global test-structure analyst')) {
        return response({
          summary: 'One small component suite.',
          suites: [{ name: 'address', start_line: 1, end_line: 5, purpose: 'Rendering', key_behaviors: ['renders'] }],
          shared_infrastructure: [],
          cross_suite_patterns: [],
          context_used: ['Address.cy.ts', 'component standards'],
          limitations: [],
        })
      }
      assert.equal(body.reasoning_effort, 'high')
      if (system.includes('test-quality evidence analyst')) {
        const chunkId = user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown'
        return response({
          chunk_id: chunkId,
          summary: 'The chunk uses an observable existence assertion.',
          strengths: [{
            title: 'Observable assertion',
            description: 'The test checks rendered output.',
            evidence_lines: [3],
            standards_references: ['Observable behavior'],
            why_it_matters: 'It validates the public result.',
            confidence: 'high',
          }],
          concerns: [],
          context_used: ['Address.cy.ts'],
        })
      }
      if (system.includes('behavior-and-coverage analyst')) {
        return response({
          summary: 'Only rendering can be compared from the small source sample.',
          covered_behaviors: [{
            behavior: 'Rendering',
            source_evidence: ['Address.ts'],
            test_evidence: ['Address.cy.ts:2'],
            assessment: 'Covered at a basic level.',
          }],
          coverage_gaps: [],
          test_placement_issues: [],
          context_used: ['Address.ts', 'Address.cy.ts'],
          limitations: ['The example source is intentionally minimal.'],
        })
      }
      return response({
        overall_assessment: 'The small suite has a clear observable assertion.',
        summary: 'Rendering is tested clearly; broader behavior cannot be assessed from this fixture.',
        strengths: [{
          title: 'Observable rendering check',
          description: 'The component is asserted through its rendered host.',
          evidence_lines: [3],
          standards_references: ['Observable behavior'],
          why_it_matters: 'It avoids private state coupling.',
          confidence: 'high',
        }],
        findings: [],
        standards_assessment: [{
          section: 'Observable behavior',
          assessment: 'strong',
          positives: ['Uses a rendered assertion.'],
          concerns: [],
        }],
        coverage_gaps: [],
        test_placement_issues: [],
        priorities: [{ rank: 1, action: 'Retain the observable assertion.', rationale: 'It is stable.', related_finding_rules: [] }],
        limitations: ['The fixture is intentionally small.'],
        context_actually_used: ['Address.cy.ts', 'Address.ts', 'component standards'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  assert.equal(result.audit.metrics.test_count, 1)
  assert.equal(result.audit.execution.test_chunks_reviewed, 1)
  assert.equal(result.audit.execution.ai_calls, 4)
  assert.deepEqual(result.audit.execution.response_models, ['test-model'])
  assert.equal(result.audit.execution.requests[0]?.usage.reasoning_tokens, 20)
  assert.equal(result.audit.strengths[0]?.title, 'Observable rendering check')
  assert.equal(result.audit.context_manifest?.[1]?.status, 'truncated')
  assert.ok((result.audit.context_manifest?.[1]?.targeted_excerpts ?? 0) > 0)
  assert.ok(result.audit.execution.passes.includes('targeted full-source retrieval'))
  assert.equal(systems.length, 4)
  assert.ok(progress.some(message => message.includes('Inventory complete')))
  assert.ok(progress.some(message => message.includes('audit final synthesis')))
})

test('continues synthesis conservatively when malformed coverage output cannot be repaired', async () => {
  const context: ReviewContext = {
    test_file: { path: 'CoverageFallback.cy.ts', content: "describe('fallback', () => {\n  it('renders', () => cy.get('x-demo').should('exist'))\n})" },
    diff: '', related_files: [],
  }
  let coverageAttempts = 0
  const progress: string[] = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    onProgress: message => progress.push(message),
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) return response({
        summary: 'One suite.', suites: [{ name: 'fallback', start_line: 1, end_line: 3, purpose: 'Rendering', key_behaviors: ['renders'] }],
        shared_infrastructure: [], cross_suite_patterns: [], context_used: ['CoverageFallback.cy.ts'], limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Observable assertion.', strengths: [], concerns: [], context_used: ['CoverageFallback.cy.ts'],
      })
      if (system.includes('repair a malformed or nearly valid')) return rawResponse('{still malformed')
      if (system.includes('behavior-and-coverage analyst')) {
        coverageAttempts += 1
        return coverageAttempts === 1 ? rawResponse(null) : rawResponse('{"summary":"partial",}')
      }
      return response({
        overall_assessment: 'The available test evidence is limited but valid.', summary: 'Completed without unsupported coverage claims.',
        strengths: [], findings: [], standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [],
        limitations: [], context_actually_used: ['CoverageFallback.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  assert.equal(result.audit.execution.complete, true)
  assert.equal(result.incomplete_error, undefined)
  assert.ok(result.audit.limitations.some(item => item.includes('source-and-coverage AI pass remained invalid')))
  assert.ok(result.audit.execution.adaptive_recoveries.includes('source and coverage cross-check (conservative fallback)'))
  assert.ok(progress.some(item => item.includes('Continuing final synthesis with a conservative empty coverage result')))
})

test('repairs a parseable global map without repeating the full test prompt', async () => {
  const context: ReviewContext = {
    test_file: { path: 'Repair.cy.ts', content: "describe('repair', () => {\n  it('renders', () => cy.get('x-repair').should('exist'))\n})" },
    diff: '', related_files: [],
  }
  const requests: Array<{ system: string; user: string; thinking: string }> = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; thinking: { type: string } }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      requests.push({ system, user, thinking: body.thinking.type })
      if (system.includes('global test-structure analyst')) return response({
        summary: 'Repair suite.', suites: [{ name: 'repair', start_line: 1, end_line: 3, purpose: 'Rendering', key_behaviors: ['renders'] }],
        shared_infrastructure: [],
        cross_suite_patterns: [{ title: 'Observable', description: 'Rendered output.', evidence_lines: '2', assessment: 'strength' }],
        context_used: ['Repair.cy.ts'], limitations: [],
      })
      if (system.includes('repair a nearly valid Levelbuild Cypress global-map')) return response({
        summary: 'Repair suite.', suites: [{ name: 'repair', start_line: 1, end_line: 3, purpose: 'Rendering', key_behaviors: ['renders'] }],
        shared_infrastructure: [],
        cross_suite_patterns: [{ title: 'Observable', description: 'Rendered output.', evidence_lines: [2], assessment: 'strength' }],
        context_used: ['Repair.cy.ts'], limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Observable check.', strengths: [], concerns: [], context_used: ['Repair.cy.ts'],
      })
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'No source context.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [], context_used: ['Repair.cy.ts'], limitations: [],
      })
      return response({
        overall_assessment: 'Repaired audit.', summary: 'Repaired.', strengths: [], findings: [], standards_assessment: [], coverage_gaps: [],
        test_placement_issues: [], priorities: [], limitations: [], context_actually_used: ['Repair.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  const repairRequest = requests.find(request => request.system.includes('repair a nearly valid Levelbuild Cypress global-map'))
  assert.equal(result.audit.execution.complete, true)
  assert.equal(result.audit.execution.global_map_source, 'ai')
  assert.equal(repairRequest?.thinking, 'disabled')
  assert.match(repairRequest?.user ?? '', /positive integer array/)
  assert.doesNotMatch(repairRequest?.user ?? '', /complete_numbered_test_file/)
  assert.equal(requests.filter(request => request.system.includes('global test-structure analyst')).length, 1)
})

test('retries a content-empty global map with thinking disabled', async () => {
  const context: ReviewContext = {
    test_file: { path: 'Retry.cy.ts', content: "describe('retry', () => {\n  it('renders', () => cy.get('x-retry').should('exist'))\n})" },
    diff: '', related_files: [],
  }
  const globalThinking: string[] = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; thinking: { type: string } }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) {
        globalThinking.push(body.thinking.type)
        if (globalThinking.length === 1) {
          return new Response(JSON.stringify({
            model: 'test-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return response({
          summary: 'Retry suite.', suites: [{ name: 'retry', start_line: 1, end_line: 3, purpose: 'Rendering', key_behaviors: ['renders'] }],
          shared_infrastructure: [], cross_suite_patterns: [], context_used: ['Retry.cy.ts'], limitations: [],
        })
      }
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Observable check.', strengths: [], concerns: [], context_used: ['Retry.cy.ts'],
      })
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'No source context.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [], context_used: ['Retry.cy.ts'], limitations: [],
      })
      return response({
        overall_assessment: 'Completed retry.', summary: 'Completed retry.', strengths: [], findings: [], standards_assessment: [], coverage_gaps: [],
        test_placement_issues: [], priorities: [], limitations: [], context_actually_used: ['Retry.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  assert.equal(result.audit.execution.complete, true)
  assert.deepEqual(globalThinking, ['enabled', 'disabled'])
})

test('continues chunk analysis with a deterministic global map after transport failure', async () => {
  const context: ReviewContext = {
    test_file: { path: 'Fallback.cy.ts', content: "describe('fallback', () => {\n  beforeEach(() => cy.viewport(800, 600))\n  it('renders', () => cy.get('x-fallback').should('exist'))\n})" },
    diff: '', related_files: [],
  }
  const progress: string[] = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    transportRetries: 0, onProgress: message => progress.push(message),
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) {
        const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        throw new TypeError('terminated', { cause })
      }
      if (system.includes('test-quality evidence analyst')) {
        assert.match(user, /Deterministic fallback map/)
        return response({
          chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Fallback-guided chunk.', strengths: [], concerns: [], context_used: ['Fallback.cy.ts'],
        })
      }
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'No source context.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [], context_used: ['Fallback.cy.ts'], limitations: [],
      })
      return response({
        overall_assessment: 'Fallback audit.', summary: 'Completed using fallback orientation.', strengths: [], findings: [], standards_assessment: [], coverage_gaps: [],
        test_placement_issues: [], priorities: [], limitations: [], context_actually_used: ['Fallback.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  assert.equal(result.incomplete_error, undefined)
  assert.equal(result.audit.execution.complete, true)
  assert.equal(result.audit.execution.global_map_source, 'deterministic_fallback')
  assert.equal(result.audit.execution.test_chunks_reviewed, 1)
  assert.ok(result.audit.execution.adaptive_recoveries.includes('global full-file map (deterministic fallback)'))
  assert.ok(result.audit.limitations.some(item => item.includes('deterministic syntax inventory')))
  assert.ok(progress.some(message => message.includes('Continuing standards chunks')))
})

test('waits for active chunk requests, stops new work, and returns a partial audit after failure', async () => {
  const content = Array.from({ length: 250 }, (_, index) => `// ${index + 1}`).join('\n')
  const startedChunks: string[] = []
  const context: ReviewContext = {
    test_file: { path: 'Large.cy.ts', content },
    diff: '',
    related_files: [],
  }
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    chunkLines: 100,
    chunkConcurrency: 2,
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0]?.content ?? ''
      const userInput = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) {
        return response({
          summary: 'Comment-only fixture.',
          suites: [],
          shared_infrastructure: [],
          cross_suite_patterns: [],
          context_used: ['Large.cy.ts'],
          limitations: [],
        })
      }
      const chunk = userInput.match(/Chunk: (lines-\d+-\d+)/)?.[1] ?? 'unknown'
      startedChunks.push(chunk)
      if (chunk === 'lines-1-100') return response('invalid result')
      await new Promise(resolve => setTimeout(resolve, 25))
      return response({
        chunk_id: chunk,
        summary: 'No evidence in comment-only fixture.',
        strengths: [],
        concerns: [],
        context_used: ['Large.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  assert.match(result.incomplete_error ?? '', /lines-1-100 returned invalid output/)
  assert.equal(result.audit.execution.complete, false)
  assert.deepEqual([...new Set(startedChunks)], ['lines-1-100', 'lines-71-170'])
})

test('splits only a transport-failed chunk and reviews recovery chunks without thinking', async () => {
  const filler = Array.from({ length: 165 }, (_, index) => `  // detail ${index + 1}`).join('\n')
  const content = `describe('large area', () => {\n${filler}\n  it('renders', () => cy.get('x-demo').should('exist'))\n})`
  const context: ReviewContext = { test_file: { path: 'Large.cy.ts', content }, diff: '', related_files: [] }
  const chunkRequests: Array<{ id: string; thinking: string }> = []
  let failedPrimary = false
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    chunkLines: 200,
    chunkConcurrency: 1,
    transportRetries: 0,
    transportRetryDelayMs: 0,
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>
        thinking: { type: string }
      }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) return response({
        summary: 'Large suite.',
        suites: [{ name: 'large area', start_line: 1, end_line: 168, purpose: 'Rendering', key_behaviors: ['renders'] }],
        shared_infrastructure: [], cross_suite_patterns: [], context_used: ['Large.cy.ts'], limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) {
        const id = user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown'
        chunkRequests.push({ id, thinking: body.thinking.type })
        if (body.thinking.type === 'enabled' && !failedPrimary) {
          failedPrimary = true
          const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
          throw new TypeError('terminated', { cause })
        }
        const start = Number(user.match(/Lines: (\d+)-/)?.[1] ?? '1')
        return response({
          chunk_id: id,
          summary: 'Recovered evidence chunk.',
          strengths: [],
          concerns: [],
          context_used: ['Large.cy.ts'],
          evidence_line: start,
        })
      }
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'No source context.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [],
        context_used: ['Large.cy.ts'], limitations: ['No source context.'],
      })
      return response({
        overall_assessment: 'Recovered audit.', summary: 'Recovered successfully.', strengths: [], findings: [],
        standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [], limitations: [],
        context_actually_used: ['Large.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', '# Standards', context, [])
  assert.equal(result.incomplete_error, undefined)
  assert.equal(result.audit.execution.complete, true)
  assert.ok(result.audit.execution.adaptive_recoveries.some(item => item.startsWith('semantic-1-168')))
  assert.equal(chunkRequests.filter(request => request.thinking === 'enabled').length, 1)
  assert.equal(chunkRequests.filter(request => request.thinking === 'disabled').length, 2)
  assert.ok(chunkRequests.filter(request => request.thinking === 'disabled').every(request => request.id.startsWith('adaptive-')))
})

test('reuses checkpointed global, chunk, and coverage passes after a synthesis run', async t => {
  const checkpointDirectory = await mkdtemp(path.join(tmpdir(), 'qa-audit-checkpoint-'))
  t.after(async () => rm(checkpointDirectory, { recursive: true, force: true }))
  const context: ReviewContext = {
    test_file: { path: 'Cached.cy.ts', content: `describe('cached', () => {\n  it('renders', () => cy.get('x-cached').should('exist'))\n})` },
    diff: '',
    related_files: [],
  }
  const callsByRun: number[] = []

  const createReviewer = (run: number): DeepSeekAuditReviewer => new DeepSeekAuditReviewer({
    apiKey: 'test-key',
    model: 'test-model',
    chunkLines: 100,
    chunkConcurrency: 1,
    checkpointDirectory,
    fetchImplementation: async (_input, init) => {
      callsByRun[run] = (callsByRun[run] ?? 0) + 1
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) return response({
        summary: 'Cached suite.',
        suites: [{ name: 'cached', start_line: 1, end_line: 3, purpose: 'Rendering', key_behaviors: ['renders'] }],
        shared_infrastructure: [],
        cross_suite_patterns: [],
        context_used: ['Cached.cy.ts'],
        limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown',
        summary: 'Observable render check.',
        strengths: [],
        concerns: [],
        context_used: ['Cached.cy.ts'],
      })
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'No source context.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [],
        context_used: ['Cached.cy.ts'], limitations: ['No source context.'],
      })
      return response({
        overall_assessment: 'Small observable suite.', summary: 'No supported issues.', strengths: [], findings: [],
        standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [], limitations: [],
        context_actually_used: ['Cached.cy.ts'],
      })
    },
  })

  await createReviewer(0).audit('component', '# Standards', context, [])
  const second = await createReviewer(1).audit('component', '# Standards', context, [])

  assert.equal(callsByRun[0], 4)
  assert.equal(callsByRun[1], 1)
  assert.deepEqual(second.audit.execution.reused_passes, [
    'global full-file map',
    'standards chunk semantic-1-3',
    'source and coverage cross-check',
  ])
})

test('enriches a synthesized finding with exact repository code and allowlisted Cypress guidance', async () => {
  const content = [
    "describe('chatbot', () => {",
    "  it('uses fallback title', () => {",
    "    cy.intercept('GET', '/Api/Chatbot/UserInfo', { statusCode: 500 }).as('getUserInfoError')",
    '    cy.mount(`<lvl-chatbot></lvl-chatbot>`)',
    "    cy.wait('@getUserInfoError')",
    "    cy.get('@chatbot').then($el => {",
    '      const chatbot = $el[0] as any',
    '      if (!chatbot.displayTitle) chatbot.loadUserInfo()',
    "      expect(chatbot.displayTitle).to.include('User')",
    '    })',
    '  })',
    '})',
  ].join('\n')
  const standardsHeading = '8. Handling Async State & Conditional UI'
  const officialUrl = 'https://docs.cypress.io/app/guides/conditional-testing'
  const context: ReviewContext = {
    test_file: { path: 'Chatbot.cy.ts', content },
    diff: '',
    related_files: [{
      path: 'Chatbot.ts',
      reason: 'Imported component',
      content: "render() { return html`<div class='chat-title-text'>${this.displayTitle}</div>` }",
      truncated: false,
    }],
  }
  const systems: string[] = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; thinking: { type: string } }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      systems.push(system)
      if (system.includes('global test-structure analyst')) return response({
        summary: 'One chatbot suite.', suites: [{ name: 'chatbot', start_line: 1, end_line: 12, purpose: 'Fallback title', key_behaviors: ['uses fallback title'] }],
        shared_infrastructure: [], cross_suite_patterns: [], context_used: ['Chatbot.cy.ts'], limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Conditional fallback assertion.', strengths: [], concerns: [{
          line: 6, end_line: 10, title: 'Test repairs missing fallback state', description: 'The test conditionally calls loadUserInfo.',
          impact: 'A broken mount lifecycle can still pass.', recommendation: 'Assert the rendered fallback unconditionally.',
          standards_references: [standardsHeading], confidence: 'high',
        }], context_used: ['Chatbot.cy.ts'],
      })
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'Fallback is weakly covered.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [],
        context_used: ['Chatbot.ts', 'Chatbot.cy.ts'], limitations: [],
      })
      if (system.includes('recommendation engineer')) {
        assert.equal(body.thinking.type, 'disabled')
        assert.match(user, /chat-title-text/)
        assert.match(user, /allowed_internal_standard_headings/)
        assert.match(user, /docs\.cypress\.io\/app\/guides\/conditional-testing/)
        return response({ recommendations: [{
          finding_key: 'CYPRESS-CONDITIONAL-001:6',
          recommendation: 'Remove the conditional production-method call and assert the rendered fallback title after the existing failed request completes.',
          replacement_code: "cy.wait('@getUserInfoError')\n    .its('response.statusCode')\n    .should('eq', 500)\n\ncy.get('@chatbot')\n    .shadow()\n    .find('.chat-title-text')\n    .should('contain.text', 'User')",
          code_kind: 'exact',
          internal_standard_references: [standardsHeading],
          official_reference_urls: [officialUrl],
          assumptions: [],
        }] })
      }
      return response({
        overall_assessment: 'Fallback coverage is undermined by conditional repair.', summary: 'Replace conditional repair with an observable assertion.', strengths: [],
        findings: [{
          line: 6, end_line: 10, severity: 'medium', rule: 'CYPRESS-CONDITIONAL-001', category: 'quality',
          title: 'Test repairs missing fallback state', message: 'The test conditionally calls loadUserInfo when mounting did not set the title.',
          impact: 'A lifecycle regression can pass.', suggestion: 'Assert the rendered fallback unconditionally.', replacement_code: null,
          specific_cypress_methods: ['cy.get', 'then', 'should'], context_used: ['Chatbot.cy.ts', 'Chatbot.ts'], confidence: 'high',
          evidence: ['Lines 6-10 conditionally call the production method.'], standards_references: [standardsHeading], related_locations: [],
        }], standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [{
          rank: 1, action: 'Replace conditional repair.', rationale: 'It can hide regressions.', related_finding_rules: ['CYPRESS-CONDITIONAL-001'],
        }], limitations: [], context_actually_used: ['Chatbot.cy.ts', 'Chatbot.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', `## ${standardsHeading}\n\nDo not repair lifecycle behavior inside a test. [Conditional testing](${officialUrl})`, context, [])
  const enriched = result.findings[0]!
  assert.equal(result.audit.execution.complete, true)
  assert.equal(result.audit.execution.ai_calls, 5)
  assert.ok(result.audit.execution.passes.includes('standards-grounded recommendation enrichment'))
  assert.equal(enriched.recommendation_code_kind, 'exact')
  assert.match(enriched.replacement_code ?? '', /chat-title-text/)
  assert.deepEqual(enriched.official_references, [{ title: 'Conditional testing', url: officialUrl }])
  assert.deepEqual(enriched.standards_references, [standardsHeading])
  assert.equal(systems.filter(system => system.includes('recommendation engineer')).length, 1)
})

test('preserves a completed audit when optional recommendation enrichment fails', async () => {
  const context: ReviewContext = {
    test_file: { path: 'FallbackRecommendation.cy.ts', content: "describe('x', () => {\n  it('renders', () => cy.get('x-demo').should('exist'))\n})" },
    diff: '', related_files: [],
  }
  const progress: string[] = []
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    onProgress: message => progress.push(message),
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) return response({
        summary: 'One suite.', suites: [{ name: 'x', start_line: 1, end_line: 3, purpose: 'Render', key_behaviors: ['renders'] }],
        shared_infrastructure: [], cross_suite_patterns: [], context_used: ['FallbackRecommendation.cy.ts'], limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Weak assertion.', strengths: [], concerns: [], context_used: ['FallbackRecommendation.cy.ts'],
      })
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'No source.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [], context_used: [], limitations: [],
      })
      if (system.includes('recommendation engineer')) return response('not-an-object')
      return response({
        overall_assessment: 'The assertion is shallow.', summary: 'Strengthen the rendered assertion.', strengths: [], findings: [{
          line: 2, end_line: 2, severity: 'low', rule: 'ASSERT-001', category: 'quality', title: 'Shallow existence assertion',
          message: 'Existence alone does not prove content.', impact: 'A blank component can pass.', suggestion: 'Assert meaningful rendered content.',
          replacement_code: null, specific_cypress_methods: ['cy.get', 'should'], context_used: ['FallbackRecommendation.cy.ts'], confidence: 'medium',
          evidence: ['Line 2 asserts only existence.'], standards_references: ['Assertions'], related_locations: [],
        }], standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [], limitations: [], context_actually_used: ['FallbackRecommendation.cy.ts'],
      })
    },
  })

  const result = await reviewer.audit(
    'component',
    '## Assertions\n\nAssert meaningful output. [Retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability)',
    context,
    [],
  )
  assert.equal(result.audit.execution.complete, true)
  assert.equal(result.incomplete_error, undefined)
  assert.equal(result.findings[0]?.suggestion, 'Assert meaningful rendered content.')
  assert.ok(result.audit.limitations.some(limitation => limitation.includes('Recommendation enrichment could not safely enrich ASSERT-001 at line 2')))
  assert.ok(progress.some(message => message.includes('original validated recommendation was preserved')))
  assert.ok(!result.audit.execution.passes.includes('standards-grounded recommendation enrichment'))
})

test('subdivides a schema-invalid recommendation batch and preserves valid per-finding snippets', async () => {
  const content = [
    "describe('examples', () => {",
    "  it('checks one', () => cy.get('.one').should('exist'))",
    "  it('checks two', () => cy.get('.two').should('exist'))",
    '})',
  ].join('\n')
  const context: ReviewContext = {
    test_file: { path: 'Examples.cy.ts', content }, diff: '',
    related_files: [{ path: 'Examples.ts', reason: 'Rendered source', content: "html`<div class='one'>One</div><div class='two'>Two</div>`", truncated: false }],
  }
  const heading = '3. Write Assertions That Can Detect a Regression'
  const officialUrl = 'https://docs.cypress.io/app/core-concepts/retry-ability'
  const reviewer = new DeepSeekAuditReviewer({
    apiKey: 'test-key', model: 'test-model', chunkLines: 100, chunkConcurrency: 1,
    fetchImplementation: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      if (system.includes('global test-structure analyst')) return response({
        summary: 'Two examples.', suites: [{ name: 'examples', start_line: 1, end_line: 4, purpose: 'Rendering', key_behaviors: ['checks one', 'checks two'] }],
        shared_infrastructure: [], cross_suite_patterns: [], context_used: ['Examples.cy.ts'], limitations: [],
      })
      if (system.includes('test-quality evidence analyst')) return response({
        chunk_id: user.match(/Chunk: ([^ ]+)/)?.[1] ?? 'unknown', summary: 'Two shallow assertions.', strengths: [], concerns: [], context_used: ['Examples.cy.ts'],
      })
      if (system.includes('behavior-and-coverage analyst')) return response({
        summary: 'Rendered text is available.', covered_behaviors: [], coverage_gaps: [], test_placement_issues: [], context_used: ['Examples.ts'], limitations: [],
      })
      if (system.includes('repair a nearly valid batch')) return response({ recommendations: [] })
      if (system.includes('recommendation engineer')) {
        const hasOne = user.includes('ASSERT-ONE:2')
        const hasTwo = user.includes('ASSERT-TWO:3')
        if (hasOne && hasTwo) return response({ recommendations: [{
          finding_key: 'ASSERT-ONE:2', recommendation: 'Assert the first rendered value.',
          replacement_code: "cy.get('.one').should('contain.text', 'One')", code_kind: 'exact',
          internal_standard_references: [heading], official_reference_urls: [officialUrl], assumptions: [],
        }, {
          finding_key: 'ASSERT-TWO:3', recommendation: 'Assert the second rendered value.',
          replacement_code: "cy.get('.two'", code_kind: 'exact',
          internal_standard_references: [heading], official_reference_urls: [officialUrl], assumptions: [],
        }] })
        const key = hasOne ? 'ASSERT-ONE:2' : 'ASSERT-TWO:3'
        const selector = hasOne ? '.one' : '.two'
        const expected = hasOne ? 'One' : 'Two'
        return response({ recommendations: [{
          finding_key: key, recommendation: `Assert the ${expected.toLowerCase()} rendered value.`,
          replacement_code: `cy.get('${selector}').should('contain.text', '${expected}')`, code_kind: 'exact',
          internal_standard_references: [heading], official_reference_urls: [officialUrl], assumptions: [],
        }] })
      }
      const makeFinding = (line: number, rule: string, name: string) => ({
        line, end_line: line, severity: 'medium', rule, category: 'quality', title: `Shallow ${name} assertion`,
        message: `The ${name} test checks only existence.`, impact: 'Incorrect content can pass.', suggestion: 'Assert rendered content.',
        replacement_code: null, specific_cypress_methods: ['cy.get', 'should'], context_used: ['Examples.cy.ts', 'Examples.ts'], confidence: 'high',
        evidence: [`Line ${line} checks only existence.`], standards_references: [heading], related_locations: [],
      })
      return response({
        overall_assessment: 'Both tests need stronger assertions.', summary: 'Assert rendered values.', strengths: [],
        findings: [makeFinding(2, 'ASSERT-ONE', 'first'), makeFinding(3, 'ASSERT-TWO', 'second')],
        standards_assessment: [], coverage_gaps: [], test_placement_issues: [], priorities: [], limitations: [], context_actually_used: ['Examples.cy.ts', 'Examples.ts'],
      })
    },
  })

  const result = await reviewer.audit('component', `## ${heading}\n\nAssert rendered values with retryable queries. [Retry-ability](${officialUrl})`, context, [])
  assert.equal(result.audit.execution.complete, true)
  assert.equal(result.findings.length, 2)
  assert.ok(result.findings.every(finding => finding.recommendation_code_kind === 'exact'))
  assert.match(result.findings[0]?.replacement_code ?? '', /contain\.text.*One/)
  assert.match(result.findings[1]?.replacement_code ?? '', /contain\.text.*Two/)
  assert.ok(result.audit.execution.adaptive_recoveries.some(item => item.includes('recommendation batch 1/1 subdivided')))
  assert.ok(result.audit.execution.passes.includes('standards-grounded recommendation enrichment'))
})
