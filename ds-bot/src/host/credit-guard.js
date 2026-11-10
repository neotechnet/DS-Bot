// Credit guard: keeps Bots that run on a prepaid API credit route inside the monthly
// grant. It reads the organization's spend from the Anthropic Admin API, warns once
// near the limit, and at the cutoff moves each guarded Bot back to its fallback model
// and tells it in its own chat. A meter that cannot read for too long counts as over
// the cutoff: a blind meter must never let a Bot keep spending.
//
// Config, under the plugin's `creditGuard` key (no key: the guard is off):
//   route        the model route that bills the credit, e.g. 'anthropic-credit'
//   fallback     the model a guarded Bot moves to, e.g. 'kimi-coding/k3'
//   bots         names or ids of the Bots it guards
//   budget, warnAt, cutAt, hardAt   dollars (200, 150, 190, 195)
//   resetDay     day of the month the grant renews, UTC (20)
//   pollMinutes (15), blindHours (2), waitMinutes (10)
//   adminKey     the team secret (or environment variable) holding the Admin key
//   baseUrl      the Admin API ('https://api.anthropic.com')
//   prices       per million tokens, by model, for hours the cost report has not caught up on
// The Admin key is only sent to baseUrl; it is never logged or shown.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULTS = {
  budget: 200,
  warnAt: 150,
  cutAt: 190,
  hardAt: 195,
  resetDay: 20,
  pollMinutes: 15,
  blindHours: 2,
  waitMinutes: 10,
  adminKey: 'ANTHROPIC_ADMIN_KEY',
  baseUrl: 'https://api.anthropic.com',
  // Unknown models are priced at the dearest entry, so an estimate errs high.
  prices: { 'claude-opus-5-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
}
const ADMIN_PREFIX = 'sk-ant-admin'
const CREDIT_ERROR = /credit balance is too low|insufficient.{0,20}credit/i
const MINUTE = 60_000

export function settingsOf(config) {
  const raw = config?.creditGuard
  if (raw === undefined || raw === null || raw.enabled === false) return undefined
  const merged = { ...DEFAULTS, ...raw, prices: { ...DEFAULTS.prices, ...raw.prices } }
  if (typeof merged.route !== 'string' || merged.route === '' || typeof merged.fallback !== 'string' || merged.fallback === '') return undefined
  merged.bots = Array.isArray(merged.bots) ? merged.bots.filter(name => typeof name === 'string' && name !== '') : []
  const day = Math.trunc(Number(merged.resetDay))
  merged.resetDay = day >= 1 && day <= 28 ? day : DEFAULTS.resetDay
  return merged
}

// The start of the grant period that holds `now`: the reset day at 00:00 UTC, this
// month if it has passed, else last month.
export function periodStart(now, resetDay) {
  const date = new Date(now)
  let year = date.getUTCFullYear()
  let month = date.getUTCMonth()
  if (date.getUTCDate() < resetDay) {
    month -= 1
    if (month < 0) { month = 11; year -= 1 }
  }
  return Date.UTC(year, month, resetDay)
}

const startOfDay = at => {
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

// Dollars per bucket start. The cost report gives each amount in cents, as a decimal string.
export function costBuckets(pages) {
  const byDay = new Map()
  for (const page of pages) {
    for (const bucket of page?.data ?? []) {
      const at = Date.parse(bucket.starting_at)
      if (!Number.isFinite(at)) continue
      let cents = 0
      for (const result of bucket.results ?? []) {
        const amount = Number(result.amount)
        if (Number.isFinite(amount)) cents += amount
      }
      byDay.set(at, (byDay.get(at) ?? 0) + cents / 100)
    }
  }
  return byDay
}

const priceOf = (prices, model) => {
  if (prices[model]) return prices[model]
  const entry = Object.entries(prices).find(([name]) => typeof model === 'string' && model.startsWith(name))
  if (entry) return entry[1]
  return Object.values(prices).reduce((dearest, price) => (price.output > (dearest?.output ?? -1) ? price : dearest), undefined)
}

// Dollars for token usage at list prices, from usage report pages.
export function usageCost(pages, prices) {
  let dollars = 0
  for (const page of pages) {
    for (const bucket of page?.data ?? []) {
      for (const result of bucket.results ?? []) {
        const price = priceOf(prices, result.model)
        if (price === undefined) continue
        const creation = result.cache_creation ?? {}
        const written = (creation.ephemeral_5m_input_tokens ?? 0) + (creation.ephemeral_1h_input_tokens ?? 0)
        dollars += ((result.uncached_input_tokens ?? 0) * price.input
          + (result.cache_read_input_tokens ?? 0) * (price.cacheRead ?? price.input)
          + written * (price.cacheWrite ?? price.input)
          + (result.output_tokens ?? 0) * price.output) / 1_000_000
      }
    }
  }
  return dollars
}

// Month-to-date dollars: the cost report for every day before today, and for today
// whichever is higher of its partial cost bucket and the usage priced at list rates.
export function spendOf({ costPages, usagePages, prices, now }) {
  const today = startOfDay(now)
  let total = 0
  let todayCost = 0
  for (const [at, dollars] of costBuckets(costPages)) {
    if (at >= today) todayCost += dollars
    else total += dollars
  }
  return total + Math.max(todayCost, usageCost(usagePages, prices))
}

// What the guard does with one reading. `blindFor` is how long no reading has worked.
export function decide({ spent, blindFor, settings, running, waitedFor }) {
  const blind = spent === undefined
  if (blind && blindFor < settings.blindHours * 60 * MINUTE) return { act: 'none' }
  if (blind || spent >= settings.hardAt) return { act: 'switch', reason: blind ? 'blind' : 'hard' }
  if (spent >= settings.cutAt) {
    if (running && waitedFor < settings.waitMinutes * MINUTE) return { act: 'wait' }
    return { act: 'switch', reason: 'cut' }
  }
  if (spent >= settings.warnAt) return { act: 'warn' }
  return { act: 'none' }
}

export function adminKeyProblem(key) {
  if (typeof key !== 'string' || key === '') return 'no-key'
  if (!key.startsWith(ADMIN_PREFIX)) return 'bad-key'
  return undefined
}

const money = value => `$${value.toFixed(2)}`

export function install(rt) {
  const settings = settingsOf(rt.config)
  if (settings === undefined) {
    rt.creditGuardView = () => ({ enabled: false })
    return
  }
  const { ctx } = rt
  const fetchFn = rt.config.creditGuard.fetch ?? globalThis.fetch
  const now = rt.config.creditGuard.now ?? (() => Date.now())
  const statePath = join(rt.home, 'credit-guard.json')
  const logPath = join(rt.home, 'logs', 'credit-guard.log')
  const startedAt = now()
  let record = { period: 0, warned: [], switched: [] }
  let lastGood
  let lastReading
  let waitingSince
  let timer = null
  let stopped = false
  let busy = Promise.resolve()

  const log = async (entry) => {
    const line = JSON.stringify({ at: new Date(now()).toISOString(), ...entry })
    try {
      await mkdir(join(rt.home, 'logs'), { recursive: true })
      await appendFile(logPath, `${line}\n`, 'utf8')
    } catch (error) { rt.warn?.('ds-bot: credit guard log not written: %s', error?.message ?? error) }
  }
  const loadRecord = async () => {
    try { record = { ...record, ...JSON.parse(await readFile(statePath, 'utf8')) } } catch { /* first run */ }
  }
  const saveRecord = () => writeFile(statePath, JSON.stringify(record, null, 1), 'utf8')
    .catch(error => rt.warn?.('ds-bot: credit guard state not saved: %s', error?.message ?? error))

  const adminKey = () => rt.secretValue?.(settings.adminKey) ?? process.env[settings.adminKey]

  async function pages(path, query, key) {
    const out = []
    let page
    for (let count = 0; count < 20; count++) {
      const url = new URL(path, settings.baseUrl)
      for (const [name, value] of Object.entries(query)) url.searchParams.append(name, value)
      if (page) url.searchParams.set('page', page)
      const response = await fetchFn(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error(`Admin API ${response.status}`), { kind: 'bad-key', status: response.status })
      if (!response.ok) throw Object.assign(new Error(`Admin API ${response.status}`), { kind: 'error', status: response.status })
      const body = await response.json()
      out.push(body)
      if (!body?.has_more || !body.next_page) break
      page = body.next_page
    }
    return out
  }

  // One reading: dollars spent this period, or `undefined` with the reason it failed.
  async function read() {
    const key = adminKey()
    const problem = adminKeyProblem(key)
    if (problem) return { problem }
    const at = now()
    const start = new Date(periodStart(at, settings.resetDay)).toISOString()
    const today = new Date(startOfDay(at)).toISOString()
    try {
      const costPages = await pages('/v1/organizations/cost_report', { starting_at: start, bucket_width: '1d' }, key)
      const usagePages = await pages('/v1/organizations/usage_report/messages', { starting_at: today, bucket_width: '1h', 'group_by[]': 'model' }, key)
      return { spent: spendOf({ costPages, usagePages, prices: settings.prices, now: at }) }
    } catch (error) {
      return { problem: error?.kind ?? 'error', status: error?.status }
    }
  }

  const guarded = () => settings.bots.map(ref => rt.findBot?.(ref)).filter(bot => bot !== undefined
    && typeof bot.model === 'string' && bot.model.startsWith(`${settings.route}/`) && bot.model !== settings.fallback)
  const sessionsOf = bot => [rt.chatOf?.(bot.id), ...(rt.groupSessionsOf?.(bot.id) ?? [])].filter(Boolean)
  const running = bot => sessionsOf(bot).some(id => rt.live?.get(id)?.turn !== undefined)

  async function notify(bot, text) {
    await rt.deliver({ toId: bot.id, role: 'update', text })
      .catch(error => rt.warn?.('ds-bot: credit guard notice for %s not delivered: %s', bot.name, error?.message ?? error))
  }

  async function switchBot(bot, why, spent) {
    const from = bot.model
    await rt.updateBot(bot.id, { model: settings.fallback })
    const after = rt.botOf?.(bot.id)?.model
    const ok = after === settings.fallback || (typeof after === 'string' && !after.startsWith(`${settings.route}/`))
    await log({ event: 'switch', bot: bot.name, from, to: after, why, spent, ok })
    if (!ok) return
    record.switched = [...new Set([...record.switched, bot.id])]
    await saveRecord()
    const reading = spent === undefined ? 'the spend meter has had no reading for over ' + settings.blindHours + ' hours'
      : `${money(spent)} of the ${money(settings.budget)} credit is used this month`
    const reason = why === 'credit-error' ? 'the API refused a request for low credit' : reading
    await notify(bot, `[Credit guard] I moved you from ${from} to ${after} because ${reason}. Your next turns run on ${after}. Tell the user in your next reply.`)
  }

  async function check() {
    const at = now()
    const period = periodStart(at, settings.resetDay)
    if (record.period !== period) record = { period, warned: [], switched: [] }
    const reading = await read()
    lastReading = { at, ...reading }
    if (reading.spent !== undefined) lastGood = at
    await log(reading.spent !== undefined
      ? { event: 'reading', spent: Number(reading.spent.toFixed(2)) }
      : { event: 'blind', problem: reading.problem, ...(reading.status ? { status: reading.status } : {}) })
    const bots = guarded()
    const blindFor = at - (lastGood ?? startedAt)
    let waiting = false
    for (const bot of bots) {
      const busyNow = running(bot)
      const decision = decide({ spent: reading.spent, blindFor, settings, running: busyNow, waitedFor: waitingSince === undefined ? 0 : at - waitingSince })
      if (decision.act === 'warn' && !record.warned.includes(bot.id)) {
        record.warned.push(bot.id)
        await saveRecord()
        await log({ event: 'warn', bot: bot.name, spent: reading.spent })
        await notify(bot, `[Credit guard] ${money(reading.spent)} of the ${money(settings.budget)} credit is used this month. At ${money(settings.cutAt)} I move you to ${settings.fallback}. Tell the user in your next reply.`)
      } else if (decision.act === 'wait') {
        waiting = true
        await log({ event: 'wait', bot: bot.name, spent: reading.spent })
      } else if (decision.act === 'switch') {
        await switchBot(bot, decision.reason, reading.spent)
      }
    }
    if (waiting) waitingSince ??= at
    else waitingSince = undefined
    return waiting
  }

  const schedule = (ms) => {
    if (stopped) return
    timer = setTimeout(() => { busy = busy.then(run, run) }, ms)
  }
  async function run() {
    let waiting = false
    try { waiting = await check() } catch (error) { await log({ event: 'error', message: String(error?.message ?? error).slice(0, 200) }) }
    schedule(waiting ? MINUTE : settings.pollMinutes * MINUTE)
  }

  // A refusal for low credit is an immediate cutoff, whatever the meter says.
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const reason = event.data?.reason
    if (reason?.kind !== 'error') return
    const message = String(reason.error?.message ?? '')
    if (!CREDIT_ERROR.test(message)) return
    const ownerId = rt.chatOwners?.get?.(session?.id) ?? rt.groupOwners?.get?.(session?.id)?.botId
    const bot = guarded().find(entry => entry.id === ownerId || sessionsOf(entry).includes(session?.id))
    if (bot === undefined) return
    busy = busy.then(() => switchBot(bot, 'credit-error', undefined)).catch(error => rt.warn?.('ds-bot: credit guard switch failed: %s', error?.message ?? error))
  })

  ctx.effect?.(() => {
    void loadRecord().then(() => log({ event: 'start', route: settings.route, fallback: settings.fallback, bots: settings.bots, resetDay: settings.resetDay })).then(() => schedule(0))
    return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
  }, 'ds-bot: credit guard')

  rt.creditGuardView = () => ({
    enabled: true,
    route: settings.route,
    budget: settings.budget,
    reading: lastReading === undefined ? undefined
      : { at: lastReading.at, ...(lastReading.spent === undefined ? { problem: lastReading.problem } : { spent: lastReading.spent }) },
  })
  rt.creditGuardCheck = () => (busy = busy.then(check, check))
}
