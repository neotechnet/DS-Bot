import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-questions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const ask = (sessionId, callId) => rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }, { label: 'Scout' }] },
    { agent: { id: sessionId }, callId, concludeTurn() {} },
  )
  const questions = async () => (await (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: {} }),
  }))).json()).value.questions
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  return { emit, ask, questions, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

const text = value => [{ type: 'text', text: value }]

test('a card asked in a hidden Bot-to-Bot turn goes to the dock, without its call', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('[Message from Chief]\nThe user wants a new Bot; ask them for its name. CARD-IT-YOURSELF'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x1', hop: 0 } })
  await ask('writer', 'call-1')
  const asked = (await questions()).writer
  assert.equal(asked.question, 'Which name?')
  assert.equal(asked.callId, undefined)
})

test('a card asked in a visible turn stays at its call', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('Help me name a Bot'), source: { kind: 'user' } })
  await ask('writer', 'call-2')
  assert.equal((await questions()).writer.callId, 'call-2')

  // A message that asks for an answer in the recipient's own chat is visible too.
  emit('writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('writer', 'turn/start', { turn: 2 })
  emit('writer', 'user/message', { content: text('[Message from Chief · the user sees your reply here]\nIntroduce yourself'), source: { kind: 'bot', role: 'request', audience: 'user', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x2', hop: 0 } })
  await ask('writer', 'call-3')
  assert.equal((await questions()).writer.callId, 'call-3')
})

// local: question-lifecycle. A card closes once the Bot finishes a later turn the user
// could see that asked nothing; a hidden Bot-to-Bot turn in between leaves it open.
test('a later visible turn that asks nothing closes the card; a hidden one leaves it', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('Help me name a Bot'), source: { kind: 'user' } })
  await ask('writer', 'call-1')
  emit('writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal((await questions()).writer.question, 'Which name?')

  emit('writer', 'turn/start', { turn: 2 })
  emit('writer', 'user/message', { content: text('[Message from Chief]\nstatus? CARD-IT-YOURSELF'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x9', hop: 0 } })
  emit('writer', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal((await questions()).writer?.question, 'Which name?')

  emit('writer', 'turn/start', { turn: 3 })
  emit('writer', 'user/message', { content: text('never mind, call it Scout'), source: { kind: 'user' } })
  emit('writer', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  for (let count = 0; count < 50 && (await questions()).writer !== undefined; count += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await questions()).writer, undefined)
})

test('only a Main Bot voids another Bot\'s open question, and the card leaves', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  const voidQuestion = (args, sessionId) => rt.teamTools.find(d => d.name === 'void_question').execute(args, { agent: { id: sessionId } })
  await assert.rejects(voidQuestion({ bot: 'Writer' }, 'chief'), /Writer has no open question/)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('Help me name a Bot'), source: { kind: 'user' } })
  await ask('writer', 'call-1')
  await assert.rejects(voidQuestion({ bot: 'Chief' }, 'writer'), /Only a Main Bot can void a question/)
  assert.equal((await questions()).writer.question, 'Which name?')
  const out = await voidQuestion({ bot: 'Writer', reason: 'the job moved' }, 'chief')
  assert.match(out, /^The question of Writer is voided/)
  assert.equal((await questions()).writer, undefined)
})