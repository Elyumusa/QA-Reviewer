import type { Finding } from './types.js'

interface Rule {
  pattern: RegExp
  createFinding(line: number, match: RegExpMatchArray): Finding
}

const rules: Rule[] = [
  {
    pattern: /\b(describe|it|context)\.only\s*\(/,
    createFinding: (line, match) => ({
      line,
      severity: 'critical',
      rule: 'CYPRESS-FOCUS-001',
      category: 'quality',
      title: `Focused ${match[1] ?? 'test'} committed with .only`,
      message: 'A focused test prevents the rest of the selected suite from running.',
      suggestion: `Remove .only from ${match[1] ?? 'the test declaration'} before committing this file.`,
      replacement_code: null,
      specific_cypress_methods: [],
      context_used: ['test file'],
      confidence: 'high',
      source: 'deterministic',
    }),
  },
  {
    pattern: /\bcy\.wait\(\s*(\d(?:[\d_]*))\s*\)/,
    createFinding: (line, match) => ({
      line,
      severity: 'high',
      rule: 'CYPRESS-ASYNC-001',
      category: 'quality',
      title: `Fixed-duration wait of ${match[1] ?? 'unknown'}ms`,
      message: 'This test synchronizes with elapsed time instead of an observable application condition, which can make it slow and flaky.',
      suggestion: 'Synchronize with the specific request alias, rendered state, component event, or updateComplete associated with the preceding action. Exact replacement code is left to the context-aware review because an endpoint or UI condition cannot be inferred safely from this line alone.',
      replacement_code: null,
      specific_cypress_methods: ['cy.wait'],
      context_used: ['test file'],
      confidence: 'high',
      source: 'deterministic',
    }),
  },
  {
    pattern: /\b(describe|it|context)\.skip\s*\(/,
    createFinding: (line, match) => ({
      line,
      severity: 'medium',
      rule: 'CYPRESS-SKIP-001',
      category: 'quality',
      title: `Skipped ${match[1] ?? 'test'} committed with .skip`,
      message: 'Skipped tests silently remove intended coverage from the suite.',
      suggestion: `Restore ${match[1] ?? 'the test'} or remove it with a tracked explanation outside the test suite.`,
      replacement_code: null,
      specific_cypress_methods: [],
      context_used: ['test file'],
      confidence: 'high',
      source: 'deterministic',
    }),
  },
]

export function runDeterministicChecks(content: string): Finding[] {
  const findings: Finding[] = []
  const lines = content.split('\n')

  lines.forEach((lineContent, index) => {
    const trimmed = lineContent.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      return
    }

    for (const rule of rules) {
      const match = lineContent.match(rule.pattern)
      if (match) {
        findings.push(rule.createFinding(index + 1, match))
      }
    }
  })

  return findings
}
