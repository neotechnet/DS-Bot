// [2026-11-24 local] "typing..." goes only to the chat the running turn came from.
// The harness below is the minimal part of im.test.js this needs.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { adapters } from '../src/host/im/platforms/index.js'

const fakeAdapter = () => {
  const typed = []
  const adapter = {
    id: 'fake',
    typed,
    handlers: null,
    async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      let next = 0
      return {
        send: async () => ({ messageId: String(++next) }),
        edit: async () => {},
        typing: async (chat) => { typed.push(chat) },
        stop: () => {},
      }
    },
  }
  return adapter
}

const TEAM = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-typing-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM()))
  const ctx = fakeContext({ services: {} })
  const prompts = []
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id,
      session: { id, requestHeader: () => undefined },
      followup() {},
      cancel() {},
      inbox: { nextStep: [], nextTurn: [], remove: () => false },
      async whenIdle() {},
    })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      prompt: async (request) => { prompts.push(request); return { ok: true } },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
    },
    sessions: { flush: async () => {} },
  })
  const fake = fakeAdapter()
  const real = adapters.telegram
  adapters.telegram = fake
  const rt = createRuntime(ctx, { home })
  const emitEvent = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, data, time: Date.now() })
    }
  }
  const stop = async () => {
    adapters.telegram = real
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, fake, prompts, emitEvent, stop }
}

const connect = async (s, people) => {
  const conn = await s.rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'tok-1234' } })
  const one = s.rt.state.im.connections[conn.id]
  for (const id of people) one.paired.push({ id, name: id, at: 1 })
  await s.rt.save()
  return one
}
const dm = (s, senderId, text) => s.fake.handlers.onMessage({
  chat: { key: `dm-${senderId}`, kind: 'direct', title: senderId }, sender: { id: senderId, name: senderId }, text,
})
const flush = () => delay(10)

test('typing goes to the chat whose message started the turn, and to no other', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const s = await start()
  t.after(s.stop)
  await connect(s, ['u1', 'u2'])
  // Both people's direct chats follow Bot a.
  await dm(s, 'u2', '/start')
  await dm(s, 'u1', 'hi')
  s.emitEvent('a', 'turn/start', { turn: 1 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1)?.requestId }, content: [{ type: 'text', text: 'hi' }] })
  t.mock.timers.tick(4000)
  await flush()
  assert.ok(s.fake.typed.length > 0, 'typing is sent while the asked turn runs')
  assert.deepEqual([...new Set(s.fake.typed.map(chat => chat.key))], ['dm-u1'])
})

test('a turn that no chat asked for shows no typing anywhere', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const s = await start()
  t.after(s.stop)
  await connect(s, ['u1'])
  await dm(s, 'u1', '/start')
  // Work from the app, a peer Bot or a schedule: a turn with no IM request behind it.
  s.emitEvent('a', 'turn/start', { turn: 1 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'from a peer Bot' }] })
  assert.ok(s.rt.live.get(s.rt.chatOf('a'))?.turn !== undefined, 'the turn is live')
  t.mock.timers.tick(8000)
  await flush()
  assert.deepEqual(s.fake.typed, [])
})
