import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRAINSTORM_TEXT, canBrainstorm, insertBrainstorm } from '../src/client/brainstorm.js'

test('the Brainstorm row types "brainstorm " once, at the captured caret', () => {
  const calls = []
  const caret = { at: 7 }
  const inputActions = { insertText: (...args) => calls.push(args), captureInsertion: () => caret }
  assert.equal(canBrainstorm(inputActions), true)
  assert.equal(insertBrainstorm(inputActions), true)
  assert.equal(BRAINSTORM_TEXT, 'brainstorm ')
  assert.deepEqual(calls, [['brainstorm ', caret]])
})

test('a composer without insertText shows no row and nothing happens', () => {
  assert.equal(canBrainstorm(undefined), false)
  assert.equal(canBrainstorm({ captureInsertion: () => ({}) }), false)
  assert.equal(insertBrainstorm(undefined), false)
  assert.equal(insertBrainstorm({ captureInsertion: () => { throw new Error('must not be called') } }), false)
})
