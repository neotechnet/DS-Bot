// A Bot's operator tasks in its details panel, and the count after its name in the
// chat header. The host builds the list (src/host/operator-tasks.js): Unresolved is
// what waits on the user, Active what the Bot works on. The header counts
// Unresolved only, so its number always means "this needs you".
import { createElement as h } from 'react'
import { relativeShort } from './text.js'
import { t } from './i18n.js'

const EMPTY = { active: [], unresolved: [] }

export const operatorTasksOf = (roster, botId) => roster.operatorTasks?.[botId] ?? EMPTY
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

function activeLine(item, roster) {
  switch (item.kind) {
    case 'turn': {
      const doing = item.switching ? t('Moving on to a fresh part')
        : item.tool ? (item.target ? t('Running {tool} on {target}', { tool: item.tool, target: item.target }) : t('Running {tool}', { tool: item.tool }))
          : item.text || t('Working')
      return { label: t('Working now'), text: [doing, where(roster, item)].filter(Boolean).join(' ') }
    }
    case 'order': return { label: t('Order'), text: t('From {name}', { name: nameOf(roster, item.from) }) }
    case 'waiting': return { label: t('Waiting on'), text: [...item.bots, ...item.rooms].map(id => nameOf(roster, id)).join(', ') }
    default: return { label: '', text: item.text ?? '' }
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
    h(TaskList, { key: 'active', title: t('Active Tasks'), items: tasks.active, line: activeLine, roster, empty: t('Nothing running right now.') }),
    h(TaskList, { key: 'unresolved', title: t('Unresolved Tasks'), items: tasks.unresolved, line: unresolvedLine, roster, empty: t('Nothing waiting on you.') }),
  ]
}

// After the Bot's name in the chat header; nothing at all when the count is 0.
export function UnresolvedBadge({ count }) {
  if (!(count > 0)) return null
  const label = count === 1 ? t('1 task waits on you') : t('{count} tasks wait on you', { count })
  return h('span', { className: 'bt-pill-tasks', title: label, 'aria-label': label }, count > 99 ? '99+' : String(count))
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
.bt-pill-tasks{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--bt-danger);color:var(--bt-main);font-size:11px;line-height:18px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
`
