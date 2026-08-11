import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultModelForProvider, resolveAiConfiguration, resolveAiProviderId } from '../src/aiConfig.js'

test('resolves provider names, aliases, and current defaults', () => {
  assert.equal(resolveAiProviderId(undefined), 'deepseek')
  assert.equal(resolveAiProviderId('OpenAI'), 'openai')
  assert.equal(resolveAiProviderId('claude'), 'anthropic')
  assert.equal(defaultModelForProvider('openai'), 'gpt-5.6-sol')
  assert.equal(defaultModelForProvider('anthropic'), 'claude-sonnet-5')
  assert.throws(() => resolveAiProviderId('unknown'), /deepseek, openai, or anthropic/)
})

test('resolves OpenAI and Anthropic provider-specific configuration', () => {
  const openai = resolveAiConfiguration('openai', { OPENAI_API_KEY: ' open-key ' })
  assert.equal(openai.model, 'gpt-5.6-sol')
  assert.equal(openai.apiUrl, 'https://api.openai.com/v1/chat/completions')
  assert.equal(openai.adapter.id, 'openai')

  const anthropic = resolveAiConfiguration('anthropic', {
    ANTHROPIC_API_KEY: 'claude-key',
    ANTHROPIC_MODEL: ' custom-claude ',
    ANTHROPIC_VERSION: '2023-06-01',
  })
  assert.equal(anthropic.model, 'custom-claude')
  assert.equal(anthropic.adapter.id, 'anthropic')
})

test('reports the exact missing provider key and rejects malformed overrides', () => {
  assert.throws(() => resolveAiConfiguration('openai', {}), /Missing OPENAI_API_KEY/)
  assert.throws(() => resolveAiConfiguration('anthropic', {}), /Missing ANTHROPIC_API_KEY/)
  assert.throws(
    () => resolveAiConfiguration('openai', { OPENAI_API_KEY: 'key', OPENAI_API_URL: 'file:///tmp/api' }),
    /must use http:\/\/ or https:\/\//,
  )
  assert.throws(
    () => resolveAiConfiguration('anthropic', { ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: ' ' }),
    /ANTHROPIC_MODEL must not be empty/,
  )
})
