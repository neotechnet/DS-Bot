import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer', createdAt: 2 },
    coder: { id: 'coder', name: 'Coder', role: 'Code', sessionId: 'coder', createdAt: 3 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// A plan-mode service that keeps its state per Session, like ctx.planMode.
function fakePlanMode(active = {}) {
  const calls = []
  return {
    calls,
    active,
    get: agent => ({ active: active[agent.session.id] === true }),
    set(agent, value) {
      calls.push([agent.session.id, value])
      if ((active[agent.session.id] === true) === value) return 'noop'
      active[agent.session.id] = value
      return 'committed'
    },
  }
}

async function start({ planMode } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-card-gate-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: planMode ? { planMode } : {} })
  const delivered = []
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup(message) { delivered.push([sessionId, message]) }, steer(message) { delivered.push([sessionId, message]) } } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const ask = (sessionId, options = [{ label: 'Lookout' }, { label: 'Scout' }]) => rt.teamTools.find(d => d.name === 'ask_user').execute(
    { question: 'Which name?', options },
    { agent: { id: sessionId }, callId: 'call-1', concludeTurn() {} },
  )
  const guard = (sessionId, name, args) => {
    for (const each of ctx.guards) {
      const refusal = each({ name, arguments: args, agent: { id: sessionId } })
      if (refusal !== undefined) return refusal
    }
    return undefined
  }
  // A turn a Bot opened with a request (hidden), or one the user typed (visible).
  const turns = {}
  const nextTurn = (sessionId) => {
    if (turns[sessionId] !== undefined) emit(sessionId, 'turn/end', { turn: turns[sessionId], reason: { kind: 'completed' } })
    turns[sessionId] = (turns[sessionId] ?? 0) + 1
    emit(sessionId, 'turn/start', { turn: turns[sessionId] })
  }
  const fromBot = (sessionId, sender, body, extra = {}) => {
    nextTurn(sessionId)
    emit(sessionId, 'user/message', { content: [{ type: 'text', text: `[Message from ${TEAM.bots[sender].name}]\n${body}` }], source: { kind: 'bot', role: 'request', senderSessionId: sender, senderName: TEAM.bots[sender].name, exchangeId: `x-${sessionId}-${turns[sessionId]}`, hop: 0, ...extra } })
  }
  const fromUser = (sessionId, body) => {
    nextTurn(sessionId)
    emit(sessionId, 'user/message', { content: [{ type: 'text', text: body }], source: { kind: 'user' } })
  }
  const log = async () => {
    const path = join(home, 'logs', 'card-gate.log')
    for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 20))
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  return { rt, emit, ask, guard, fromBot, fromUser, log, delivered, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

test('ask_user in a job another Bot sent is refused and names the manager', async (t) => {
  const { rt, ask, fromBot, log, stop } = await start()
  t.after(stop)
  fromBot('writer', 'chief', 'Pick a name for the new Bot')
  const reply = await ask('writer')
  assert.match(reply, /^This job came from Chief\. Do not card Steve: end your turn with a DECISION block for Chief/)
  assert.match(reply, /Chief cards Steve and relays his answer\.$/)
  assert.equal(rt.state.questions.writer, undefined)
  const [entry] = await log()
  assert.equal(entry.bot, 'Writer')
  assert.equal(entry.manager, 'Chief')
  assert.equal(entry.tool, 'ask_user')
  assert.equal(entry.title, 'Which name?')
  assert.ok(Date.parse(entry.time) > 0)
})

test('a Main Bot cards in a job another Bot sent', async (t) => {
  const { rt, ask, fromBot, stop } = await start()
  t.after(stop)
  fromBot('chief', 'writer', 'Ask the user which name they like')
  assert.match(await ask('chief'), /card is on screen/)
  assert.equal(rt.state.questions.chief.question, 'Which name?')
})

test('a turn the user typed cards as before', async (t) => {
  const { rt, ask, fromUser, stop } = await start()
  t.after(stop)
  fromUser('writer', 'Help me name a Bot')
  assert.match(await ask('writer'), /card is on screen/)
  assert.equal(rt.state.questions.writer.callId, 'call-1')
})

test('a request whose audience is the user cards as before', async (t) => {
  const { rt, ask, fromBot, stop } = await start()
  t.after(stop)
  fromBot('writer', 'chief', 'Introduce yourself', { audience: 'user' })
  assert.match(await ask('writer'), /card is on screen/)
  assert.equal(rt.state.questions.writer.question, 'Which name?')
})

test('the production approval card stays with the Bot that runs it', async (t) => {
  const { rt, ask, fromBot, stop } = await start()
  t.after(stop)
  fromBot('coder', 'chief', 'Merge PR 12 when Steve approves')
  assert.match(await ask('coder', [{ label: 'deploy to production (Recommended)' }, { label: 'Hold' }]), /card is on screen/)
  assert.ok(rt.state.questions.coder)
  delete rt.state.questions.coder
  fromBot('writer', 'chief', 'Ship it')
  assert.match(await ask('writer', [{ label: 'Deploy to production' }, { label: 'Hold' }]), /card is on screen/)
  // A look-alike label is not the approval.
  fromBot('writer', 'chief', 'Ship it again')
  assert.match(await ask('writer', [{ label: 'deploy to production now' }, { label: 'Hold' }]), /^This job came from Chief/)
})

test('CARD-IT-YOURSELF in the job lets the Bot card the user', async (t) => {
  const { rt, ask, fromBot, stop } = await start()
  t.after(stop)
  fromBot('writer', 'chief', 'Ask the user for the name yourself. CARD-IT-YOURSELF')
  assert.match(await ask('writer'), /card is on screen/)
  assert.ok(rt.state.questions.writer)
})

test('exit_plan_mode in a job another Bot sent is refused', async (t) => {
  const { guard, fromBot, fromUser, log, stop } = await start()
  t.after(stop)
  fromBot('coder', 'chief', 'Build the card gate')
  const refusal = guard('coder', 'exit_plan_mode', { plan: '# Card gate\n\nSteps' })
  assert.match(refusal, /^This job came from Chief\. Do not open a plan review for Steve here: send the full plan to Chief as a DECISION \(Approve plan \(Recommended\) \/ Change it \/ Hold\)\./)
  assert.match(refusal, /When Chief relays approval with PLAN-APPROVED, plan mode turns off for you\.$/)
  const [entry] = await log()
  assert.deepEqual([entry.bot, entry.manager, entry.tool, entry.title], ['Coder', 'Chief', 'exit_plan_mode', 'Card gate'])
  // In the user's own turn, and in a Main Bot's, the review goes ahead.
  fromUser('coder', 'Plan the card gate')
  assert.equal(guard('coder', 'exit_plan_mode', { plan: '# Card gate' }), undefined)
  fromBot('chief', 'coder', 'Plan it')
  assert.equal(guard('chief', 'exit_plan_mode', { plan: '# Card gate' }), undefined)
})

test('PLAN-APPROVED from a Main Bot turns plan mode off', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, delivered, stop } = await start({ planMode })
  t.after(stop)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'Steve approved. PLAN-APPROVED. Go ahead.', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
  assert.equal(planMode.active.coder, false)
  assert.equal(delivered.length, 1)
  const [entry] = await log()
  assert.deepEqual([entry.bot, entry.manager, entry.tool, entry.outcome], ['Coder', 'Chief', 'plan-approved', 'committed'])
})

test('PLAN-APPROVED from a Bot that is not a Main Bot changes nothing', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, stop } = await start({ planMode })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'PLAN-APPROVED', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  assert.equal(planMode.active.coder, true)
  // Nor does a Main Bot message without the token, or one to a Bot not in plan mode.
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'Plan looks fine', role: 'request' })
  await rt.deliver({ fromId: 'chief', toId: 'writer', text: 'PLAN-APPROVED', role: 'request' })
  assert.deepEqual(planMode.calls, [])
})

test('PLAN-APPROVED does nothing when plan mode is not composed', async (t) => {
  const { rt, delivered, stop } = await start()
  t.after(stop)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'PLAN-APPROVED', role: 'request' })
  assert.equal(delivered.length, 1)
})

test('DSH_CARD_GATE=off turns the gate off', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, ask, guard, fromBot, stop } = await start({ planMode })
  const before = process.env.DSH_CARD_GATE
  process.env.DSH_CARD_GATE = 'off'
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_CARD_GATE
    else process.env.DSH_CARD_GATE = before
    await stop()
  })
  fromBot('writer', 'chief', 'Pick a name')
  assert.match(await ask('writer'), /card is on screen/)
  fromBot('coder', 'chief', 'Build it')
  assert.equal(guard('coder', 'exit_plan_mode', { plan: '# Plan' }), undefined)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'PLAN-APPROVED', role: 'request' })
  assert.deepEqual(planMode.calls, [])
})
