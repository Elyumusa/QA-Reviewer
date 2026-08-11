import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDeepSeekConfiguration } from '../src/deepSeekConfig.js'

test('validates and normalizes DeepSeek configuration', () => {
  assert.deepEqual(resolveDeepSeekConfiguration({ DEEPSEEK_API_KEY: ' key ' }), {
    apiKey: 'key',
    model: 'deepseek-v4-pro',
  })
  assert.deepEqual(resolveDeepSeekConfiguration({
    DEEPSEEK_API_KEY: 'key',
    DEEPSEEK_MODEL: ' model ',
    DEEPSEEK_API_URL: 'https://example.test/chat/completions',
  }), {
    apiKey: 'key',
    model: 'model',
    apiUrl: 'https://example.test/chat/completions',
  })
})

test('rejects missing keys, empty models, and invalid endpoints', () => {
  assert.throws(() => resolveDeepSeekConfiguration({}), /Missing DEEPSEEK_API_KEY/)
  assert.throws(
    () => resolveDeepSeekConfiguration({ DEEPSEEK_API_KEY: 'key', DEEPSEEK_MODEL: '  ' }),
    /must not be empty/,
  )
  assert.throws(
    () => resolveDeepSeekConfiguration({ DEEPSEEK_API_KEY: 'key', DEEPSEEK_API_URL: 'not-a-url' }),
    /valid absolute HTTP\(S\) URL/,
  )
  assert.throws(
    () => resolveDeepSeekConfiguration({ DEEPSEEK_API_KEY: 'key', DEEPSEEK_API_URL: 'file:///tmp/model' }),
    /must use http:\/\/ or https:\/\//,
  )
})
