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

// `realm: 'preset'` serves plan mode the way DSH does under an agent preset: only
// through agentPresets.serviceFor, never from a Host-realm ctx.get('planMode').
// `planDefault: true` keeps the start-off rule on; the relay tests turn it off so
// they see only the relay.
async function start({ planMode, team = TEAM, realm = 'host', planDefault = false, keep } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-card-gate-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  if (keep !== undefined) writeFileSync(join(home, 'plan-mode-keep.json'), JSON.stringify(keep))
  const beforeDefault = process.env.DSH_PLAN_DEFAULT_OFF
  if (!planDefault) process.env.DSH_PLAN_DEFAULT_OFF = 'off'
  else delete process.env.DSH_PLAN_DEFAULT_OFF
  const services = planMode === undefined ? {}
    : realm === 'preset' ? { agentPresets: { list: async () => [], serviceFor: (_agent, name) => (name === 'planMode' ? planMode : undefined) } }
    : { planMode }
  const ctx = fakeContext({ services })
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
  // Every line, start-up included (`all`), or only the gate's decisions.
  const log = async ({ all = false } = {}) => {
    const path = join(home, 'logs', 'card-gate.log')
    for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => setTimeout(resolve, 20))
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    return all ? lines : lines.filter(line => line.tool !== 'gate-loaded')
  }
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'chief' } })
  const restoreDefault = () => {
    if (beforeDefault === undefined) delete process.env.DSH_PLAN_DEFAULT_OFF
    else process.env.DSH_PLAN_DEFAULT_OFF = beforeDefault
  }
  return { rt, home, emit, ask, guard, fromBot, fromUser, log, delivered, stop: async () => { await ctx.dispose(); restoreDefault(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

test('ask_user in a job another Bot sent is refused and names the manager', async (t) => {
  const { rt, ask, fromBot, log, stop } = await start()
  t.after(stop)
  fromBot('writer', 'chief', 'Pick a name for the new Bot')
  const reply = await ask('writer')
  assert.match(reply, /^This job came from Chief\. Do not card Steve: end your turn with a DECISION block for Chief/)
  assert.match(reply, /Chief cards Steve and relays his answer\.$/)
  assert.equal(rt.state.questions.writer, undefined)
  const [entry] = await anyLines(log)
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

test('a production approval card in a job another Bot sent goes back to the manager', async (t) => {
  const { rt, ask, fromBot, log, stop } = await start()
  t.after(stop)
  fromBot('coder', 'chief', 'Merge PR 12 when Steve approves')
  const reply = await ask('coder', [{ label: 'deploy to production (Recommended)' }, { label: 'Hold' }])
  assert.match(reply, /^This job came from Chief. A deploy approval never goes to Steve from here: send the deploy DECISION to Chief, naming the repo and the PR as #N./)
  assert.match(reply, /Chief cards Steve and mints the approval; then run gh pr merge <n> --repo <owner\/name> alone\.$/)
  assert.equal(rt.state.questions.coder, undefined)
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.tool, entry.allowed, entry.because, entry.label, entry.manager], ['ask_user', false, 'production-label', 'deploy to production (Recommended)', 'Chief'])
  // CARD-IT-YOURSELF opens ordinary cards, never the production one.
  fromBot('writer', 'chief', 'Ship it. CARD-IT-YOURSELF')
  assert.match(await ask('writer', [{ label: 'Deploy to production' }, { label: 'Hold' }]), /^This job came from Chief. A deploy approval/)
  assert.equal(rt.state.questions.writer, undefined)
  // A look-alike label is an ordinary card: refused with the ordinary text.
  fromBot('writer', 'chief', 'Ship it again')
  assert.match(await ask('writer', [{ label: 'deploy to production now' }, { label: 'Hold' }]), /^This job came from Chief. Do not card Steve/)
})

test('the production approval card in a turn the user typed shows, and the log says why', async (t) => {
  const { rt, ask, fromUser, log, stop } = await start()
  t.after(stop)
  fromUser('coder', 'Merge PR 12 when you are ready')
  assert.match(await ask('coder', [{ label: 'deploy to production (Recommended)' }, { label: 'Hold' }]), /card is on screen/)
  assert.ok(rt.state.questions.coder)
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.bot, entry.tool, entry.allowed, entry.because, entry.label], ['Coder', 'ask_user', true, 'not-bot-turn', 'deploy to production (Recommended)'])
  assert.equal(entry.text, undefined)
})

test('CARD-IT-YOURSELF in the job lets the Bot card the user, and the log says so', async (t) => {
  const { rt, ask, fromBot, log, stop } = await start()
  t.after(stop)
  fromBot('writer', 'chief', 'Ask the user for the name yourself. CARD-IT-YOURSELF')
  assert.match(await ask('writer'), /card is on screen/)
  assert.ok(rt.state.questions.writer)
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.bot, entry.manager, entry.allowed, entry.because, entry.title], ['Writer', 'Chief', true, 'card-it-yourself', 'Which name?'])
})

test('exit_plan_mode in a job another Bot sent is refused', async (t) => {
  const { guard, fromBot, fromUser, log, stop } = await start()
  t.after(stop)
  fromBot('coder', 'chief', 'Build the card gate')
  const refusal = guard('coder', 'exit_plan_mode', { plan: '# Card gate\n\nSteps' })
  assert.match(refusal, /^This job came from Chief\. Do not open a plan review for Steve here: send the full plan to Chief as a DECISION \(Approve plan \(Recommended\) \/ Change it \/ Hold\)\./)
  assert.match(refusal, /When Chief relays approval with PLAN-APPROVED, plan mode turns off for you\.$/)
  const [entry] = await anyLines(log)
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
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.bot, entry.manager, entry.tool, entry.outcome, entry.authority], ['Coder', 'Chief', 'plan-approved', 'committed', 'main'])
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

test('PLAN-APPROVED from a Main Bot turns plan mode off for another Main Bot', async (t) => {
  const planMode = fakePlanMode({ chief: true })
  const team = { ...TEAM, mainBotIds: ['chief', 'writer'] }
  const { rt, stop } = await start({ planMode, team })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'chief', text: 'PLAN-APPROVED job-1: go', role: 'request' })
  assert.deepEqual(planMode.calls, [['chief', false]])
})

test('an ORDER from a Main Bot turns plan mode off', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, stop } = await start({ planMode })
  t.after(stop)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'ORDER from Chief · job j-1 · decisions come back to me\nBuild it.', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.bot, entry.manager, entry.tool, entry.outcome], ['Coder', 'Chief', 'order', 'committed'])
})

test('an ORDER from a Bot that is not a Main Bot changes nothing and says why', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, stop } = await start({ planMode })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'ORDER from Writer · job j-2 · decisions come back to me', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.tool, entry.outcome], ['order', 'sender-not-manager'])
})

test('ORDER mid-text is not an order', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, stop } = await start({ planMode })
  t.after(stop)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'Note the ORDER from Chief · job j-3 line below', role: 'request' })
  assert.deepEqual(planMode.calls, [])
})

test('DSH_ORDER_RELEASE=off leaves PLAN-APPROVED working and ORDER inert', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, stop } = await start({ planMode })
  const before = process.env.DSH_ORDER_RELEASE
  process.env.DSH_ORDER_RELEASE = 'off'
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_ORDER_RELEASE
    else process.env.DSH_ORDER_RELEASE = before
    await stop()
  })
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'ORDER from Chief · job j-4 · decisions come back to me', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'PLAN-APPROVED j-4: go', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
})

test('a release on a Bot not in plan mode is logged as not-in-plan-mode', async (t) => {
  const planMode = fakePlanMode({})
  const { rt, log, stop } = await start({ planMode })
  t.after(stop)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'PLAN-APPROVED j-5: go', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.tool, entry.outcome], ['plan-approved', 'not-in-plan-mode'])
})

test('the gate says it is loaded at start-up', async (t) => {
  const { log, stop } = await start()
  t.after(stop)
  const lines = await log({ all: true })
  const loaded = lines.find(line => line.tool === 'gate-loaded')
  assert.ok(loaded, 'gate-loaded line written')
  assert.equal(loaded.release, 'plan-approved+order')
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

// --- 2026-11-03: plan mode under an agent preset, and Bots that start with it off ---

// The log is written asynchronously: read it until a line appears.
async function anyLines(log) {
  for (let i = 0; i < 50; i++) {
    const lines = await log()
    if (lines.length > 0) return lines
  }
  return []
}

// The same, for one tool's lines.
async function linesFor(log, tool) {
  for (let i = 0; i < 50; i++) {
    const lines = (await log()).filter(line => line.tool === tool)
    if (lines.length > 0) return lines
  }
  return []
}

test('PLAN-APPROVED reaches plan mode inside an agent preset (no Host-realm service)', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, stop } = await start({ planMode, realm: 'preset' })
  t.after(stop)
  await rt.deliver({ fromId: 'chief', toId: 'coder', text: 'PLAN-APPROVED j-6: deploy to production', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
  const entry = (await linesFor(log, 'plan-approved'))[0]
  assert.equal(entry.outcome, 'committed')
})

test('a Bot Session in plan mode is switched off once on its first delivery', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, stop } = await start({ planMode, realm: 'preset', planDefault: true })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'hello', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
  // The user turns plan mode back on in that chat: it is his choice and stays.
  planMode.active.coder = true
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'again', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
  assert.equal(planMode.active.coder, true)
  const entries = (await linesFor(log, 'plan-default-off'))
  assert.equal(entries.length, 1)
  assert.deepEqual([entries[0].bot, entries[0].why, entries[0].outcome], ['Coder', 'delivery', 'committed'])
  assert.equal(rt.state.planDefaultOff.coder, 'committed')
})

test('a Bot named in plan-mode-keep.json keeps plan mode', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, stop } = await start({ planMode, realm: 'preset', planDefault: true, keep: ['coder'] })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'hello', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  const entry = (await linesFor(log, 'plan-default-off'))[0]
  assert.equal(entry.outcome, 'kept-bot-opt-in')
})

test('a Bot with planMode on keeps plan mode', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const team = { ...TEAM, bots: { ...TEAM.bots, coder: { ...TEAM.bots.coder, planMode: 'on' } } }
  const { rt, stop } = await start({ planMode, team, realm: 'preset', planDefault: true })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'hello', role: 'request' })
  assert.deepEqual(planMode.calls, [])
})

test('a Session already out of plan mode is left as it is', async (t) => {
  const planMode = fakePlanMode({})
  const { rt, log, stop } = await start({ planMode, realm: 'preset', planDefault: true })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'hello', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  const entry = (await linesFor(log, 'plan-default-off'))[0]
  assert.equal(entry.outcome, 'already-off')
})

test('a new Bot Session DS Bot makes starts out of plan mode', async (t) => {
  const planMode = fakePlanMode({ s1: true })
  const { rt, log, stop } = await start({ planMode, realm: 'preset', planDefault: true })
  t.after(stop)
  const id = await rt.createSession('Fresh part')
  assert.equal(id, 's1')
  assert.deepEqual(planMode.calls, [['s1', false]])
  const entry = (await linesFor(log, 'plan-default-off'))[0]
  assert.deepEqual([entry.why, entry.outcome], ['new-session', 'committed'])
})

test('DSH_PLAN_DEFAULT_OFF=off leaves plan mode alone', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, stop } = await start({ planMode, realm: 'preset' })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'hello', role: 'request' })
  assert.deepEqual(planMode.calls, [])
})

// --- 2026-11-03: card routing to the manager (dsbot-card-routing-overlord) ---

const PICK = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const DEPLOY = { type: 'confirm', id: 'go', confirmLabel: 'deploy to production' }

const showView = (rt, sessionId, args) => rt.teamTools.find(d => d.name === 'show_view').execute(args, { agent: { id: sessionId }, callId: 'view-1', concludeTurn() {} })

test('an interactive show_view in a job another Bot sent is refused like ask_user', async (t) => {
  const { rt, fromBot, log, stop } = await start()
  t.after(stop)
  fromBot('writer', 'chief', 'Pick a layout')
  assert.match(await showView(rt, 'writer', { title: 'Layout', view: PICK }), /^This job came from Chief. Do not card Steve/)
  assert.equal(rt.state.views?.writer, undefined)
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.bot, entry.manager, entry.tool, entry.allowed, entry.because, entry.title], ['Writer', 'Chief', 'show_view', false, 'gated', 'Layout'])
  // A display-only view is no card and is not gated.
  fromBot('writer', 'chief', 'Show the numbers')
  assert.equal(await showView(rt, 'writer', { title: 'Meter', view: { type: 'metric', label: 'Done', value: '70%' } }), 'The view is on screen.')
})

test('a show_view whose confirm is the production approval is refused even with CARD-IT-YOURSELF', async (t) => {
  const { rt, fromBot, stop } = await start()
  t.after(stop)
  fromBot('coder', 'chief', 'Ask Steve yourself. CARD-IT-YOURSELF')
  assert.match(await showView(rt, 'coder', { title: 'Ship', view: DEPLOY }), /^This job came from Chief. A deploy approval never goes to Steve from here/)
  assert.equal(rt.state.views?.coder, undefined)
  // An ordinary interactive view is opened by the token.
  assert.match(await showView(rt, 'coder', { title: 'Layout', view: PICK }), /view is on screen; the user's answer/)
  assert.ok(rt.state.views.coder)
})

test('an interactive show_view in a turn the user typed shows as before', async (t) => {
  const { rt, fromUser, stop } = await start()
  t.after(stop)
  fromUser('writer', 'Show me the layouts')
  assert.match(await showView(rt, 'writer', { title: 'Layout', view: PICK }), /view is on screen; the user's answer/)
  assert.ok(rt.state.views.writer)
})

const ADMIN_TEAM = { ...TEAM, rooms: { seo: { id: 'seo', name: 'SEO', members: ['writer', 'coder'], mode: 'admin', admin: 'writer', named: true, sessions: {} } } }

test('PLAN-APPROVED from the admin of a group the Bot is in turns plan mode off', async (t) => {
  const planMode = fakePlanMode({ coder: true })
  const { rt, log, stop } = await start({ planMode, team: ADMIN_TEAM })
  t.after(stop)
  await rt.deliver({ fromId: 'writer', toId: 'coder', text: 'PLAN-APPROVED seo-1: go', role: 'request' })
  assert.deepEqual(planMode.calls, [['coder', false]])
  const [entry] = await anyLines(log)
  assert.deepEqual([entry.bot, entry.manager, entry.tool, entry.outcome, entry.authority], ['Coder', 'Writer', 'plan-approved', 'committed', 'group-admin'])
})

test('a group admin cannot release a Bot outside its group, nor a plain member', async (t) => {
  const planMode = fakePlanMode({ chief: true, writer: true })
  const team = { ...ADMIN_TEAM, mainBotIds: ['chief'] }
  const { rt, log, stop } = await start({ planMode, team })
  t.after(stop)
  // Chief is not in the SEO group: its admin is not Chief's manager.
  await rt.deliver({ fromId: 'writer', toId: 'chief', text: 'PLAN-APPROVED x-1: go', role: 'request' })
  // Coder is a member, not the admin: it cannot release the admin.
  await rt.deliver({ fromId: 'coder', toId: 'writer', text: 'PLAN-APPROVED x-2: go', role: 'request' })
  assert.deepEqual(planMode.calls, [])
  const lines = await anyLines(log)
  assert.deepEqual(lines.map(line => line.outcome), ['sender-not-manager', 'sender-not-manager'])
})
