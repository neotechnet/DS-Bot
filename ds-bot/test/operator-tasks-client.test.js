// The details panel and the header badge the user sees: the three sections in order,
// and the "A · U" pair with the operator count in the accent colour and the waiting
// count in the danger colour.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/operator-tasks.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') {
      return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }) }
    }
    throw new Error(`no platform module ${name}`)
  },
})
const { OperatorTasks, OperatorBadge, OPERATOR_TASKS_CSS } = module.exports

// The element tree the component builds, with function components run.
const tree = node => (node === null || node === undefined || typeof node !== 'object' ? node
  : Array.isArray(node) ? node.map(tree)
    : typeof node.type === 'function' ? tree(node.type(node.props))
      : { type: node.type, props: node.props, children: (node.children ?? []).map(tree) })
const textOf = node => (node === null || node === undefined || node === false ? ''
  : typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(textOf).join('')
      : (node.children ?? []).map(textOf).join(''))
const findAll = (node, want) => (node === null || node === undefined || typeof node !== 'object' ? []
  : Array.isArray(node) ? node.flatMap(child => findAll(child, want))
    : [...(want(node) ? [node] : []), ...(node.children ?? []).flatMap(child => findAll(child, want))])

const roster = {
  byId: { igor: { id: 'igor', name: 'Igor' } },
  roomsById: {},
  operatorTasks: {
    coder: {
      operator: [{ kind: 'relay', key: 'turn', at: 10, text: 'Add the panel', via: 'Igor' }],
      active: [{ kind: 'order', key: 'order:w2', at: 5, from: 'igor' }],
      unresolved: [{ kind: 'question', key: 'question:q1', at: 20, text: 'Which option?', sessionId: 'coder' }],
    },
  },
}

test('the panel shows Operator Tasks above Active and Unresolved', () => {
  const panel = tree(OperatorTasks({ bot: { id: 'coder' }, roster }))
  const titles = findAll(panel, node => node.props?.className === 'bt-section-title').map(textOf)
  // The bundle comes from another realm, so compare plain values.
  assert.deepEqual(JSON.parse(JSON.stringify(titles)), ['Operator Tasks · 1', 'Active Tasks · 1', 'Unresolved Tasks · 1'])

  // The user's job, in the words of the Bot that passed it on.
  const lines = findAll(panel, node => node.props?.className === 'bt-ops-label').map(textOf)
  assert.equal(lines[0], 'Relayed by Igor')
  const texts = findAll(panel, node => node.props?.className === 'bt-ops-text').map(textOf)
  assert.equal(texts[0], 'Add the panel')
})

test('the header badge shows the two counts, A accent and U danger', () => {
  const badge = tree(OperatorBadge({ operator: 3, unresolved: 5 }))
  assert.equal(textOf(badge), '3·5')
  const [yours, dot, waiting] = badge.children
  assert.equal(yours.props.className, 'bt-pill-yours')
  assert.equal(waiting.props.className, 'bt-pill-waiting')
  assert.equal(dot.props.className, 'bt-pill-dot')
  // The two colours are the accent and the danger colour the pill always used.
  assert.match(OPERATOR_TASKS_CSS, /\.bt-pill-yours\{color:var\(--bt-accent\)\}/)
  assert.match(OPERATOR_TASKS_CSS, /\.bt-pill-waiting\{color:var\(--bt-danger\)\}/)
  assert.equal(badge.props.title, '3 from you, 5 waiting on you')
})

test('the badge caps each count and shows nothing when both are 0', () => {
  assert.equal(textOf(tree(OperatorBadge({ operator: 140, unresolved: 0 }))), '99+·0')
  assert.equal(textOf(tree(OperatorBadge({ operator: 0, unresolved: 250 }))), '0·99+')
  assert.equal(OperatorBadge({ operator: 0, unresolved: 0 }), null)
})
