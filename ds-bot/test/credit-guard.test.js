import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { adminKeyProblem, decide, install, periodStart, settingsOf, spendOf, usageCost } from '../src/host/credit-guard.js'

const MINUTE = 60_000
const at = iso => Date.parse(iso)

test('the grant period starts on the reset day, UTC', () => {
  assert.equal(new Date(periodStart(at('2026-11-04T15:00:00Z'), 20)).toISOString(), '2026-10-20T00:00:00.000Z')
  assert.equal(new Date(periodStart(at('2026-11-20T00:00:00Z'), 20)).toISOString(), '2026-11-20T00:00:00.000Z')
  assert.equal(new Date(periodStart(at('2026-01-05T00:00:00Z'), 20)).toISOString(), '2025-12-20T00:00:00.000Z')
  assert.equal(new Date(periodStart(at('2026-03-01T00:00:00Z'), 1)).toISOString(), '2026-03-01T00:00:00.000Z')
})

test('settings need a route and a fallback; the reset day defaults to 20', () => {
  assert.equal(settingsOf({}), undefined)
  assert.equal(settingsOf({ creditGuard: { route: 'anthropic-credit' } }), undefined)
  const settings = settingsOf({ creditGuard: { route: 'anthropic-credit', fallback: 'kimi-coding/k3', bots: ['Igor'] } })
  assert.equal(settings.resetDay, 20)
  assert.equal(settings.cutAt, 190)
  assert.equal(settingsOf({ creditGuard: { route: 'r', fallback: 'f', resetDay: 31 } }).resetDay, 20)
})

test('spend adds past cost days and the higher of today cost or priced usage', () => {
  const now = at('2026-11-04T15:00:00Z')
  const costPages = [{ data: [
    { starting_at: '2026-11-02T00:00:00Z', results: [{ amount: '10000' }] },
    { starting_at: '2026-11-03T00:00:00Z', results: [{ amount: '5000' }, { amount: '50' }] },
    { starting_at: '2026-11-04T00:00:00Z', results: [{ amount: '100' }] },
  ] }]
  const usagePages = [{ data: [{ starting_at: '2026-11-04T14:00:00Z', results: [{ model: 'claude-opus-5-5', uncached_input_tokens: 1_000_000, output_tokens: 100_000 }] }] }]
  const prices = { 'claude-opus-5-5': { input: 15, output: 75 } }
  assert.equal(usageCost(usagePages, prices), 22.5)
  assert.equal(spendOf({ costPages, usagePages, prices, now }), 100 + 50.5 + 22.5)
  assert.equal(spendOf({ costPages, usagePages: [], prices, now }), 100 + 50.5 + 1)
})

test('an unknown model is priced at the dearest known rate', () => {
  const prices = { cheap: { input: 1, output: 5 }, dear: { input: 15, output: 75 } }
  assert.equal(usageCost([{ data: [{ results: [{ model: 'mystery', output_tokens: 1_000_000 }] }] }], prices), 75)
})

test('thresholds: warn, wait for a running turn, cut, hard, and blind', () => {
  const settings = settingsOf({ creditGuard: { route: 'r', fallback: 'f' } })
  const base = { blindFor: 0, settings, running: false, waitedFor: 0 }
  assert.equal(decide({ ...base, spent: 100 }).act, 'none')
  assert.equal(decide({ ...base, spent: 150 }).act, 'warn')
  assert.deepEqual(decide({ ...base, spent: 190 }), { act: 'switch', reason: 'cut' })
  assert.equal(decide({ ...base, spent: 190, running: true }).act, 'wait')
  assert.deepEqual(decide({ ...base, spent: 190, running: true, waitedFor: 10 * MINUTE }), { act: 'switch', reason: 'cut' })
  assert.deepEqual(decide({ ...base, spent: 195, running: true }), { act: 'switch', reason: 'hard' })
  assert.equal(decide({ ...base, spent: undefined, blindFor: 119 * MINUTE }).act, 'none')
  assert.deepEqual(decide({ ...base, spent: undefined, blindFor: 120 * MINUTE }), { act: 'switch', reason: 'blind' })
})

test('a missing Admin key and a wrong one are told apart', () => {
  assert.equal(adminKeyProblem(undefined), 'no-key')
  assert.equal(adminKeyProblem(''), 'no-key')
  assert.equal(adminKeyProblem('x'.repeat(63)), 'bad-key')
  assert.equal(adminKeyProblem('sk-ant-admin01-abc'), undefined)
})

// A runtime with only what the guard calls, and an Admin API that answers `cents`.
function harness({ cents, key = 'sk-ant-admin01-test', status = 200, running = false, clock }) {
  const home = mkdtempSync(join(tmpdir(), 'credit-guard-'))
  const bot = { id: 'b1', name: 'Pilot', model: 'anthropic-credit/claude-opus-5-5' }
  const delivered = []
  const listeners = []
  const effects = []
  const requests = []
  const rt = {
    home,
    config: {
      creditGuard: {
        route: 'anthropic-credit', fallback: 'kimi-coding/k3', bots: ['Pilot'], adminKey: 'TEST_ADMIN_KEY', baseUrl: 'http://admin.test',
        now: () => clock.now,
        fetch: async (url, init) => {
          requests.push({ url: String(url), key: init.headers['x-api-key'] })
          if (status !== 200) return { ok: false, status, json: async () => ({}) }
          const isCost = String(url).includes('cost_report')
          return { ok: true, status: 200, json: async () => ({ data: isCost ? [{ starting_at: '2026-11-01T00:00:00Z', results: [{ amount: String(cents.value) }] }] : [], has_more: false }) }
        },
      },
    },
    ctx: { on: (name, fn) => listeners.push([name, fn]), effect: fn => effects.push(fn) },
    secretValue: name => (name === 'TEST_ADMIN_KEY' ? key : undefined),
    findBot: ref => (ref === 'Pilot' || ref === 'b1' ? bot : undefined),
    botOf: id => (id === 'b1' ? bot : undefined),
    chatOf: () => 's1',
    groupSessionsOf: () => [],
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    live: new Map(running ? [['s1', { turn: {} }]] : []),
    updateBot: async (id, patch) => { bot.model = patch.model; return bot },
    deliver: async message => { delivered.push(message) },
    warn: () => {},
  }
  install(rt)
  return { rt, bot, delivered, listeners, requests, home, log: () => readFileSync(join(home, 'logs', 'credit-guard.log'), 'utf8'), done: () => rmSync(home, { recursive: true, force: true }) }
}

test('at the cutoff the Bot moves to the fallback and is told', async () => {
  const clock = { now: at('2026-11-04T15:00:00Z') }
  const h = harness({ cents: { value: 19_050 }, clock })
  try {
    await h.rt.creditGuardCheck()
    assert.equal(h.bot.model, 'kimi-coding/k3')
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0].text, /^\[Credit guard\] I moved you from anthropic-credit\/claude-opus-5-5 to kimi-coding\/k3 because \$190\.50 of the \$200\.00/)
    assert.ok(h.requests.every(request => request.url.startsWith('http://admin.test/v1/organizations/')))
    assert.ok(h.requests[0].url.includes('starting_at=2026-10-20T00%3A00%3A00.000Z'))
    assert.ok(!h.log().includes('sk-ant-admin'))
    assert.match(h.log(), /"event":"switch".*"ok":true/)
  } finally { h.done() }
})

test('a warning goes out once per period', async () => {
  const clock = { now: at('2026-11-04T15:00:00Z') }
  const h = harness({ cents: { value: 15_500 }, clock })
  try {
    await h.rt.creditGuardCheck()
    await h.rt.creditGuardCheck()
    assert.equal(h.bot.model, 'anthropic-credit/claude-opus-5-5')
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0].text, /\$155\.00 of the \$200\.00 credit/)
  } finally { h.done() }
})

test('a running turn holds the cutoff for up to 10 minutes, the hard line does not wait', async () => {
  const clock = { now: at('2026-11-04T15:00:00Z') }
  const cents = { value: 19_100 }
  const h = harness({ cents, running: true, clock })
  try {
    await h.rt.creditGuardCheck()
    assert.equal(h.bot.model, 'anthropic-credit/claude-opus-5-5')
    clock.now += 10 * MINUTE
    await h.rt.creditGuardCheck()
    assert.equal(h.bot.model, 'kimi-coding/k3')
  } finally { h.done() }
  const clock2 = { now: at('2026-11-04T15:00:00Z') }
  const h2 = harness({ cents: { value: 19_600 }, running: true, clock: clock2 })
  try {
    await h2.rt.creditGuardCheck()
    assert.equal(h2.bot.model, 'kimi-coding/k3')
  } finally { h2.done() }
})

test('a missing or rejected Admin key is logged as such, and fails closed after 2 hours', async () => {
  for (const [options, problem] of [[{ key: null }, 'no-key'], [{ key: 'x'.repeat(63) }, 'bad-key'], [{ status: 401 }, 'bad-key'], [{ status: 503 }, 'error']]) {
    const clock = { now: at('2026-11-04T15:00:00Z') }
    const h = harness({ cents: { value: 0 }, clock, ...options })
    try {
      await h.rt.creditGuardCheck()
      assert.equal(h.bot.model, 'anthropic-credit/claude-opus-5-5')
      assert.match(h.log(), new RegExp(`"event":"blind","problem":"${problem}"`))
      clock.now += 2 * 60 * MINUTE
      await h.rt.creditGuardCheck()
      assert.equal(h.bot.model, 'kimi-coding/k3', problem)
      assert.match(h.delivered.at(-1).text, /no reading for over 2 hours/)
    } finally { h.done() }
  }
})

test('a low-credit refusal switches the Bot at once', async () => {
  const clock = { now: at('2026-11-04T15:00:00Z') }
  const h = harness({ cents: { value: 0 }, clock })
  try {
    const [, onEvent] = h.listeners.find(([name]) => name === 'session/event')
    onEvent({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Your credit balance is too low to access the Anthropic API.' } } } })
    await h.rt.creditGuardCheck()
    assert.equal(h.bot.model, 'kimi-coding/k3')
    assert.match(h.delivered[0].text, /refused a request for low credit/)
  } finally { h.done() }
})

test('without config the guard stays off', () => {
  const rt = { config: {}, ctx: {} }
  install(rt)
  assert.deepEqual(rt.creditGuardView(), { enabled: false })
})
