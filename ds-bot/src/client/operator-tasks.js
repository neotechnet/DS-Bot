// A Bot's operator tasks in its details panel, and the two counts after its name in the
// chat header. The host builds the lists (src/host/operator-tasks.js): Operator is what
// the user asked the Bot to do, Active what it does for anyone else, Unresolved what
// waits on the user. The header shows "A · U": A in accent blue, U in the danger colour.
import { createElement as h } from 'react'
import { relativeShort } from './text.js'
import { t } from './i18n.js'

const EMPTY = { operator: [], active: [], unresolved: [] }

export const operatorTasksOf = (roster, botId) => roster.operatorTasks?.[botId] ?? EMPTY
export const operatorCount = (roster, botId) => operatorTasksOf(roster, botId).operator.length
export const unresolvedCount = (roster, botId) => operatorTasksOf(roster, botId).unresolved.length

const nameOf = (roster, id) => roster.byId?.[id]?.name ?? roster.roomsById?.[id]?.name ?? t('a teammate')
const where = (roster, item) => (item.roomId ? t('in group "{name}"', { name: roster.roomsById?.[item.roomId]?.name ?? t('a group') }) : '')

function unresolvedLine(item) {
  switch (item.kind) {
    case 'question': return { label: t('Question card'), text: item.text || t('A card waiting for your answer') }
    case 'view': return { label: t('Answer card'), text: item.text || t('A card waiting for your answer') }
    case 'key': return { label: t('Key request'), text: item.detail ? `${item.text}: ${item.detail}` : item.text }
    case 'approval': return { label: t('Tool approval'), text: item.detail ? `${item.text}: ${item.detail}` : item.text }
    case 'decision': return {
      label: t('Decision {id}', { id: item.id }),
      text: item.text,
      note: [item.due ? t('due {date}', { date: item.due }) : '', item.carded ? '' : t('not shown on a card yet')].filter(Boolean).join(', '),
    }
    default: return { label: '', text: item.text ?? '' }
  }
}

// The running tool step, when there is one. It is a step on the job, never the job.
const stepOf = (item) => {
  if (item.switching) return t('Moving on to a fresh part')
  if (item.tool === undefined) return undefined
  return item.target ? t('Running {tool} on {target}', { tool: item.tool, target: item.target }) : t('Running {tool}', { tool: item.tool })
}

// What a running item is doing, in its own words.
const doingOf = (item) => stepOf(item) ?? item.text ?? t('Working')

// The operator's own words for the job: the first line of the message they sent, as it
// was written. The step below it may move on, but the ask stays what it was.
const askOf = (item) => {
  const line = String(item.text ?? '').split(/\r?\n/).map(part => part.trim()).find(part => part !== '')
  return line ?? t('The ask is not recorded')
}

function activeLine(item, roster) {
  switch (item.kind) {
    case 'turn': return { label: t('Working now'), text: [doingOf(item), where(roster, item)].filter(Boolean).join(' ') }
    case 'order': return { label: t('Order'), text: t('From {name}', { name: nameOf(roster, item.from) }) }
    case 'waiting': return { label: t('Waiting on'), text: [...item.bots, ...item.rooms].map(id => nameOf(roster, id)).join(', ') }
    default: return { label: '', text: item.text ?? '' }
  }
}

// The user's own work: the ask in their words, or the manager Bot that passed it on.
function operatorLine(item, roster) {
  switch (item.kind) {
    case 'ask': return { label: t('Your ask'), text: askOf(item), note: stepOf(item) }
    case 'relay': return { label: t('Relayed by {name}', { name: item.via ?? t('a teammate') }), text: askOf(item), note: stepOf(item) }
    default: return activeLine(item, roster)
  }
}

function TaskList({ title, items, line, roster, empty }) {
  return h('div', { className: 'bt-ops' },
    h('div', { className: 'bt-section-title' }, items.length === 0 ? title : t('{title} · {count}', { title, count: items.length })),
    items.length === 0
      ? h('div', { className: 'bt-ops-empty' }, empty)
      : h('ul', { className: 'bt-ops-list' }, items.map((item) => {
          const shown = line(item, roster)
          return h('li', { key: item.key, className: 'bt-ops-item', 'data-kind': item.kind },
            h('div', { className: 'bt-ops-top' },
              h('span', { className: 'bt-ops-label' }, shown.label),
              item.at ? h('span', { className: 'bt-ops-age', title: new Date(item.at).toLocaleString() }, relativeShort(item.at)) : null),
            shown.text ? h('div', { className: 'bt-ops-text' }, shown.text) : null,
            shown.note ? h('div', { className: 'bt-ops-note' }, shown.note) : null)
        })))
}

export function OperatorTasks({ bot, roster }) {
  const tasks = operatorTasksOf(roster, bot.id)
  return [
    h(TaskList, { key: 'operator', title: t('Operator Tasks'), items: tasks.operator, line: operatorLine, roster, empty: t('Nothing of yours in hand.') }),
    h(TaskList, { key: 'active', title: t('Active Tasks'), items: tasks.active, line: activeLine, roster, empty: t('Nothing running right now.') }),
    h(TaskList, { key: 'unresolved', title: t('Unresolved Tasks'), items: tasks.unresolved, line: unresolvedLine, roster, empty: t('Nothing waiting on you.') }),
  ]
}

// After the Bot's name in the chat header: "A · U", the tasks the user gave it and the
// tasks waiting on the user. Nothing at all when both are 0.
const capped = count => (count > 99 ? '99+' : String(count))

export function OperatorBadge({ operator, unresolved }) {
  const yours = operator > 0 ? operator : 0
  const waiting = unresolved > 0 ? unresolved : 0
  if (yours === 0 && waiting === 0) return null
  const label = waiting === 0
    ? (yours === 1 ? t('1 task from you') : t('{count} tasks from you', { count: yours }))
    : yours === 0
      ? (waiting === 1 ? t('1 task waits on you') : t('{count} tasks wait on you', { count: waiting }))
      : t('{yours} from you, {waiting} waiting on you', { yours, waiting })
  return h('span', { className: 'bt-pill-tasks', title: label, 'aria-label': label },
    h('span', { className: 'bt-pill-yours' }, capped(yours)),
    h('span', { className: 'bt-pill-dot', 'aria-hidden': true }, '·'),
    h('span', { className: 'bt-pill-waiting' }, capped(waiting)))
}

export const OPERATOR_TASKS_CSS = `
.bt-ops-empty{font-size:12px;line-height:16px;color:var(--bt-ink-3);padding:2px 0}
.bt-ops-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.bt-ops-item{padding:6px 8px;border-radius:8px;background:var(--bt-hover);min-width:0}
.bt-ops-top{display:flex;align-items:baseline;gap:8px}
.bt-ops-label{flex:1;min-width:0;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ops-age{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-ops-text{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-ops-note{font-size:11px;line-height:15px;color:var(--bt-ink-3);margin-top:2px}
.bt-pill-tasks{flex:none;display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;border-radius:999px;background:var(--bt-hover);font-size:11px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-pill-yours{color:var(--bt-accent)}
.bt-pill-waiting{color:var(--bt-danger)}
.bt-pill-dot{color:var(--bt-ink-3);font-weight:400}
`
