import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install, openDecisions } from '../src/host/operator-tasks.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installHandoffs } from '../src/host/handoffs.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const line = record => JSON.stringify(record)

test('openDecisions keeps the newest record per id and only open decisions', () => {
  const text = [
    line({ id: 'LE-1', ts: '2026-11-01T09:00:00', owner: 'Igor', kind: 'decision', text: 'Pick a vendor', state: 'open' }),
    line({ id: 'LE-1', ts: '2026-11-02T09:00:00', owner: 'Igor', kind: 'decision', text: 'Pick a vendor', state: 'open', carded_at: '2026-11-02T09:00:00', due: '2026-11-10' }),
    line({ id: 'LE-2', ts: '2026-11-01T09:00:00', owner: 'Igor', kind: 'decision', text: 'Done already', state: 'open' }),
    line({ id: 'LE-2', ts: '2026-11-03T09:00:00', owner: 'Igor', kind: 'decision', text: 'Done already', state: 'closed' }),
    line({ id: 'LE-3', ts: '2026-11-01T09:00:00', owner: 'Igor', kind: 'handed', text: 'Not the operator\'s', state: 'open' }),
    line({ id: 'LE-4', ts: '2026-11-01T09:00:00', owner: 'Igor', kind: 'decision', text: 'Decided, not yet run', state: 'decided' }),
    'not json',
    '',
  ].join('\n')
  const decisions = openDecisions(text)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].id, 'LE-1')
  assert.equal(decisions[0].carded, true)
  assert.equal(decisions[0].due, '2026-11-10')
  // Opened when the first record was written, not when it was last touched.
  assert.equal(decisions[0].at, Date.parse('2026-11-01T09:00:00'))
})

function fakeRuntime({ looseEnds, state = {}, work = {}, waiting = {}, approvals = [] }) {
  const rt = {
    config: { looseEnds },
    state: {
      bots: { chief: { id: 'chief', name: 'Igor' }, coder: { id: 'coder', name: 'Harness Code' } },
      questions: {}, views: {}, secretRequests: {}, works: {}, ...state,
    },
    chatOwners: new Map([['chief-chat', 'chief'], ['coder-chat', 'coder']]),
    groupOwners: new Map([['coder-in-room', { botId: 'coder', roomId: 'room-1' }]]),
    workView: () => work,
    waitingView: () => waiting,
    approvalsView: () => approvals,
  }
  install(rt)
  return rt
}

test('operatorTasksView sorts each source onto the right Bot and list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-optasks-'))
  try {
    const register = join(dir, 'register.jsonl')
    writeFileSync(register, [
      line({ id: 'LE-9', ts: '2026-11-01T09:00:00', owner: 'Igor', kind: 'decision', text: 'Approve the plan', state: 'open' }),
      line({ id: 'LE-10', ts: '2026-11-01T09:00:00', owner: 'Nobody Here', kind: 'decision', text: 'No such Bot', state: 'open' }),
    ].join('\n'))
    const rt = fakeRuntime({
      looseEnds: register,
      state: {
        questions: { 'chief-chat': { id: 'q1', question: 'Which option?', askedAt: 10 }, 'coder-in-room': { id: 'q2', question: 'Merge now?', askedAt: 20 } },
        views: { 'coder-chat': { id: 'v1', title: 'Pick a theme', askedAt: 30 } },
        secretRequests: { coder: [{ id: 's1', name: 'GITHUB_TOKEN', purpose: 'push', status: 'pending', askedAt: 5 }, { id: 's2', name: 'OLD', status: 'saved', askedAt: 1 }] },
        works: {
          w1: { from: 'chief', to: 'coder', open: [], results: [], at: 100 },
          w2: { from: 'coder', room: 'room-1', open: [], results: [], at: 110 },
          w3: { from: 'coder', to: 'coder', open: [], results: [], at: 120 },
        },
      },
      work: { coder: { since: 200, tool: 'pwsh', target: 'index.js' } },
      waiting: { chief: { bots: ['coder'], rooms: [], for: [] } },
      approvals: [{ id: 'a1', botId: 'chief', sessionId: 'chief-chat', tool: 'Write', reason: 'outside the grant', at: 40 }],
    })
    const view = rt.operatorTasksView()

    assert.deepEqual(view.chief.unresolved.map(item => item.kind), ['question', 'approval', 'decision'])
    assert.equal(view.chief.unresolved.find(item => item.kind === 'decision').id, 'LE-9')
    assert.deepEqual(view.coder.unresolved.map(item => item.key), ['key:s1', 'question:q2', 'view:v1'])
    assert.equal(view.coder.unresolved.find(item => item.kind === 'question').roomId, 'room-1')

    // Active: the running turn and the order from Igor; the Bot's own and group work are not orders.
    assert.deepEqual(view.coder.operator, [])
    assert.deepEqual(view.coder.active.map(item => item.kind), ['order', 'turn'])
    assert.equal(view.coder.active[0].from, 'chief')
    assert.deepEqual(view.chief.active.map(item => item.kind), ['waiting'])

    // A decision owned by a name no Bot has shows on no Bot.
    const all = Object.values(view).flatMap(entry => entry.unresolved)
    assert.equal(all.some(item => item.id === 'LE-10'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('work the user started is in Operator Tasks, and the order for it stands back', () => {
  const rt = fakeRuntime({
    looseEnds: false,
    state: {
      works: {
        w1: { from: 'chief', to: 'coder', origin: 'operator', open: [], results: [], at: 90 },
        w2: { from: 'chief', to: 'coder', open: [], results: [], at: 80 },
      },
    },
    work: {
      coder: { since: 100, tool: 'pwsh', work: 'w1', origin: 'operator', originFrom: 'Igor', ask: 'Add the panel' },
      chief: { since: 110, said: 'Reading the repo' },
    },
    waiting: { coder: { bots: ['chief'], rooms: [], for: ['chief'] } },
  })
  const view = rt.operatorTasksView()

  // The relayed turn and the wait for the Bot it handed on are the operator's job.
  assert.deepEqual(view.coder.operator.map(item => item.kind), ['waiting', 'relay'])
  assert.equal(view.coder.operator[1].via, 'Igor')
  assert.equal(view.coder.operator[1].text, 'Add the panel')
  assert.equal(view.coder.operator[1].at, 100)

  // The order the turn is already doing stands back; the one the user did not start stays Active.
  assert.deepEqual(view.coder.active.map(item => item.kind), ['order'])
  assert.equal(view.coder.active[0].from, 'chief')
  assert.deepEqual(view.chief.active.map(item => item.kind), ['turn'])

  // No job appears in both lists.
  const keys = list => new Set(list.map(item => item.key))
  const inOperator = keys(view.coder.operator)
  assert.equal([...keys(view.coder.active)].some(key => inOperator.has(key)), false)
})

// The host records the origin on the running turn (turns.js), so the details panel and
// the header badge can tell the user's own asks apart from the team's work.
function turnHost({ works = {} } = {}) {
  let listener
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    config: { looseEnds: false },
    home: mkdtempSync(join(tmpdir(), 'ds-bot-optasks-host-')),
    state: { exchangeTurns: {}, questions: {}, views: {}, secretRequests: {}, works, bots: { b: { id: 'b', name: 'Writer' } } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map([['b', 'b']]),
    botOf: id => ({ b: { id: 'b', name: 'Writer' } })[id],
    selfOf: id => id,
    chatOf: id => id,
    save: async () => {},
    deliver: async () => {},
    userWrote() {},
    userAnswered() {},
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    approvalsView: () => [],
  }
  installTurns(rt)
  installHandoffs(rt)
  install(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit }
}

const textBlock = text => [{ type: 'text', text }]
const relay = (extra = {}) => ({ kind: SOURCE_KIND, form: 'relay', role: 'request', senderName: 'Igor', exchangeId: 'e1', ...extra })

test('a turn the user starts is an Operator Task until its reply', () => {
  const { rt, emit } = turnHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('Add the panel'), source: { kind: 'user' } })
  assert.equal(rt.workView().b.origin, 'operator')
  assert.equal(rt.workView().b.ask, 'Add the panel')
  assert.equal(rt.operatorTasksView().b.operator[0].kind, 'ask')

  // The reply ends the job: it leaves Operator Tasks.
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(rt.workView().b, undefined)
  assert.deepEqual(rt.operatorTasksView().b?.operator ?? [], [])
})

test('a relayed turn carries the operator origin, and a plain team job does not', () => {
  const { rt, emit } = turnHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Igor]\nrun the checks'), source: relay({ origin: 'operator' }) })
  assert.equal(rt.workView().b.origin, 'operator')
  assert.equal(rt.workView().b.originFrom, 'Igor')
  // The card shows the message body: the relay header line is not part of the ask.
  assert.equal(rt.operatorTasksView().b.operator[0].text, 'run the checks')
  assert.equal(rt.operatorTasksView().b.operator[0].kind, 'relay')
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // The same request without the origin is the team's own work.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('[Message from Igor]\nlook at this'), source: relay({ exchangeId: 'e2' }) })
  assert.equal(rt.workView().b.origin, undefined)
  assert.deepEqual(rt.operatorTasksView().b?.operator ?? [], [])
  assert.equal(rt.operatorTasksView().b.active[0].kind, 'turn')
})

// A job handed on carries the operator's ask on its work record, outliving the turn that
// took it, so the Bot that picks it up shows what the operator actually asked for.
test('a job handed on keeps the operator ask, and the turn taking it shows that ask', () => {
  const { rt, emit } = turnHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('Fix the sidebar card'), source: { kind: 'user' } })
  rt.openWork('w1', { from: 'b', to: 'chief' })
  assert.equal(rt.state.works.w1.origin, 'operator')
  assert.equal(rt.state.works.w1.ask, 'Fix the sidebar card')
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // The next turn works on that job: the card keeps the ask, not the hand-on message.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', {
    content: textBlock('[Message from Igor]\nplease pick this up'),
    source: { kind: SOURCE_KIND, form: 'relay', role: 'reply', senderName: 'Igor', exchangeId: 'e9', work: 'w1' },
  })
  assert.equal(rt.workView().b.origin, 'operator')
  assert.equal(rt.operatorTasksView().b.operator[0].text, 'Fix the sidebar card')
})

// The card keeps the operator's first line; a step the Bot took is not the ask.
test('the ask is the first line of the operator text, and the Bot\'s own words are not it', () => {
  const rt = fakeRuntime({
    looseEnds: false,
    work: {
      coder: { since: 100, tool: 'read', target: 'design_fidelity.py', origin: 'operator', ask: 'Fix the sidebar card\nand show the step below it' },
      chief: { since: 110, tool: 'read', target: 'notes.md', origin: 'operator', said: 'Reading the notes' },
    },
  })
  const view = rt.operatorTasksView()
  assert.equal(view.coder.operator[0].text, 'Fix the sidebar card')
  assert.equal(view.coder.operator[0].tool, 'read')
  // Nothing of the Bot's own step stands in for an ask that was not recorded.
  assert.equal(view.chief.operator[0].text, undefined)
})

test('a missing register leaves the decisions empty and the rest intact', () => {
  const rt = fakeRuntime({ looseEnds: join(tmpdir(), 'ds-bot-no-such-register.jsonl'), state: { questions: { 'chief-chat': { id: 'q1', question: 'Go?', askedAt: 1 } } } })
  const view = rt.operatorTasksView()
  assert.deepEqual(view.chief.unresolved.map(item => item.kind), ['question'])
  assert.equal(view.coder, undefined)
})

test('looseEnds false reads no register at all', () => {
  const rt = fakeRuntime({ looseEnds: false })
  assert.deepEqual(rt.operatorTasksView(), {})
})

test('an answered card leaves the count at once', () => {
  const rt = fakeRuntime({ looseEnds: false, state: { questions: { 'chief-chat': { id: 'q1', question: 'Go?', askedAt: 1 } } } })
  assert.equal(rt.operatorTasksView().chief.unresolved.length, 1)
  delete rt.state.questions['chief-chat']
  assert.equal(rt.operatorTasksView().chief, undefined)
})

test('the state answer carries operator tasks live, and a closed decision leaves at the next poll', async (t) => {
  const { createRuntime } = await import('../index.js')
  const { fakeContext } = await import('./fake-ctx.js')
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-optasks-home-'))
  const register = join(home, 'register.jsonl')
  writeFileSync(register, line({ id: 'LE-1', ts: '2026-11-01T09:00:00', owner: 'Chief', kind: 'decision', text: 'Approve the plan', state: 'open' }))
  const ctx = fakeContext({ services: {} })
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `s${++sessions}` }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const registerRoute = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return registerRoute(options) }
  createRuntime(ctx, { home, looseEnds: register })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload) => (await (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()).value

  const first = await call('state', {})
  const main = first.bots.find(bot => bot.id === first.mainBotId)
  assert.equal(main.name, 'Chief')
  assert.deepEqual(first.operatorTasks[main.id].unresolved.map(item => item.id), ['LE-1'])

  writeFileSync(register, [
    line({ id: 'LE-1', ts: '2026-11-01T09:00:00', owner: 'Chief', kind: 'decision', text: 'Approve the plan', state: 'open' }),
    line({ id: 'LE-1', ts: '2026-11-02T09:00:00', owner: 'Chief', kind: 'decision', text: 'Approve the plan', state: 'closed' }),
  ].join('\n'))
  // The register is looked at again after its stat interval.
  await new Promise(resolve => setTimeout(resolve, 2100))
  const later = await call('state', { since: first.revision, models: first.modelsKey, live: first.liveKey })
  assert.deepEqual(later.operatorTasks, {})
})

// The details panel and the header badge the user sees: the three sections in order,
// and the "A · U" pair with the operator count in the accent colour and the waiting
// count in the danger colour. The client module is browser code, so it is bundled here.
const operatorTasksBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/operator-tasks.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})
const operatorTasksModule = { exports: {} }
runInNewContext(operatorTasksBundle.outputFiles[0].text, {
  module: operatorTasksModule, exports: operatorTasksModule.exports, URL, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') {
      return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }) }
    }
    throw new Error(`no platform module ${name}`)
  },
})
const { OperatorTasks, OperatorBadge, OPERATOR_TASKS_CSS } = operatorTasksModule.exports

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

const askPanel = items => tree(OperatorTasks({
  bot: { id: 'coder' },
  roster: { byId: {}, roomsById: {}, operatorTasks: { coder: { operator: items, active: [], unresolved: [] } } },
}))
const linesOf = (panel, className) => JSON.parse(JSON.stringify(findAll(panel, node => node.props?.className === className).map(textOf)))

test('a running step sits below the ask and never replaces it', () => {
  const panel = askPanel([{ kind: 'ask', key: 'turn', at: 10, text: 'Fix the sidebar card\nand show the step below it', tool: 'read', target: 'design_fidelity.py' }])
  assert.deepEqual(linesOf(panel, 'bt-ops-text'), ['Fix the sidebar card'])
  assert.deepEqual(linesOf(panel, 'bt-ops-note'), ['Running read on design_fidelity.py'])
})

test('work whose ask was not recorded says so, with the step as its note', () => {
  const panel = askPanel([{ kind: 'ask', key: 'turn', at: 10, tool: 'read', target: 'design_fidelity.py' }])
  assert.deepEqual(linesOf(panel, 'bt-ops-text'), ['The ask is not recorded'])
  assert.deepEqual(linesOf(panel, 'bt-ops-note'), ['Running read on design_fidelity.py'])
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
