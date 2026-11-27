// Scratch only: proves the Stack check goes red on a new failing test. Never merged.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('stack check scratch: a new failure must turn the check red', () => {
  assert.equal(1, 2)
})
