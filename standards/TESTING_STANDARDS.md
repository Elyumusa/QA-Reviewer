# Levelbuild E2E Testing Standards

> **Purpose:** This document defines the conventions, patterns, and rules that all engineers and AI agents **must follow** when writing Cypress end-to-end tests for the Levelbuild WebApp. It is derived from real issues encountered during test development and represents the team's agreed best practices.

---

## Table of Contents

0. [Understand the Implementation (Pre-requisite)](#0-understand-the-implementation-pre-requisite)
1. [Test Isolation & Data Ownership](#1-test-isolation--data-ownership)
2. [Setup Hooks: `before()` vs `beforeEach()`](#2-setup-hooks-before-vs-beforeeach)
3. [Data Design for Tests](#3-data-design-for-tests)
4. [Cypress Aliases](#4-cypress-aliases)
5. [Selectors & Querying](#5-selectors--querying)
6. [Shadow DOM Navigation](#6-shadow-dom-navigation)
7. [Tree Structures & Expandable Rows](#7-tree-structures--expandable-rows)
8. [Handling Async State & Conditional UI](#8-handling-async-state--conditional-ui)
9. [Toast / Notification Assertions](#9-toast--notification-assertions)
10. [Asserting Data Persistence](#10-asserting-data-persistence)
11. [Testing Hidden Context & Advanced Field States](#11-testing-hidden-context--advanced-field-states)
12. [Helper Functions](#12-helper-functions)
13. [Anti-Patterns: What NOT to Do](#13-anti-patterns-what-not-to-do)
14. [Quick Reference Cheatsheet](#14-quick-reference-cheatsheet)

---

## 0. Understand the Implementation (Pre-requisite)

### The First Step in Any Test

> **Before writing or attempting to fix any test, you must first study the source code of the component or feature you are trying to test.**

Many E2E testing mistakes happen because test authors guess how the UI renders data or handles events based on backend logic or API payloads. However, the DOM rendered by Levelbuild custom elements (which is what Cypress interacts with) is often heavily transformed through formatters and services.

### ✅ What to do
Whenever assigned to test a feature, you MUST:
1. Identify the core components responsible for rendering and business logic (e.g., `lvl-table`, `lvl-multi-data-view`, `SerializerService`).
2. **Read their implementation files** to understand exactly how they map backend data to the DOM.
3. If the file paths to the component's implementation are not provided, explicitly ask the initiating engineer: **"Please provide the file paths to the implementation of the feature/components being tested so I can analyze how the UI works before writing the test."**

### 💡 Lesson Learned: Why this matters
When testing a Boolean value in a data grid, the API payload sends `true` or `false`. A naive test might look for the text "False" in the DOM and fail. Why? Because studying the implementation of the `SerializerService` reveals that readonly booleans are rendered as FontAwesome icons (`<i class="fa-light fa-xmark"></i>`). We could only know to assert against the icon's CSS class rather than text by tracing the code!

---

## 1. Test Isolation & Data Ownership

### The Golden Rule

> **Each test that mutates data must exclusively own the records it mutates. Shared records must be read-only.**

Tests that share mutable state are the single most common source of flaky, order-dependent failures. When test A renames a record that test B relies on, test B will fail — but only when run together with test A. This makes failures extremely hard to diagnose.

### ✅ Correct

```typescript
// Each test has its own dedicated record it is free to mutate
cy.createRecord('@dataSource', { values: { name: 'Alice Anderson', ... } }).as('recordTest1')
cy.createRecord('@dataSource', { values: { name: 'Bob Brown', ... } }).as('recordTest2')
cy.createRecord('@dataSource', { values: { name: 'Charlie Clark', ... } }).as('recordTest3')

// it('test 1') → only touches Alice Anderson
// it('test 2') → only touches Bob Brown
// it('test 3') → only touches Charlie Clark
```

### ❌ Incorrect

```typescript
// One record used by multiple tests — the first test that mutates it breaks all subsequent ones
cy.createRecord('@dataSource', { values: { name: 'Shared Record', ... } }).as('sharedRecord')

// it('test 1') renames 'Shared Record' → 'Updated Record'
// it('test 2') tries to find 'Shared Record' → NOT FOUND — test fails
```

### When You Need Shared Records

Sometimes a record must exist only to support other records (e.g. a parent in a self-referencing tree). In this case:

- Create a **dedicated, role-specific record** whose sole purpose is that support role
- **No test ever mutates it**
- Name it clearly to signal its purpose (e.g. `TreeParent Anderson`)
- Document in the `before()` comment that it is read-only

```typescript
// ✅ Dedicated read-only parent record for the tree structure tests.
// No test ever mutates this record — its name is permanently stable.
cy.createRecord('@dataSource', {
    values: { name: 'TreeParent Anderson', department: 'Management', ... },
    groups: [...]
}).as('treeParentRecord')

// Bob's parentLookup points to TreeParent Anderson, NOT to Alice.
// Test 1 is free to rename Alice without affecting Bob's tree.
cy.get('@treeParentRecord').then((treeParent: any) => {
    cy.createRecord('@dataSource', {
        values: { name: 'Bob Brown', parentLookup: treeParent.id, ... },
        ...
    }).as('recordTest2')
})
```

---

## 2. Setup Hooks: `before()` vs `beforeEach()`

### Rule of Thumb

| Hook | Use For | Cost |
|---|---|---|
| `before()` | One-time expensive infrastructure: datastores, fields, pages, ACLs, columns, base records | High — runs once per `describe` |
| `beforeEach()` | Cheap per-test setup: navigation, aliasing UI elements, resetting lightweight state | Low — runs before every test |
| `afterEach()` | Cheap per-test teardown: aborting edit modes, closing dialogs | Low |
| `after()` | Expensive teardown: database cleanup | High — runs once |

### ✅ Use `before()` for infrastructure

```typescript
before(() => {
    cy.createDataStore(...)
    cy.createDataSource(...)
    cy.createField(...)
    cy.createPage(...)
    cy.createRecord(...)  // long-lived test data
})
```

### ✅ Use `beforeEach()` only for cheap, per-test operations

```typescript
beforeEach(() => {
    cy.visit('/Public/Pages/MyPage')
    cy.get('lvl-toaster').as('toaster')
})
```

### ❌ Do NOT use `beforeEach()` for expensive infrastructure

Recreating datastores, fields, pages, and records before every single test makes the suite prohibitively slow and fragile.

### 💡 Lesson Learned: Admin Config vs Page Navigation

A common mistake is bundling **backend configuration** (e.g., visiting an Admin page and toggling "Expandable" or "Inline Edit") with **test navigation** (e.g., visiting the public List page).

- **Configure Once:** Admin panels that save settings to the database should be visited **exactly once** in the `before()` hook.
- **Navigate Often:** Visiting the public URL where the test happens belongs in the `beforeEach()` hook.

```typescript
// ✅ CORRECT: Split config from navigation
before(() => {
    // ... infrastructure
    configureExpandableList() // Executes DB-saving admin clicks ONCE
})

beforeEach(() => {
    cy.visit('/Public/Pages/InlineEditQ') // Fast, runs before every test
})
```

---

## 3. Data Design for Tests

### Naming Conventions

- Use **realistic, distinct full names** for test records so failures are easy to read (e.g. `Alice Anderson`, `Bob Brown`, `Charlie Clark`)
- Name each record after the test that owns it — put a comment above it
- Name shared/support records to signal their role (e.g. `TreeParent Anderson`, `LookupDept Engineering`)

### Record Creation Pattern

```typescript
// Record for test: "should persist data updates after successful inline edit"
// NOTE: This record is exclusively owned by that test. No other test references it.
cy.createRecord('@dataSource', {
    values: {
        name: 'Alice Anderson',
        email: 'alice@example.com',
        department: 'Engineering',   // mandatory fields must always be included
        employeeId: 'EMP001',        // unique fields must be unique across all test records
        salary: 75000.00
    },
    groups: ['InlineEditACL_' + guid]
}).as('recordTest1')
```

### Uniqueness

- **Unique fields** (e.g. `employeeId`) must be unique across ALL records in the same test suite, not just within a single test
- Use a sequential naming scheme: `EMP001`, `EMP002`, `EMP003`, etc.
- Use the describe-scope `guid` variable to namespace anything that could collide across test runs (ACL names, datastore names)

---

## 4. Cypress Aliases

### Core Rules

- **Always use aliases** (`.as('name')`) to store and reuse references to records, UI elements, and data
- **Aliases set in `before()` do NOT persist into `it()` blocks** — this is a fundamental Cypress behaviour. Do not try to use them.
- **Aliases set in `beforeEach()` persist for the duration of that single test** — safe to use within `it()` blocks

### Describe-Scope Variables (Use Sparingly)

When you genuinely need to share scalar values (like IDs or names) between `before()` and `it()` — and aliases are not viable — JavaScript closure variables declared at the `describe` scope are acceptable **only if**:

1. They are primitive values (`string`, `number`), not Cypress subjects
2. There is no alternative (e.g. the value is needed in multiple tests)
3. They are documented with a comment explaining why

```typescript
describe('My Suite', () => {
    let queryPageId = ''   // ✅ Primitive, set once in before(), used in navigation

    before(() => {
        cy.createPage(..., (pageId) => { queryPageId = pageId })
    })

    it('navigates to the page', () => {
        cy.visit(`/Public/Pages/${queryPageId}`)
    })
})
```

> ⚠️ **Never** store Cypress subjects (DOM elements, jQuery objects) in JS variables. Always use `.as()` aliases for those.

---

## 5. Selectors & Querying

### Priority Order (Most Preferred → Least Preferred)

1. **Stable attribute selectors** — `data-action`, `data-column`, `name`, `icon`, `output-name`
2. **Text content filter** — `.filter((_, el) => el.textContent?.includes('...'))`
3. **CSS class selectors** — only for well-established, semantic classes (e.g. `.row__inline_edit`)
4. **`data-id` attribute** — only when the record's display values are intentionally mutable and no stable text alternative exists

### ✅ Preferred: Attribute and text selectors

```typescript
// By stable attribute
cy.get('lvl-button[icon="pen-field"]').click()
cy.get('lvl-input[name="email"]').shadow().find('input')
cy.get('.table__cell[data-column="email"] .cell__content')

// By stable text (when the test owns the record and its name won't change)
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('Alice Anderson'))
    .as('aliceRow')
```

### ❌ Avoid: Positional selectors and dynamic IDs

```typescript
// ❌ Breaks when order changes
cy.get('lvl-table-row').eq(2)

// ❌ Brittle — class names may change with refactors
cy.get('.row-item-wrapper > div > span')
```

### Text Filter Pattern

When filtering rows by text content across shadow DOM, always use the `.filter()` callback form:

```typescript
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes(targetName))
    .as('targetRow')
    .should('exist')
```

> Note: `.contains()` does not pierce shadow DOM. Always use `.filter()` with `shadowRoot.textContent` for custom elements.

---

## 6. Shadow DOM Navigation

### The `lvl-*` Component Pattern

All Levelbuild UI components are custom elements with shadow roots. To interact with their internals:

```typescript
// ✅ Always pierce shadow DOM with .shadow() before finding children
cy.get('lvl-input[name="email"]')
    .shadow()
    .find('input')
    .type('test@example.com')

// ✅ Chain .shadow() at each custom element boundary
cy.get('lvl-autocomplete[name="departmentLookup"]')
    .shadow()
    .find('lvl-input-button[icon-css="chevron-down"]')
    .shadow()
    .find('button')
    .click()
```

### Common Component Patterns

| Goal | Selector Pattern |
|---|---|
| Click a button | `cy.get('lvl-button[data-action="save"]').shadow().find('button').click()` |
| Type into an input | `cy.get('lvl-input[name="name"]').shadow().find('input').clear().type('value')` |
| Check a toggle | `cy.get('lvl-toggle[name="isActive"]').shadow().find('input').check()` |
| Read a checkbox | `cy.get('lvl-checkbox').shadow().find('input[type="checkbox"]')` |
| Open an autocomplete | `cy.get('lvl-autocomplete[name="..."]').shadow().find('lvl-input-button').shadow().find('button[tabindex="-1"]').click()` |

### Scoping with `.within()`

When asserting on multiple parts of the same shadow root, use `.shadow().within()` to avoid repeated traversal:

```typescript
cy.get('@targetRow').shadow().within(() => {
    cy.get('.table__cell[data-column="email"] .cell__content').should('contain.text', 'alice@example.com')
    cy.get('.table__cell[data-column="age"] .cell__content').should('contain.text', '28')
    cy.get('.table__cell[data-column="balance"] .cell__content').should('contain.text', '1200.00')
})
```

---

## 7. Tree Structures & Expandable Rows

### How Tree Rows Work

When a `MultiData` page view is configured with an **Expandable** setting and a **parent field** (a self-referencing lookup), child records are **not rendered as top-level rows**. They are nested inside the parent row's shadow DOM under `.row__children`.

This means:

- **Searching for a child record at the top level will always fail** — it does not exist there
- You must first expand the parent row, then query within `row__children`

### ✅ Correct: Expand first, then find child

```typescript
// 1. Find the parent row at the top level
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('TreeParent Anderson'))
    .as('parentRow')
    .should('exist')

// 2. Expand to reveal children
cy.get('@parentRow').shadow().find('i[data-action="expand"]').click({ force: true })

// 3. Find the child row INSIDE the parent's .row__children
cy.get('@parentRow').shadow().find('.row__children lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('Bob Brown'))
    .as('childRow')
    .should('exist')

// 4. Interact with the child row
cy.get('@childRow').shadow().find('.table__row').trigger('mouseenter', { force: true })
cy.get('@childRow').shadow().find('lvl-button[icon="pen-field"]').click({ force: true })
```

### After Save: Tree Always Collapses

After a successful save, the table data refreshes with `openNodes=[]`. This means the tree **always reloads collapsed** — the parent row's children will be gone from the DOM. To verify updated values in a child after saving:

```typescript
// ✅ Always unconditionally re-expand after a save — do not use a conditional check
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('TreeParent Anderson'))
    .as('parentRow')
cy.get('@parentRow').shadow().find('i[data-action="expand"]').click({ force: true })

cy.get('@parentRow').shadow().find('.row__children lvl-table-row', { timeout: 10000 })
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('Bob Brown - Updated'))
    .should('exist')
```

---

## 8. Handling Async State & Conditional UI

### ❌ Anti-Pattern: Conditional DOM check inside `.then()`

It is tempting to use `.then()` to check whether an element exists before deciding what to do. **This is a Cypress anti-pattern** because:

- `.then()` captures a jQuery snapshot at a single point in time
- Cypress commands queued inside `.then()` (like `.click()`) do not block the next command in the outer chain
- The assertion after the `.then()` may run before the inner command has had any effect

```typescript
// ❌ WRONG — the click inside .then() does NOT block subsequent assertions
cy.get('@parentRow').shadow().find('.row__children lvl-table-row').then($rows => {
    if ($rows.length === 0) {
        cy.get('@parentRow').shadow().find('i[data-action="expand"]').click({ force: true })
    }
})
// This assertion may run before the click above takes effect
cy.get('@parentRow').shadow().find('.row__children lvl-table-row').should('exist')
```

### ✅ Correct: Deterministic, unconditional commands

When you know the state the application will be in (e.g. "after save, tree always collapses"), encode that as a deterministic command — not a conditional:

```typescript
// ✅ CORRECT — unconditional expand, then assert with sufficient timeout
cy.get('@parentRow').shadow().find('i[data-action="expand"]').click({ force: true })
cy.get('@parentRow').shadow().find('.row__children lvl-table-row', { timeout: 10000 })
    .should('exist')
```

### Using `{ timeout }` on Assertions

When an element appears asynchronously (after a network request, after an expand animation), add an explicit `timeout` to give Cypress enough time to retry:

```typescript
cy.get('.row__children lvl-table-row', { timeout: 10000 }).should('exist')
```

---

## 9. Toast / Notification Assertions

### Two Types of Toasts

| Toast Type | Component | When Used |
|---|---|---|
| Mini toast (auto-dismiss) | `lvl-toast-mini` | Inline save success, simple validation errors |
| Full toast | `lvl-toast[type="error"]` | Server-side errors (e.g. unique constraint violations) |

### ✅ Success Toast Helper

```typescript
function checkSuccessToast() {
    cy.get('@toaster').should('exist')
    cy.get('@toaster').shadow().find('lvl-toast-mini').should('exist')
    cy.get('@toaster').shadow().find('lvl-toast-mini[open]').should('exist')
    // Wait for auto-dismiss
    cy.get('@toaster').shadow().find('lvl-toast-mini', { timeout: 10000 }).should('not.exist')
}
```

### ✅ Error Toast Helper

```typescript
function checkErrorToast(expectedMessage?: string) {
    cy.get('@toaster').shadow().within(() => {
        cy.get('lvl-toast-mini[open]').should('exist').and('be.visible')
        if (expectedMessage) {
            cy.get('lvl-toast-mini[open]').should('contain.text', expectedMessage)
        }
        cy.get('lvl-toast-mini[open]', { timeout: 10000 }).should('not.exist')
    })
}
```

### ✅ Full (Server) Error Toast

```typescript
// For server-side errors like unique constraint violations
cy.get('@toaster').shadow().find('lvl-toast[type="error"]')
    .invoke('text').should('contain', 'already exists')

// Always close it before continuing
cy.get('@toaster').shadow().find('lvl-toast[type="error"]')
    .shadow().find('lvl-button[data-action="close"]').click()
```

### Always Alias the Toaster Early

Alias `lvl-toaster` at the start of every test (or in `navigateToListPage()`), before any actions that could trigger a notification:

```typescript
cy.get('lvl-toaster').as('toaster')
```

---

## 10. Asserting Data Persistence

### The Core Principle

> **A success toast does not prove the data is correct. You must verify the updated values in the actual DOM table.**

When testing edits, it is easy to stop after calling `checkSuccessToast()`. However, this only proves the API returned a 200 OK. It does **not** prove that what you typed was actually saved, nor does it prove that the table correctly refreshed to show the new data.

### ✅ Correct Verification Flow

Every edit test must follow this sequence:
1. Make the edit
2. Click save
3. Verify the success toast
4. Verify the edit form disappeared
5. **Re-query the row and assert the new values exist in the cells**

```typescript
// 1 & 2. Edit and Save
cy.get('@saveBtn').click()

// 3. Verify System Success
checkSuccessToast()

// 4. Verify UI State (mode closed)
cy.get('lvl-table').shadow().find('.row__inline_edit').should('not.exist')

// 5. 🚨 VITAL: Verify Persistence in the DOM
// Re-find the row (if the name changed, use the new name!)
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes(newTargetName))
    .as('updatedRow')
    .should('exist')

// Verify specific cell formats (crucial for Dates, Booleans, Lookups)
cy.get('@updatedRow').shadow().within(() => {
    // Note: We assert against the rendered UI format (MM/DD/YYYY), not the raw API payload (YYYY-MM-DD)!
    cy.get('.table__cell[data-column="birthDate"] .cell__content').should('contain.text', '04/15/1995')
    cy.get('.table__cell[data-column="isActive"]').should('contain.text', 'False')
})
```

### 💡 Lesson Learned: Data Formats in the DOM vs API

A common mistake when verifying data persistence is asserting against the raw backend data format (e.g., ISO dates like `1995-04-15` or raw booleans like `false`). 

**Cypress's `.should('contain.text', ...)` reads the exact rendered UI string.**
The table cells render localized, user-friendly formats. You must assert against exactly what the user sees on the screen:

- **Dates:** `04/15/1995` (Not `1995-04-15`)
- **Booleans:** Often rendered as icons, e.g., `<i class="fa-light fa-xmark"></i>`. In this case, assert on the class: `.should('have.class', 'fa-xmark')`. (Not native JS `false` or text `False`)
- **Lookups:** The display property `Department Name` (Not the Guid `123e4567-e89b...`)

```typescript
// ❌ WRONG: Asserting against the API payload format or expecting text for an icon
cy.get('.cell__content').should('contain.text', '1995-04-15')
cy.get('.cell__content').should('contain.text', 'False')

// ✅ CORRECT: Asserting against the formatted UI string or rendered icon classes
cy.get('.cell__content').should('contain.text', '04/15/1995')
cy.get('.cell__content i').should('have.class', 'fa-xmark')
```

---

## 11. Testing Hidden Context & Advanced Field States

### Missing Data & Background Fetching (Autocomplete Filters)

Levelbuild custom grids, such as `lvl-table`, heavily optimize data fetching. Often, fields required for form logic (like `filterReferenceText` used as a Dynamic Filter against an Autocomplete Dropdown) are completely excluded from the public List View query for performance reasons. However, when the user clicks the "edit" or "expand" icon, the UI needs those hidden fields to properly evaluate logic.

> **Lesson Learned:** Always construct tests to verify that the UI correctly realizes it is missing data and smoothly fetches it in the background without breaking user interaction.

### ✅ Simulating & Testing Background Fetching
To properly test frontend reactivity to missing context:
1. Create a "hidden" field in the backend schema during `before()` setup.
2. **Explicitly omit** this field when building the List View columns.
3. Configure dependent logic (e.g. an Autocomplete filter that compares against `##hiddenField##`).
4. Activate the edit sequence and assert that the dependent logic (the dropdown options) correctly resolves, proving the frontend instantly fetched the missing dependencies behind the scenes!

```typescript
// 1. Omit the hidden field from the View rendering
cy.forEachField(dataSourceId, true, (field, index) => {
    if (field.name !== 'filterReferenceText') {
        cy.createColumn(listId, field.id, index + 1)
    }
})

// 2. Open dropdown & assert that the filter was successfully applied
cy.get('@dropdownMenu')
    .find('tr')
    .should('contain.text', 'Engineering')
    .and('not.contain.text', 'Marketing') // The fetch worked! Marketing is successfully filtered out.
```

### Asserting Read-Only/Disabled Field States

Levelbuild has multiple conditions that mandate a cell remain strictly "read-only" during inline editing:
*   **System Fields:** (`id`, `createdAt`) Inherently protected.
*   **Virtual Fields:** Sourced from foreign relationships.
*   **Explicitly Disabled:** Standard fields marked with `inlineEditReadonly: true`.

> **Lesson Learned:** You cannot just verify that one type of read-only field works and assume the mechanism is perfect. You must configure scenarios for *all* types of architectural read-only conditions in Levelbuild. 

### ✅ How to Verify Read-Only States
A common E2E mistake is attempting to type into a readonly field and expecting an error, or checking for a `readonly` property on an input. The correct way Levelbuild handles readonly properties during inline edit is by completely refusing to render an interactive `lvl-input` component.

```typescript
// ✅ CORRECT: Verify the read-only fields do not render active editable inputs
cy.get('@targetRow').shadow().find('.row__inline_edit').then($row => {
    // 1. System ID
    cy.wrap($row.find('lvl-input[name="id"]')).should('not.exist')
    
    // 2. Virtual Field
    cy.wrap($row.find('lvl-input[name="virtualDeptName"]')).should('not.exist')
    
    // 3. Explicitly Disabled Field
    cy.wrap($row.find('lvl-input[name="noInlineEditField"]')).should('not.exist')
})
```

---

## 12. Helper Functions

### When to Extract a Helper

Extract repeated interaction sequences into named helper functions when:

- The same sequence of commands appears in 3 or more tests
- The sequence has a stable, descriptive name (e.g. "edit a record", "navigate to list page")

### Parameterise for Flexibility

Helper functions should support common variations via parameters rather than duplicating them:

```typescript
// ✅ Single helper covering both top-level and child rows
function editRecord(
    targetName: string,
    newValue: string,
    action: 'save' | 'cancel' = 'save',
    parentName?: string  // optional: pass to handle tree child rows
) {
    if (parentName) {
        // Find and expand parent, then scope to child
        cy.get('lvl-table').shadow().find('lvl-table-row')
            .filter((_, row) => !!row.shadowRoot?.textContent?.includes(parentName))
            .as('parentRow').should('exist')
        cy.get('@parentRow').shadow().find('i[data-action="expand"]').click({ force: true })
        cy.get('@parentRow').shadow().find('.row__children lvl-table-row')
            .filter((_, row) => !!row.shadowRoot?.textContent?.includes(targetName))
            .as('targetRow').should('exist')
    } else {
        cy.get('lvl-table').shadow().find('lvl-table-row')
            .filter((_, row) => !!row.shadowRoot?.textContent?.includes(targetName))
            .as('targetRow')
    }
    // ... shared edit logic continues
}
```

### Keep Helpers Inside the `describe` Block

Helpers that reference shared variables (like `guid`, aliases, or helper functions like `checkSuccessToast`) should be declared as functions inside the `describe` block, not at the module level, to keep them in the same scope.

---

## 13. Anti-Patterns: What NOT to Do

### ❌ Sharing mutable records across tests

Records that any test modifies must not be referenced by any other test.

### ❌ Conditional DOM state checks inside `.then()`

Do not use `if ($el.length === 0)` inside `.then()` to conditionally queue Cypress commands. This is non-deterministic. Instead, design your test to know the application state and issue unconditional commands.

### ❌ JS closure variables for Cypress subjects

```typescript
// ❌ Never do this
let myRow: JQuery<HTMLElement>
cy.get('lvl-table-row').then($row => { myRow = $row })
cy.wrap(myRow).click() // undefined — Cypress commands are async
```

Use `.as()` aliases instead:
```typescript
cy.get('lvl-table-row').as('myRow')
cy.get('@myRow').click()
```

### ❌ Searching for child rows at the top level

```typescript
// ❌ Bob is a nested child — this will NEVER find him
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('Bob Brown'))

// ✅ Expand the parent first, then search in .row__children
cy.get('@parentRow').shadow().find('.row__children lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('Bob Brown'))
```

### ❌ Using `.contains()` against custom elements

`.contains()` does not pierce shadow DOM boundaries:

```typescript
// ❌ Will not match text inside a custom element's shadow root
cy.get('lvl-table-row').contains('Alice Anderson')

// ✅ Use .filter() with shadowRoot.textContent
cy.get('lvl-table').shadow().find('lvl-table-row')
    .filter((_, row) => !!row.shadowRoot?.textContent?.includes('Alice Anderson'))
```

### ❌ `beforeEach()` for expensive infrastructure

Do not recreate datastores, fields, pages, or records in `beforeEach()`. This is reserved for `before()` only. Expensive setup in `beforeEach()` will make the suite orders of magnitude slower.

### ❌ Positional element access

```typescript
// ❌ Order-dependent — breaks if a new record is inserted
cy.get('lvl-table-row').eq(0).click()
```

---

## 14. Quick Reference Cheatsheet

### Data Ownership

| Record type | Who reads it | Who mutates it |
|---|---|---|
| Test record (e.g. Alice Anderson) | Only its assigned test | Only its assigned test |
| Support/parent record (e.g. TreeParent Anderson) | Tree tests (read-only) | **Nobody** |
| Lookup/dept record | All tests that open the lookup | Nobody |

### `before()` vs `beforeEach()`

```
before()      → datastores, fields, pages, columns, ACLs, base records
beforeEach()  → navigate, alias toaster, reset UI state
afterEach()   → close dialogs, abort edit modes
after()       → database cleanup (when enabled)
```

### Tree Row Access

```
1. find parent row by text filter at top level
2. .shadow().find('i[data-action="expand"]').click()
3. .shadow().find('.row__children lvl-table-row').filter(textContent)
4. operate on child row
5. after save → tree collapses → unconditionally re-expand, use timeout
```

### Shadow DOM Chaining

```typescript
cy.get('[custom-element]')      // find the custom element
  .shadow()                     // pierce its shadow root
  .find('[inner-element]')      // find inside the shadow
  .shadow()                     // pierce again if nested custom element
  .find('button')               // find the native element
  .click()
```

---

## 15. Complex Fields & Geocoding (Lessons Learned)

### Automated Subfield Handling
When testing complex field types that automatically generate child fields (e.g., `Address` field generating `ZipCode`, `City`, etc.):
- **Don't hardcode subfield IDs:** Use `cy.forEachField(dataSourceId, false)` to dynamically iterate through all fields. Setting `excludeSystemFields` to `false` is critical here to capture the autogenerated subfields for page layout setup.
- **Rename Propagation:** Test that renaming the parent field correctly updates the prefixes of all autogenerated subfields in the DataStore admin view.
Helper Dominance: Always use cy.createField, cy.createDataSource, and cy.createPage from 

e2e.ts
. They handle the complex linking of IDs (like dataSourceId to dataStoreId) internally.

### Geocoding & Async Loader States
- **Deterministic Mocking:** Use `cy.intercept('POST', '/Api/User/Geocode/Address', ...)` to mock geocoding responses. Avoid hitting real Google/OpenStreetMap APIs to prevent flakiness and billing costs.
- **Testing "Loading" State:** Inject a `delay: 500` into the mock response. This allows you to assert that the `lvl-button[data-action="save"]` correctly receives the `loading` and `disabled` attributes while the "server" is thinking.
- **Validation Fallbacks:** Manually type "invalid" addresses in the mock to trigger and verify the `not-found-dialog` logic.

### UI Interaction Precision
- **The Core Sequence:** For shadow DOM inputs, use `.shadow().find('input#name').should('be.visible').click().clear().type('Value').blur()`.
- **Why Click?** Simply calling `.type()` or `.clear()` might not trigger the internal `focus` logic of custom elements. Clicking first ensures the component is fully "awake".
- **Naming for Debugging:** Use a `dataStoreName` variable concatenated with a `guid` (e.g., `` `teststore${guid}` ``). Using this name in `cy.visit` makes Cypress's command log much easier to read than a raw GUID.

### Public Page Context
- **ACL Setup:** If testing a `/Public/Pages/` URL, the test **must** explicitly create an ACL in the `before()` hook using `cy.getUserInfo()` and `cy.createACL()`. Without this, the test user will see a 403 or empty page.

## 16. Event Synchronization & Input Patterns

### The "Double Sync" (Hybrid Type + Invoke) Pattern
In complex Levelbuild components (like `lvl-input` or `lvl-address-picker`), the **UI (shadow-DOM input box)** and the **Data (JavaScript property)** can fall out of sync during rapid automated testing. To guarantee 100% stability, use the **Triple-Sync** hybrid pattern:

1.  **Sync the UI (`.type()`)**: Physically type into the shadow-DOM input. This ensures the UI is visually correct in screenshots/videos and prevents the component from accidentally re-syncing its internal property back to "empty" because the box looks blank.
2.  **Sync the Data (`.invoke('prop')`)**: Force-set the component property. This ensures the component's "brain" has the final value instantly, before we trigger logic.
3.  **Trigger the Logic (`.trigger()`)**: Notify the component to process its new state.

```typescript
// ✅ BEST PRACTICE: The "Triple-Sync" for High-Stability Custom Elements
const targetValue = 'New Value'
const inputSelector = 'lvl-input[name="myField"]'

// 1. Physically click and type for visual honesty and UI-to-Model protection
cy.get(inputSelector).shadow().find('input').clear({ force: true }).type(targetValue, { force: true })

// 2. Force-sync the data model and notify listeners (The "Double Sync" core)
cy.get(inputSelector).invoke('prop', 'value', targetValue)
    .trigger('input', { force: true }) // Notifies "change" logic
    .trigger('blur', { force: true })  // Notifies "finished" logic (e.g. geocoding)
```

### Choosing Between `.type()` and `.invoke('prop')`

| Pattern | Use When... | Why? |
| :--- | :--- | :--- |
| **`.type()`** | Testing "High Realism" fields: Search boxes, Autocomplete filters, real-time character validators. | Native keystrokes trigger internal "isDirty" flags and per-character rendering cycles that `invoke` might skip. |
| **`.invoke('prop')`** | Testing "High Stability" fields: Data entry forms, setup sequences, or when 3+ fields must update at once. | It is 100% deterministic and eliminates the timing issues (race conditions) that occur during rapid automated typing in complex components. |

### Component Architecture & Targeting Precision
**CRITICAL:** You must study the component's template to know WHERE to trigger events. 

*   **Host Listeners**: If the component listens on its outer tag (e.g., `<lvl-address-picker @input="...">`), call `.trigger()` on the **alias** itself.
*   **Inner Listeners**: If the component listens on its internal input (e.g., `<input @blur="...">`), you **MUST** traverse the shadow DOM to trigger the event:
    `cy.get('@myComponent').shadow().find('input').trigger('blur')`

> **Note:** Simulating "Clicking Elsewhere" is most reliably achieved by triggering a `blur` event directly on the specific element that holds the listener.

### Handling Lazy Event Loops (The "Hover/Scroll" Fix)
If you encounter a test where logic (like geocoding or validation) only executes when you manually **hover or scroll** over the Cypress test window, the component is suffering from a "Lazy Event Loop." It is waiting for a DOM event to signal that the user has "finished" interacting before it commits its state or triggers a timer.

To fix this:
1.  **Always use `.trigger('blur')`**: Ensure every field update is finalized with a blur event.
2.  **Use manual "pokes"**: If `blur` isn't enough, use `.trigger('mouseenter', { force: true })` or `.realHover()` on the component to force the browser to flush the event queue.

### Optimal Timeouts
Avoid using extremely long timeouts (e.g., `15000ms`) as a "band-aid" for flakiness. If a component uses a 500ms debounce (like `lvl-address-picker`), a timeout of **`1500ms` (1.5s)** is usually sufficient. If the test still fails at 1.5s, it is likely an event synchronization issue, not a timing issue.

---

*Last updated: April 2026 — Levelbuild QA Team*
