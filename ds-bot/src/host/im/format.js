// Outbound text for IM platforms. Bots write Markdown; each platform adapter turns it
// into what the platform renders (Telegram HTML) or plain text, and cuts it at the
// platform's per-message limit without breaking inside a code fence when it can help it.
//
// 2026-11-10: paragraph spacing, headings, lists and tables.
// The previous version dropped every blank line and rejoined blocks with a single
// newline, so paragraphs landed tight against each other and Steve got "big blobs of
// text with no spacing". Headings, list markers, table pipes and rules had no rule at
// all, so they arrived as literal `##`, `-` and `|`. Blocks are now rejoined with a
// blank line, headings become bold, list items are double spaced, and a Markdown table
// becomes an aligned monospace block.

const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Inline Markdown inside one line or block: `code`, **bold**, _italic_, ~~strike~~,
// [label](url). Code spans are pulled out first so markers inside them stay literal.
function inlineHtml(line) {
  const spans = []
  const kept = line.replace(/`([^`]+)`/g, (_all, code) => {
    spans.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00${spans.length - 1}\x00`
  })
  const html = escapeHtml(kept)
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label, url) => `<a href="${escapeHtml(url)}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\b_([^_]+)_\b/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return html.replace(/\u0000(\d+)\u0000/g, (_all, index) => spans[Number(index)])
}

function inlinePlain(line) {
  return line
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label, url) => (label === url ? label : `${label} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\b_([^_]+)_\b/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/
const RULE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/

const isListItem = line => LIST_RE.test(line)
const isRule = line => RULE_RE.test(line)
const isTableRow = line => TABLE_ROW_RE.test(line)
const isTableSep = line => TABLE_SEP_RE.test(line)

// A table row as plain cell strings. The leading and trailing pipe are framing, not cells.
function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cell => cell.trim())
}

// Aligned monospace grid. Telegram has no tables, so this is the only shape that keeps
// columns readable; it is wrapped in <pre> so the padding survives.
function tableRows(lines) {
  return lines.filter(line => !isTableSep(line)).map(tableCells)
}

function padRows(rows, toPlainFn) {
  const plain = rows.map(cells => cells.map(cell => toPlainFn(cell)))
  const width = []
  for (const cells of plain) {
    cells.forEach((cell, index) => {
      width[index] = Math.max(width[index] ?? 0, Array.from(cell).length)
    })
  }
  return plain.map(cells => cells
    .map((cell, index) => {
      const pad = width[index] - Array.from(cell).length
      return cell + ' '.repeat(Math.max(0, pad))
    })
    .join('  ')
    .replace(/\s+$/, ''))
}

// One text block, in order, with list items separated by a blank line.
function renderLines(lines, inline, wrapHeading) {
  const out = []
  let previousWasListItem = false
  for (const line of lines) {
    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      out.push(wrapHeading(inline(heading[1])))
      previousWasListItem = false
      continue
    }
    if (isRule(line)) {
      // Same wrapper as a heading, so the plain renderer never sees HTML tags.
      out.push(wrapHeading('-'.repeat(12)))
      previousWasListItem = false
      continue
    }
    const item = isListItem(line)
    if (item && previousWasListItem) out.push('')
    out.push(inline(line))
    previousWasListItem = item
  }
  return out.join('\n')
}

function renderHtmlLines(lines) {
  return renderLines(lines, inlineHtml, inner => `<b>${inner}</b>`)
}

function renderPlainLines(lines) {
  return renderLines(lines, inlinePlain, inner => inner)
}

// Split a block's lines into table runs and ordinary runs, so a table can become <pre>
// without dragging the paragraphs beside it into monospace.
function splitRuns(lines) {
  const runs = []
  let at = 0
  while (at < lines.length) {
    if (isTableRow(lines[at])) {
      const start = at
      while (at < lines.length && isTableRow(lines[at])) at += 1
      runs.push({ kind: 'table', lines: lines.slice(start, at) })
      continue
    }
    const start = at
    while (at < lines.length && !isTableRow(lines[at])) at += 1
    runs.push({ kind: 'lines', lines: lines.slice(start, at) })
  }
  return runs
}

// One Markdown document as blocks: fenced code stays a block of its own so chunking
// can keep it whole; the rest splits on blank lines.
function blocks(markdown) {
  const out = []
  const lines = String(markdown).split('\n')
  let at = 0
  let buffer = []
  const flush = () => {
    if (buffer.length > 0) out.push({ kind: 'text', lines: buffer })
    buffer = []
  }
  while (at < lines.length) {
    const line = lines[at]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence !== null) {
      flush()
      const close = lines.slice(at + 1).findIndex(item => /^```\s*$/.test(item))
      const body = close === -1 ? lines.slice(at + 1) : lines.slice(at + 1, at + 1 + close)
      out.push({ kind: 'code', lang: fence[1] ?? '', lines: body, open: true })
      at += 1 + (close === -1 ? body.length : close + 1)
      continue
    }
    if (line.trim() === '') flush()
    else buffer.push(line)
    at += 1
  }
  flush()
  return out
}

const renderHtml = block => {
  if (block.kind === 'code') {
    return `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ''}>${escapeHtml(block.lines.join('\n'))}</code></pre>`
  }
  return splitRuns(block.lines)
    .map(run => (run.kind === 'table'
      ? `<pre>${escapeHtml(padRows(tableRows(run.lines), inlinePlain).join('\n'))}</pre>`
      : renderHtmlLines(run.lines)))
    .join('\n\n')
}

const renderPlain = block => {
  if (block.kind === 'code') return block.lines.join('\n')
  return splitRuns(block.lines)
    .map(run => (run.kind === 'table'
      ? padRows(tableRows(run.lines), inlinePlain).join('\n')
      : renderPlainLines(run.lines)))
    .join('\n\n')
}

// Blocks are one paragraph each, so they are rejoined with a BLANK line. This is the
// line that stops paragraphs running together.
const BLOCK_JOIN = '\n\n'

export function toTelegramHtml(markdown) {
  return blocks(markdown).map(renderHtml).join(BLOCK_JOIN)
}

export function toPlain(markdown) {
  return blocks(markdown).map(renderPlain).join(BLOCK_JOIN)
}

const points = text => Array.from(text).length

// Split a block that alone exceeds the limit: text at line boundaries (a line that
// is still too long is cut where it lands — Telegram answers it as plain text), a
// code fence into several fenced blocks.
function forceCut(block, limit) {
  if (block.kind !== 'code') {
    const chunks = []
    let html = ''
    let text = ''
    const flush = () => {
      if (html === '') return
      chunks.push({ html, text })
      html = ''
      text = ''
    }
    for (const line of block.lines) {
      const lineHtml = inlineHtml(line)
      const candidate = html === '' ? lineHtml : `${html}\n${lineHtml}`
      if (points(candidate) <= limit) {
        html = candidate
        text = text === '' ? inlinePlain(line) : `${text}\n${inlinePlain(line)}`
        continue
      }
      flush()
      // A single line over the limit is cut on its rendered text.
      let rest = lineHtml
      let restPlain = inlinePlain(line)
      while (points(rest) > limit) {
        const part = Array.from(rest).slice(0, limit).join('')
        const plainPart = Array.from(restPlain).slice(0, limit).join('')
        chunks.push({ html: part, text: plainPart })
        rest = Array.from(rest).slice(limit).join('')
        restPlain = Array.from(restPlain).slice(limit).join('')
      }
      html = rest
      text = restPlain
    }
    flush()
    return chunks
  }
  const chunks = []
  const open = `<pre><code${block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ''}>`
  const close = '</code></pre>'
  let body = block.lines.join('\n')
  const room = limit - points(open) - points(close)
  while (body !== '') {
    let at = Math.min(points(body), Math.max(1, room))
    const chars = Array.from(body)
    const newline = body.lastIndexOf('\n', at)
    if (newline > room / 2) at = newline
    const part = chars.slice(0, at).join('')
    chunks.push({ html: `${open}${escapeHtml(part)}${close}`, text: part })
    body = chars.slice(at).join('').replace(/^\n/, '')
  }
  return chunks
}

// Chunks of one Markdown message, each under `limit` rendered characters. Block
// boundaries are kept where possible; a fence is only split when it alone is too big.
// Plain markdown chunks at a byte-pair limit: paragraphs and lines first, a
// hard cut at the limit for one over-long run. For platforms that take
// markdown as-is (Discord, QQ, WeCom, DingTalk, Slack has its own converter).
export function chunkMarkdown(markdown, limit) {
  const chunks = []
  let rest = String(markdown ?? '')
  while (rest !== '') {
    if (points(rest) <= limit) { chunks.push(rest); break }
    let at = limit
    const newline = rest.lastIndexOf('\n', at)
    if (newline > limit / 2) at = newline
    else {
      const space = rest.lastIndexOf(' ', at)
      if (space > limit / 2) at = space
    }
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  return chunks
}

export function chunkTelegram(markdown, limit = 4096) {
  const chunks = []
  let html = ''
  let text = ''
  const flush = () => {
    if (html === '' && text === '') return
    chunks.push({ html, text })
    html = ''
    text = ''
  }
  for (const block of blocks(markdown)) {
    const blockHtml = renderHtml(block)
    const blockText = renderPlain(block)
    const candidate = html === '' ? blockHtml : `${html}${BLOCK_JOIN}${blockHtml}`
    if (points(candidate) <= limit) {
      html = candidate
      text = text === '' ? blockText : `${text}${BLOCK_JOIN}${blockText}`
      continue
    }
    flush()
    if (points(blockHtml) <= limit) {
      html = blockHtml
      text = blockText
      continue
    }
    chunks.push(...forceCut(block, limit))
  }
  flush()
  return chunks
}
