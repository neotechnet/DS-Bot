// How a question card ends: answered, overtaken by a finished turn that asks nothing, or
// voided by a Main Bot. Whatever ended it, a late click is refused.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
      c: { id: 'c', name: 'Scout', role: 'Find', sessionId: 'c', createdAt: 3 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-questions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, callId: 'call-1', concludeTurn() {} })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const pending = async sessionId => (await call('state', {})).value.questions[sessionId]
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { ctx, agentOf, emit, tool, call, pending, stop }
}

const card = { question: 'Which one?', options: [{ label: 'Left' }, { label: 'Right' }] }

// One turn of the Bot: it may call `during`, then ends for `reason`.
async function turn(team, id, number, during, reason = { kind: 'completed' }) {
  team.emit(id, 'turn/start', { turn: number })
  await during?.()
  team.emit(id, 'assistant/message', { message: { content: [{ type: 'text', text: 'Done.' }] } })
  team.emit(id, 'turn/end', { turn: number, reason })
}

test('the turn that asks keeps its card', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  assert.equal((await team.pending('b')).question, 'Which one?')
})

test('a card followed by a plain turn leaves nothing pending', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  await turn(team, 'b', 2)
  assert.equal(await team.pending('b'), undefined)
})

test('a turn that asks again leaves only its own card', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  const first = await team.pending('b')
  await turn(team, 'b', 2, () => team.tool('ask_user', { ...card, question: 'And now?' }, 'b'))
  const second = await team.pending('b')
  assert.notEqual(second.id, first.id)
  assert.equal(second.question, 'And now?')
})

test('a turn that failed or was stopped asked nothing, so the card stays', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  await turn(team, 'b', 2, undefined, { kind: 'aborted' })
  assert.notEqual(await team.pending('b'), undefined)
  await turn(team, 'b', 3, undefined, { kind: 'error', error: { code: 'NETWORK', message: 'down' } })
  assert.notEqual(await team.pending('b'), undefined)
})

test('the handoff turn of a fresh part keeps the card it carried over', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  team.emit('b', 'turn/start', { turn: 2 })
  team.emit('b', 'user/message', { content: [{ type: 'text', text: 'note' }], source: { kind: 'bot', role: 'handoff', handoff: true } })
  team.emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.notEqual(await team.pending('b'), undefined)
})

test('a card followed by a Main Bot void leaves nothing pending, and the Bot is told', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  const said = await team.tool('void_question', { bot: 'Writer', reason: 'Steve changed his mind' }, 'a')
  assert.match(said, /Writer/)
  assert.equal(await team.pending('b'), undefined)
  const [kind, message] = team.agentOf('b').calls.at(-1)
  assert.equal(kind, 'followup')
  assert.equal(message.source.role, 'voided')
  const text = message.content.map(block => block.text).join('\n')
  assert.match(text, /Question voided by Chief/)
  assert.match(text, /Which one\?/)
  assert.match(text, /Steve changed his mind/)
})

test('voiding belongs to a Main Bot', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  await assert.rejects(team.tool('void_question', { bot: 'Writer' }, 'c'), { message: 'Only a Main Bot can void a question.' })
  assert.notEqual(await team.pending('b'), undefined)
})

test('voiding says so when the Bot has no open question', async (t) => {
  const team = await start()
  t.after(team.stop)
  await assert.rejects(team.tool('void_question', { bot: 'Writer' }, 'a'), { message: 'Writer has no open question.' })
  await assert.rejects(team.tool('void_question', { bot: 'Nobody' }, 'a'), /No Bot named Nobody/)
})

test('a void reaches the card even when telling the Bot fails', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  team.agentOf('b').followup = () => { throw new Error('Session gone') }
  const said = await team.tool('void_question', { bot: 'Writer' }, 'a')
  assert.match(said, /could not be told/)
  assert.equal(await team.pending('b'), undefined)
})

test('a late answer to a voided card is refused and reaches nobody', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  const { id } = await team.pending('b')
  await team.tool('void_question', { bot: 'Writer' }, 'a')
  const before = team.agentOf('b').calls.length
  const late = await team.call('answer-question', { sessionId: 'b', questionId: id, answer: { selected: ['Left'] } })
  assert.equal(late.ok, false)
  assert.equal(late.error.code, 'bot/stale')
  assert.equal(team.agentOf('b').calls.length, before)
})

test('a late answer to a card a plain turn cleared is refused and reaches nobody', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  const { id } = await team.pending('b')
  await turn(team, 'b', 2)
  const late = await team.call('answer-question', { sessionId: 'b', questionId: id, answer: { selected: ['Left'] } })
  assert.equal(late.ok, false)
  assert.equal(late.error.code, 'bot/stale')
  assert.deepEqual(team.agentOf('b').calls, [])
})

test('a normal card answered by the user behaves as it always did', async (t) => {
  const team = await start()
  t.after(team.stop)
  await turn(team, 'b', 1, () => team.tool('ask_user', card, 'b'))
  const { id } = await team.pending('b')
  const answered = await team.call('answer-question', { sessionId: 'b', questionId: id, answer: { selected: ['Left'] } })
  assert.equal(answered.ok, true)
  assert.equal(await team.pending('b'), undefined)
  const [kind, message] = team.agentOf('b').calls.at(-1)
  assert.equal(kind, 'followup')
  assert.equal(message.source.kind, 'user-question-reply')
  const twice = await team.call('answer-question', { sessionId: 'b', questionId: id, answer: { selected: ['Left'] } })
  assert.equal(twice.error.code, 'bot/stale')
})
