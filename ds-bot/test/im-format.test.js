import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkTelegram, toPlain, toTelegramHtml } from '../src/host/im/format.js'

test('Markdown becomes Telegram HTML', () => {
  assert.equal(toTelegramHtml('**bold** and _ital_'), '<b>bold</b> and <i>ital</i>')
  assert.equal(toTelegramHtml('run `rm -rf` now'), 'run <code>rm -rf</code> now')
  assert.equal(toTelegramHtml('see [the docs](https://a.b/c)'), 'see <a href="https://a.b/c">the docs</a>')
  assert.equal(toTelegramHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
  const fenced = toTelegramHtml('before\n```js\nlet x = 1 < 2\n```\nafter')
  // A fenced block is a block of its own, so it is separated by a blank line.
  assert.equal(fenced, 'before\n\n<pre><code class="language-js">let x = 1 &lt; 2</code></pre>\n\nafter')
  assert.equal(toTelegramHtml('done ~~deal~~'), 'done <s>deal</s>')
})

test('Markdown becomes plain text', () => {
  assert.equal(toPlain('**bold** `code` [site](https://a.b)'), 'bold code site (https://a.b)')
  assert.equal(toPlain('```\nlet x = 1\n```'), 'let x = 1')
})

test('chunks stay under the limit and keep whole fences', () => {
  const fence = '```\n' + 'x'.repeat(200) + '\n```'
  const chunks = chunkTelegram(`start\n\n${fence}\n\nend`, 100)
  assert.ok(chunks.length > 1)
  const whole = chunks.find(chunk => chunk.html.includes('<pre><code>'))
  assert.ok(whole.html.length <= 100)
  // The 200-char fence cannot fit, so it is split into several fenced blocks.
  for (const chunk of chunks) assert.ok(chunk.html.length <= 100, chunk.html.length)
  // A fence that fits is not cut.
  const fits = chunkTelegram(`a\n\n${fence}`, 300)
  assert.equal(fits.length, 1)
  assert.ok(fits[0].html.includes('<pre><code>'))
})

test('an oversized line is hard cut and stays under the limit', () => {
  const chunks = chunkTelegram('y'.repeat(9000), 4096)
  assert.equal(chunks.length, 3)
  for (const chunk of chunks) assert.ok(chunk.html.length <= 4096)
})

// A Telegram message arrived as one blob with no spacing: blocks were rejoined with a
// single newline, and headings, list markers and table pipes had no rule at all.
test('a blank line between paragraphs survives', () => {
  assert.equal(toTelegramHtml('first para\n\nsecond para'), 'first para\n\nsecond para')
  assert.equal(toPlain('first para\n\nsecond para'), 'first para\n\nsecond para')
  // Every block boundary is one blank line, never a run of them.
  assert.equal(toPlain('p1\n\np2\n\np3'), 'p1\n\np2\n\np3')
})

test('a heading becomes bold instead of a literal marker', () => {
  assert.equal(toTelegramHtml('## Heading\ntext'), '<b>Heading</b>\ntext')
  assert.equal(toPlain('## Heading\ntext'), 'Heading\ntext')
})

test('list items are double spaced', () => {
  assert.equal(toTelegramHtml('- one\n- two'), '- one\n\n- two')
  assert.equal(toPlain('- one\n- two'), '- one\n\n- two')
})

test('a table becomes an aligned grid with the separator dropped', () => {
  assert.equal(toTelegramHtml('| a | b |\n| --- | --- |\n| 1 | 2 |'), '<pre>a  b\n1  2</pre>')
  assert.equal(toPlain('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'a  b\n1  2')
  // Padding is to the widest cell, so the columns line up.
  assert.equal(toPlain('| name | n |\n| --- | --- |\n| a | 22 |'), 'name  n\na     22')
})
