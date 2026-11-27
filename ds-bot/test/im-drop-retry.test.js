// [2026-11-27 local] An IM message whose delivery throws is retried once, then the chat
// is told to resend it; a blank reply never goes out to a platform.
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
  const sent = []
  const adapter = {
    id: 'fake',
    sent,
    handlers: null,
    async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      return {
        send: async (chat, body) => {
          sent.push({ chat, ...body })
          return { messageId: String(sent.length) }
        },
        edit: async () => {},
        typing: async () => {},
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
  const home = mkdtempSync(join(tmpdir(), 'dsb-im-drop-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM()))
  const ctx = fakeContext({ services: {} })
  const prompts = []
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, {
      id,
      session: { id, requestHeader: () => undefined },
      followup() {},
      steer() {},
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
  rt.imSendRetryMs = 1
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
  const conn = await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'tok-1234' } })
  const one = rt.state.im.connections[conn.id]
  one.settings.notify = 'all'
  one.paired.push({ id: 'u1', name: 'U1', at: 1 })
  await rt.save()
  const dm = text => fake.handlers.onMessage({ chat: { key: 'dm-u1', kind: 'direct', title: 'u1' }, sender: { id: 'u1', name: 'U1' }, text })
  return { rt, fake, prompts, emitEvent, dm, stop }
}

// Makes the next `count` deliveries throw, as a timed-out cold-part read does.
const failNext = (s, count) => {
  const real = s.rt.sendUser
  let left = count
  s.rt.sendUser = async (...args) => {
    if (left > 0) {
      left -= 1
      throw new Error('session observation was aborted')
    }
    return real(...args)
  }
}

const notices = s => s.fake.sent.filter(job => /did not reach the Bot/.test(job.text ?? ''))

test('a delivery that throws once is retried and reaches the Bot, with no resend notice', async (t) => {
  const s = await start()
  t.after(s.stop)
  failNext(s, 1)
  s.fake.sent.length = 0
  await s.dm('please check the invoices')
  assert.equal(s.prompts.length, 1, 'the retry delivers the message')
  assert.deepEqual(s.prompts[0].content, [{ type: 'text', text: 'please check the invoices' }])
  await delay(20)
  assert.equal(notices(s).length, 0, 'a delivered message sends no notice')
})

test('a delivery that throws twice tells the chat to resend and does not reach the Bot', async (t) => {
  const s = await start()
  t.after(s.stop)
  failNext(s, 2)
  s.fake.sent.length = 0
  // The connection handler logs the failure; the message itself is not admitted.
  await s.dm('please check the invoices')
  assert.equal(s.prompts.length, 0)
  await delay(20)
  assert.equal(notices(s).length, 1, 'the chat is told once')
  assert.equal(notices(s)[0].chat.key, 'dm-u1')
})

test('a blank or zero-width-only reply is not sent to the chat; text still is', async (t) => {
  const s = await start()
  t.after(s.stop)
  await s.dm('hi')
  s.emitEvent('a', 'turn/start', { turn: 1 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: s.prompts.at(-1)?.requestId }, content: [{ type: 'text', text: 'hi' }] })
  s.fake.sent.length = 0
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: '' }] } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: '   \n ' }] } })
  // What SEO Overlord wrote after its cards on 2026-11-27, refused by Telegram 3 times.
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: '\u200b' }] } })
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: ' \u200b\ufeff ' }] } })
  await delay(20)
  assert.equal(s.fake.sent.length, 0, 'nothing goes out for blank text')
  s.emitEvent('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'real reply' }] } })
  await delay(20)
  assert.deepEqual(s.fake.sent.map(job => job.text), ['real reply'])
})
