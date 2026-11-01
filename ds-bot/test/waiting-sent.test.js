// A Bot that sends work from its own chat with the user waits for the answer, though no
// work of its own holds that wait: its tile and its status say so until the answer comes.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
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

async function open(home) {
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
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: sessionId }, callId: 'call-1', concludeTurn() {} })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const waiting = async () => (await call('state', {})).value.work.waiting
  await tool('list_bots', {}, 'a')
  return { ctx, agentOf, emit, tool, call, waiting }
}

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-waiting-sent-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const hosts = []
  const host = async () => {
    const opened = await open(home)
    hosts.push(opened)
    return opened
  }
  t.after(async () => {
    for (const { ctx } of hosts) await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { host, close: () => hosts.at(-1).ctx.dispose() }
}

// The recipient takes the request that delivery really handed over, and may answer it.
function takes(host, id, number) {
  const [, message] = host.agentOf(id).calls.at(-1)
  host.emit(id, 'turn/start', { turn: number })
  host.emit(id, 'user/message', { content: message.content, source: message.source })
}
function answers(host, id, number, text = 'Done.') {
  host.emit(id, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
  host.emit(id, 'turn/end', { turn: number, reason: { kind: 'completed' } })
}

const waitingFor = (...bots) => ({ bots, rooms: [], for: [] })

test('a Bot that sends from its own chat waits for the recipient until the reply', async (t) => {
  const { host } = await start(t)
  const team = await host()
  assert.deepEqual(await team.waiting(), {})
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  assert.deepEqual((await team.waiting()).a, waitingFor('b'))
  takes(team, 'b', 1)
  assert.deepEqual((await team.waiting()).a, waitingFor('b'))
  answers(team, 'b', 1)
  assert.deepEqual(await team.waiting(), {})
})

test('the wait shows as the waiting state and in what other Bots read of it', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  assert.equal((await team.call('state', {})).value.activity.a, 'waiting')
  assert.match(await team.tool('list_bots', {}, 'c'), /Chief[\s\S]*now: waiting for Writer to answer/)
})

test('two sends wait for both, and the wait for one ends with its reply', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  await team.tool('message_bot', { to: 'Scout', message: 'find the docs' }, 'a')
  assert.deepEqual((await team.waiting()).a, waitingFor('b', 'c'))
  takes(team, 'c', 1)
  answers(team, 'c', 1)
  assert.deepEqual((await team.waiting()).a, waitingFor('b'))
})

test('reply_to user is no wait', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'tell the user', reply_to: 'user' }, 'a')
  assert.deepEqual(await team.waiting(), {})
})

test('a restart keeps the wait', async (t) => {
  const { host, close } = await start(t)
  const first = await host()
  await first.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  await close()
  const second = await host()
  assert.deepEqual((await second.waiting()).a, waitingFor('b'))
})

test('deleting the recipient ends the wait', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  assert.equal((await team.call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(await team.waiting(), {})
})

test('deleting the sender ends the wait', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'c')
  assert.deepEqual((await team.waiting()).c, waitingFor('b'))
  assert.equal((await team.call('delete-bot', { id: 'c' })).ok, true)
  assert.deepEqual(await team.waiting(), {})
})

test('stopping the recipient ends the wait', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  takes(team, 'b', 1)
  await team.tool('stop_bot', { bot: 'Writer', reason: 'not needed' }, 'a')
  team.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.deepEqual(await team.waiting(), {})
})

test('work handed on inside work waits under the Bot doing it, not on its own', async (t) => {
  const { host } = await start(t)
  const team = await host()
  await team.tool('message_bot', { to: 'Writer', message: 'write the docs' }, 'a')
  takes(team, 'b', 1)
  await team.tool('message_bot', { to: 'Scout', message: 'find the sources' }, 'b')
  answers(team, 'b', 1, 'Asked Scout.')
  assert.deepEqual(await team.waiting(), { a: waitingFor('b'), b: { bots: ['c'], rooms: [], for: ['a'] } })
})
