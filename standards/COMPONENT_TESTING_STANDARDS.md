# Frontend and Component Testing Standards

> **Audience:** Developers and AI coding agents  
> **Purpose:** Define clear, reliable testing practices for web components, browser-facing logic, and frontend utilities.

These standards apply mainly to Cypress component tests and frontend unit tests. End-to-end data setup, navigation, and persistence rules belong in the E2E testing standards.

---

## 1. Test Observable Behavior

Tests should verify what a component or function does, not repeat how it does it.

### Rules

- Drive components through public properties, methods, DOM interactions, and events where practical.
- Assert rendered DOM, emitted event details, returned values, state exposed through the public API, or deterministic drawing/output behavior.
- Never reproduce the source logic inside the test and then assert the values assigned by the test.
- A refactor that preserves behavior should not break most tests.
- Private implementation tests are allowed only when the behavior cannot be tested clearly through the public surface. Keep them small and explain why they are needed.

```typescript
// Bad: the test performs the behavior itself.
const hit = annotations.find(annotation => annotation.isHit(point))
if (hit) component.selectedAnnotation = hit
expect(component.selectedAnnotation).to.equal(hit)

// Good: the component handles the interaction.
cy.get('lvl-image-canvas').shadow().find('canvas')
    .trigger('mousedown', { clientX: 20, clientY: 20 })
cy.get('lvl-image-canvas').shadow().find('#textOverlay').should('be.visible')
```

---

## 2. Use the Correct Test Level

Choose the smallest test level that can prove the behavior.

| Test level | Use for |
|---|---|
| Unit test (Vitest) | Pure functions, geometry, transformations, validation, and data conversion |
| Component test (Cypress) | DOM rendering, user interaction, shadow DOM, component events, styles, canvas, and browser APIs |
| End-to-end test | Critical workflows across pages, APIs, authentication, and persistence |

Do not mount a component only to call a pure helper. Do not use an end-to-end test for behavior that a component test can verify reliably.

It is acceptable for a component spec to contain a small amount of unit-style logic when a real browser API is required. Large groups of pure tests should have separate unit-test files.

---

## 3. Write Assertions That Can Detect a Regression

Every test must contain at least one meaningful assertion tied to its title.

### Rules

- Assert the specific result, not only that a method exists or returned an object.
- `not.to.throw()` is suitable for a defensive no-crash contract, but it does not prove correct rendering or output.
- When a test title says “calculates,” assert the calculated value.
- When a test title says “renders,” assert rendered DOM or drawing calls.
- When a test title says “dispatches,” assert the event name and important `detail` values.
- When testing an exported `Blob`, also verify important content or that the expected drawing/export operation occurred.
- Avoid exact pixel assertions when anti-aliasing or browser differences make them unstable. Prefer deterministic regions, image dimensions, or context/paint call assertions.
- The test must execute the production behavior it claims to test. Creating a local result with the same logic and asserting that result is self-fulfilling.
- For early-return or no-op behavior, assert that the expected work did not happen, such as no request, callback, state transition, or rendered change.

```typescript
// Weak: passes even if the transform is wrong.
expect(component.toViewport).to.be.a('function')

// Strong: proves the round trip.
const viewportPoint = component.toViewport(imagePoint)
expect(component.toImage(viewportPoint)).to.deep.equal(imagePoint)
```

---

## 4. Keep Tests Independent

Official Cypress basis: [Test isolation](https://docs.cypress.io/app/core-concepts/test-isolation).

Each test must pass when run alone, in a different order, or with the rest of the suite.

### Rules

- Mount a fresh component for each test.
- Do not depend on state created by an earlier test.
- Keep fixtures deterministic and local. Prefer data URLs or fixtures over external URLs.
- Do not share mutable component instances, arrays, spies, or stubs between tests.
- Test setup should create only the state needed by that test.
- Keep shared hooks minimal. Put feature-specific body attributes, storage, intercepts, and fixtures in the smallest relevant `describe` or test.
- Do not create or repair Cypress infrastructure such as `[data-cy-root]` inside a test. Fix the mount/support configuration instead.
- Restore changes to global state such as `document`, `window`, `document.body`, `document.documentElement`, storage, timers, and global event handlers. Remove only the keys a test owns when possible.

Cypress component testing unmounts the component between tests, but code that modifies global objects can still leak if it is not restored.

---

## 5. Synchronize With Real Conditions

Official Cypress basis: [Retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability), [best practices for unnecessary waiting](https://docs.cypress.io/app/core-concepts/best-practices#Unnecessary-Waiting), and [`cy.wait()`](https://docs.cypress.io/api/commands/wait).

Do not use fixed delays to wait for a component.

### Rules

- Do not use `cy.wait(number)` for rendering, image loading, events, or state updates.
- Wait on retryable assertions, aliased requests, component events, or Lit's `updateComplete`.
- A mount helper may verify common readiness conditions such as the shadow root, canvas, image completion, and non-zero image dimensions.
- Use `.should()` for conditions that may become true asynchronously. Use `.then()` after readiness is established when direct synchronous access is required.
- An image with `complete === true` may still have failed. Check `naturalWidth > 0` when successful loading matters.
- If mounting automatically starts a request or lifecycle method, intercept before mounting and wait for that operation. Do not call the same private method again just to make the test observable.
- Synchronize one asynchronous operation with one meaningful condition. Avoid waiting for a request after the returned promise has already resolved unless the test is specifically checking request ordering.

```typescript
function getReadyCanvas(): Cypress.Chainable<ImageCanvas> {
    return cy.get<ImageCanvas>('lvl-image-canvas')
        .should(component => {
            expect(component.shadowRoot?.querySelector('canvas')).to.exist
            expect(component.image.complete).to.equal(true)
            expect(component.image.naturalWidth).to.be.greaterThan(0)
        })
        .then(component => component[0])
}
```

---

## 6. Use Stable Selectors and Shadow DOM Queries

Official Cypress basis: [selecting elements](https://docs.cypress.io/app/core-concepts/best-practices#Selecting-Elements), [shadow DOM queries](https://docs.cypress.io/api/commands/shadow), and [actionability](https://docs.cypress.io/app/core-concepts/interacting-with-elements).

### Selector order

1. Component tag for the mounted root, such as `lvl-image-canvas`.
2. Stable semantic attributes such as `data-cy`, `name`, `role`, or `data-action`.
3. Stable IDs inside a component's own shadow root.
4. CSS classes only when the class itself is part of the contract.

Prefer Cypress queries for rendered UI:

```typescript
cy.get('lvl-image-canvas').shadow().find('canvas').should('be.visible')
```

Direct `shadowRoot.querySelector()` is acceptable for low-level browser API setup, but it loses Cypress retrying and command logging. Establish readiness first and assert that the element exists.

Avoid positional selectors such as `.eq(2)` unless order is the behavior being tested.

Prefer `data-*` selectors for important test interactions when no existing semantic selector is part of the component contract. Use `force: true` only when bypassing Cypress actionability is intentional; otherwise let visibility and obstruction failures reveal real UI problems.

For file inputs and drag/drop, prefer Cypress’s real file interaction commands such as `selectFile()` when they express the behavior. Use manual `DataTransfer` or event objects only when testing a browser API boundary that the Cypress command cannot represent.

---

## 7. Limit Private Implementation Access

Private fields and methods are not the component contract. Heavy access to them makes tests fragile during safe refactors.

### Preferred order

1. Test through DOM interaction and observable output.
2. Test through public properties, methods, and custom events.
3. Move pure internal logic into a separately testable utility or class.
4. Use a narrow white-box test only when the first three options are impractical.

When white-box access is necessary:

- Keep the cast or test adapter local to a helper instead of repeating `as any` throughout the file.
- Define only the members the test needs.
- Do not make production members public only to satisfy tests.
- Prefer assertions on the effect of the private method, not every intermediate field.
- Treat a large number of private tests as a design signal: the component may contain logic that belongs in a separate class or utility.

Use strong types for normal component access. A justified test-only boundary cast is better than disabling typing across an entire test.

---

## 8. Stub Boundaries, Not the Behavior Under Test

Official Cypress basis: [`cy.intercept()`](https://docs.cypress.io/api/commands/intercept), [`cy.stub()`](https://docs.cypress.io/api/commands/stub), and [`cy.spy()`](https://docs.cypress.io/api/commands/spy).

Mocks and stubs should control external or unstable boundaries without replacing the logic the test claims to verify.

### Good candidates for stubbing

- Network requests.
- Time, randomness, browser dialogs, and unavailable browser APIs.
- Image load success or failure.
- Canvas context methods when verifying drawing commands.
- Expensive child components that are outside the test's scope.

### Rules

- Prefer `cy.stub()` and `cy.spy()` because Cypress manages their test lifecycle.
- Do not replace the method whose behavior is the subject of the test.
- Stub the smallest possible boundary.
- Avoid assigning directly to globals such as `document.createElement`.
- If direct replacement is unavoidable, save the original and restore it in guaranteed cleanup, even when an assertion fails.
- Do not manually assign `event.target`; dispatching an event on the element sets its target.
- Assert that the stub was called with meaningful arguments when the call is part of the contract.
- Scope intercepts and stubs to the smallest test or feature group. Avoid catch-all successful responses that can make an unintended request look valid.
- Global exception handlers should be rare, narrowly matched, and documented with the known issue they intentionally ignore. Do not use them to hide component failures.
- Do not stub a broad DOM method such as `shadowRoot.querySelector()` when a real child element or a small test adapter can provide the boundary.

```typescript
// Fragile: restoration is skipped if an assertion throws.
const original = document.createElement
document.createElement = fakeCreateElement
component.applyCrop()
expect(callback).to.have.been.called
document.createElement = original

// Preferred: scoped and automatically restored by Cypress.
cy.stub(document, 'createElement').callsFake(fakeCreateElement)
component.applyCrop(callback)
expect(callback).to.have.been.calledOnce
```

---

## 9. Keep Test Files Focused and Readable

### Rules

- Group tests by public behavior or feature, not by private method name alone.
- Put tests for different classes in their own files when the groups become substantial.
- Use names that describe the condition and expected result: `when image loading fails, dispatches image-error with the source`.
- Extract repeated setup after it appears in several tests and has a clear name.
- Keep helpers small. Avoid page-object-style abstractions for a single component.
- Use data-driven cases for the same behavior across several tools or values.
- Do not hide important test actions or assertions inside overly generic helpers.
- Keep a component spec focused on the component. Move substantial service, cache, and pure-helper groups into their own unit or service specs.
- Avoid duplicate tests that exercise the same path with the same fixture. Prefer a focused test or a data-driven case that makes the meaningful difference explicit.

---

## 10. Cover Important Branches Without Chasing Coverage Numbers

Include representative coverage for:

- Happy paths and expected user flows.
- Empty, null, invalid, and failed-load states.
- Minimum, maximum, and boundary values.
- Both sides of meaningful conditions.
- Event payloads and state transitions.
- Cleanup and disconnected lifecycle behavior when resources are registered.
- Public behavior across supported browsers when browser APIs differ.

For browser-facing boundaries, cover the meaningful boundary rather than only a type or truthy value: exact size limits, valid and invalid files, event payloads, request bodies, cleanup calls, and the visible result.

Coverage reports help find untested code, but weak assertions must not be added only to increase a percentage.

---

## 11. Workflow for Developers and AI Coding Agents

Before adding or changing tests:

1. Read the component implementation, public API, related types, and existing tests.
2. Identify the behavior and choose the correct test level.
3. Trace the test: action → production code → observable result.
4. Confirm the test would fail if the behavior were removed or made incorrect.
5. Run the focused test, then run the relevant suite.
6. Review the diff for accidental production changes, arbitrary waits, broad mocks, and unrelated edits.

AI agents must not add empty tests, self-fulfilling assertions, or broad mocks to make coverage appear complete. If a requirement is unclear, state the assumption in the test name or request clarification before changing production behavior.

---

## Review Checklist

- [ ] The test title matches the action and assertion.
- [ ] The test executes production behavior instead of reproducing it.
- [ ] A no-op or early-return test proves that no expected work occurred.
- [ ] Assertions verify meaningful output, values, or event details.
- [ ] The test uses the smallest suitable test level.
- [ ] The test passes independently and uses deterministic data.
- [ ] Shared setup is scoped, and global state is restored.
- [ ] Async behavior waits on a real condition, not a fixed delay.
- [ ] Lifecycle-triggered requests are not duplicated by manually calling the same path.
- [ ] DOM queries use stable selectors and explicit shadow traversal.
- [ ] Forced interactions and synthetic browser events are justified.
- [ ] Private access is limited and justified.
- [ ] Stubs control boundaries and are safely restored.
- [ ] Types are preserved; broad `as any` usage is avoided.
- [ ] The focused test and relevant suite have been run.

## References

- [Cypress component testing](https://docs.cypress.io/app/component-testing/get-started)
- [Cypress best practices](https://docs.cypress.io/app/core-concepts/best-practices)
- [Cypress conditional testing](https://docs.cypress.io/app/guides/conditional-testing)
- [Cypress retry-ability](https://docs.cypress.io/app/core-concepts/retry-ability)
- [Cypress test isolation](https://docs.cypress.io/app/core-concepts/test-isolation)
- [Cypress shadow DOM command](https://docs.cypress.io/api/commands/shadow)
- [Cypress wait command](https://docs.cypress.io/api/commands/wait)
- [Cypress selectFile command](https://docs.cypress.io/api/commands/selectfile)
