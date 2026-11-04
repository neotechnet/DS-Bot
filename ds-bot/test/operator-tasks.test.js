import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, openDecisions } from '../src/host/operator-tasks.js'

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
