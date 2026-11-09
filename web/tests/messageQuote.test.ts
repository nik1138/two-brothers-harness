// Focused tests for the message-quote model and its source-level wiring.
// Run with: node --import ./tests/register-ts.mjs --test tests/messageQuote.test.ts
// (from web/). The module is pure; the component checks follow the existing
// no-DOM source-level pattern used by sessionFork/usageFooter tests.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  QUOTE_MAX_CHARS,
  appendQuoteDraft,
  quoteBlock,
  quoteDraftBase,
  quoteTextForSelection,
} from '../src/messageQuote.ts'

test('quoteBlock formats every line and ends with a blank line', () => {
  assert.equal(
    quoteBlock('  first line\nsecond line  \n\n'),
    '> first line\n> second line\n\n',
  )
  // The trailing blank line is exactly one empty line.
  assert.ok(quoteBlock('one').endsWith('\n\n'))
  assert.ok(!quoteBlock('one').endsWith('\n\n\n'))
})

test('quoteBlock normalizes CRLF and lone CR to LF', () => {
  assert.equal(quoteBlock('a\r\nb\rc\nd'), '> a\n> b\n> c\n> d\n\n')
})

test('quoteBlock normalizes U+2028/U+2029 line separators', () => {
  assert.equal(quoteBlock('a\u2028b\u2029c'), '> a\n> b\n> c\n\n')
})

test('quoteBlock falls back to the default cap for a non-finite maxChars', () => {
  const source = 'x'.repeat(QUOTE_MAX_CHARS + 5)
  assert.match(quoteBlock(source, Number.NaN), new RegExp(`truncated at ${QUOTE_MAX_CHARS}`))
  assert.match(quoteBlock(source, Infinity), new RegExp(`truncated at ${QUOTE_MAX_CHARS}`))
})

test('quoteBlock preserves interior blank lines as a bare marker', () => {
  assert.equal(quoteBlock('first\n\nthird'), '> first\n>\n> third\n\n')
  assert.equal(quoteBlock('first\n   \nthird'), '> first\n>\n> third\n\n')
})

test('quoteBlock trims outer whitespace and blank lines', () => {
  assert.equal(quoteBlock('\n\n  hello  \n\n'), '> hello\n\n')
  assert.equal(quoteBlock(' \r\n\t\n'), '')
  assert.equal(quoteBlock(''), '')
})

test('quoteBlock caps long text with an honest marker', () => {
  const source = 'x'.repeat(QUOTE_MAX_CHARS + 25)
  const lines = quoteBlock(source).split('\n')
  assert.equal(lines[0], `> ${'x'.repeat(QUOTE_MAX_CHARS)}`)
  assert.equal(lines[1], `> … [quote truncated at ${QUOTE_MAX_CHARS} characters]`)
  assert.equal(lines[2], '')
  assert.equal(lines[3], '')
})

test('quoteBlock never splits a surrogate pair at the cap', () => {
  const source = `${'a'.repeat(3)}😀tail`
  const cutInsidePair = quoteBlock(source, 4)
  assert.equal(cutInsidePair.split('\n')[0], '> aaa')
  assert.match(cutInsidePair, /quote truncated at 4 characters/)
  assert.ok(!cutInsidePair.includes('😀'), 'the emoji must be dropped whole')
  assert.doesNotMatch(cutInsidePair, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  assert.doesNotMatch(cutInsidePair, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)

  // A boundary after the full pair keeps the emoji intact.
  assert.equal(quoteBlock(source, 5).split('\n')[0], '> aaa😀')
})

test('quoteTextForSelection prefers a real selection then the fallback', () => {
  assert.equal(quoteTextForSelection('  selected  ', 'fallback'), '  selected  ')
  assert.equal(quoteTextForSelection('   \n ', '  fallback  '), '  fallback  ')
  assert.equal(quoteTextForSelection(null, 'fallback'), 'fallback')
  assert.equal(quoteTextForSelection(undefined, undefined), null)
  assert.equal(quoteTextForSelection('', '  \n\t '), null)
})

test('appendQuoteDraft appends without replacing an unsent draft', () => {
  assert.equal(appendQuoteDraft('', '> q\n\n'), '> q\n\n')
  assert.equal(appendQuoteDraft('  \n', '> q\n\n'), '> q\n\n')
  assert.equal(appendQuoteDraft('keep me', '> q\n\n'), 'keep me\n\n> q\n\n')
  // Trailing whitespace on the draft is normalized, the text itself is intact.
  assert.equal(appendQuoteDraft('keep me\n\n', '> q\n\n'), 'keep me\n\n> q\n\n')
  assert.equal(appendQuoteDraft('keep me', ''), 'keep me')
})

test('quoteDraftBase preserves the stashed draft while recall is active', () => {
  assert.equal(quoteDraftBase('visible', { active: false, draft: 'keep me' }), 'visible')
  assert.equal(quoteDraftBase('recalled prompt', { active: true, draft: 'keep me' }), 'keep me')
  assert.equal(quoteDraftBase('recalled prompt', { active: true, draft: '' }), '')
  assert.equal(quoteDraftBase('visible', null), 'visible')
  // The regression scenario: draft -> ArrowUp -> quote must not lose the draft.
  const base = quoteDraftBase('old prompt', { active: true, draft: 'keep me' })
  assert.equal(appendQuoteDraft(base, '> q\n\n'), 'keep me\n\n> q\n\n')
})

test('the quote action is wired source-level (no DOM harness in web tests)', () => {
  const chat = readFileSync(
    new URL('../src/components/ChatView.vue', import.meta.url),
    'utf8',
  )
  // Selection is read before the browser can clear it; fallback reuses copy's text.
  assert.match(chat, /import \{ quoteBlock, quoteTextForSelection \} from '\.\.\/messageQuote'/)
  assert.match(chat, /window\.getSelection\(\)/)
  assert.match(chat, /intersectsNode/)
  assert.match(chat, /copyTextOf\(m\)/)
  assert.match(chat, /quoteTextForSelection\(selectionTextWithin\(body\), copyTextOf\(m\)\)/)
  assert.match(chat, /const quote = quoteBlock\(chosen\)/)
  assert.match(chat, /props\.onQuote\(quote\)/)
  assert.match(chat, /@pointerdown\.prevent/)
  assert.match(chat, /class="bubble-copy bubble-quote"/)
  assert.match(chat, /v-if="m\.body && onQuote"/)

  // Quote joins the existing toolbar between copy and fork, so copy stays first.
  const copy = chat.indexOf('aria-label="Copy message"')
  const quote = chat.indexOf('class="bubble-copy bubble-quote"')
  const fork = chat.indexOf('class="bubble-copy bubble-fork"')
  assert.ok(copy >= 0 && quote > copy && fork > quote, 'action order must stay copy, quote, fork')

  const composer = readFileSync(
    new URL('../src/components/Composer.vue', import.meta.url),
    'utf8',
  )
  assert.match(composer, /import \{ appendQuoteDraft, quoteDraftBase \} from '\.\.\/messageQuote'/)
  assert.match(composer, /props\.quote\?\.token/)
  assert.match(composer, /quoteDraftBase\(composerValue\(\), recallState\)/)
  assert.match(composer, /appendQuoteDraft\(current, quote\.text\)/)
  assert.match(composer, /el\.focus\(\)/)
  assert.match(composer, /el\.setSelectionRange\(end, end\)/)
  // The quote path must never send on its own.
  assert.doesNotMatch(
    composer.slice(composer.indexOf('props.quote?.token'), composer.indexOf('// The composer\'s @ file picker')),
    /submit\(\)/,
  )

  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /const composerQuote = ref<\{ token: number; text: string \} \| null>\(null\)/)
  assert.match(app, /function appendQuoteToComposer\(quote: string\): void/)
  assert.match(app, /:on-quote="appendQuoteToComposer"/)
  assert.match(app, /:quote="composerQuote"/)
})
