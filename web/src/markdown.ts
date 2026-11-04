// Hand-rolled Markdown subset renderer for transcript payload bodies.
//
// Safety model: the parser never produces HTML. parseMarkdown() returns a typed
// block tree and the view renders it as Vue text nodes, so every author-supplied
// string is escaped by the DOM (there is no v-html anywhere in web/src). Link
// destinations are restricted to http(s)/mailto by isSafeHref(), so
// `javascript:`, `data:` and `vbscript:` URLs can never become anchors.
//
// Bounded by construction: the raw input, each line, the block count, the
// inline-node count, list items, and table dimensions are all clipped. Model
// output is untrusted and often malformed, so every construct falls back to
// literal text when it does not parse.
//
// Supported subset: ATX headings, paragraphs, bold/italic (including
// `***both***`), inline code, fenced code blocks with an optional language
// label, bullet/numbered lists (indent levels 0-3), blockquotes, GFM pipe
// tables, thematic breaks, `[text](url)` links, `<https://…>` autolinks and
// bare-URL autolinks.
// Deliberately unsupported: raw HTML (shown literally), images, footnotes,
// reference-style links, setext headings, nested blockquotes, HTML blocks.

export const MARKDOWN_LIMITS = {
  /** Total characters parsed; longer bodies are clipped. */
  inputChars: 100_000,
  /** Characters per input line; longer lines are clipped with an ellipsis. */
  lineChars: 4_000,
  /** Maximum number of blocks emitted. */
  blocks: 1_500,
  /** Maximum inline nodes per body (all recursion levels combined). */
  inlineNodes: 6_000,
  /** Maximum emphasis/link nesting depth. */
  inlineDepth: 4,
  /** Maximum list items per list block. */
  listItems: 400,
  /** Maximum table body rows. */
  tableRows: 120,
  /** Maximum table columns. */
  tableCols: 12,
  /** Maximum characters of a URL we keep (bounds pathological input). */
  urlChars: 2_000,
} as const

export interface MarkdownText {
  type: 'text'
  text: string
}

export interface MarkdownCodeSpan {
  type: 'code'
  text: string
}

export interface MarkdownBreak {
  type: 'break'
}

export interface MarkdownEmphasis {
  type: 'strong' | 'em'
  children: MarkdownInline[]
}

export interface MarkdownLink {
  type: 'link'
  url: string
  children: MarkdownInline[]
}

export type MarkdownInline =
  | MarkdownText
  | MarkdownCodeSpan
  | MarkdownBreak
  | MarkdownEmphasis
  | MarkdownLink

export type MarkdownAlign = 'left' | 'center' | 'right'

export interface MarkdownListItem {
  /** Indent level, 0 = top level, capped at 3. */
  level: number
  inlines: MarkdownInline[]
}

export type MarkdownBlock =
  | { type: 'paragraph'; inlines: MarkdownInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: MarkdownInline[] }
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'quote'; lines: MarkdownInline[][] }
  | {
      type: 'table'
      align: MarkdownAlign[]
      header: MarkdownInline[][]
      rows: MarkdownInline[][][]
    }
  | { type: 'rule' }
  | { type: 'note'; text: string }

const SAFE_SCHEME_RE = /^(?:https?:\/\/|mailto:)/i
const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g

/** Allow only absolute http(s)/mailto destinations; everything else is text. */
export function isSafeHref(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed || trimmed.length > MARKDOWN_LIMITS.urlChars) return false
  // Control characters can smuggle a different scheme past naive checks.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false
  if (!SAFE_SCHEME_RE.test(trimmed)) return false
  try {
    new URL(trimmed)
    return true
  } catch {
    return false
  }
}

/** Drop trailing punctuation that almost never belongs to a bare URL. */
function trimUrlTail(url: string): string {
  let s = url.replace(/[.,;:!?'"]+$/, '')
  while (s.endsWith(')') && (s.match(/\)/g)?.length ?? 0) > (s.match(/\(/g)?.length ?? 0)) {
    s = s.slice(0, -1)
  }
  while (s.endsWith(']') && (s.match(/\]/g)?.length ?? 0) > (s.match(/\[/g)?.length ?? 0)) {
    s = s.slice(0, -1)
  }
  return s
}

// -- inline parser -----------------------------------------------------------

interface InlineBudget {
  nodes: number
  exhausted: boolean
}

function text(value: string): MarkdownText {
  return { type: 'text', text: value }
}

function pushInline(out: MarkdownInline[], node: MarkdownInline) {
  const last = out[out.length - 1]
  if (node.type === 'text' && last?.type === 'text') {
    out[out.length - 1] = text(last.text + node.text)
    return
  }
  out.push(node)
}

/** Index of the closing backtick run of exactly `len` backticks, or -1. */
function findCodeSpanEnd(src: string, from: number, len: number): number {
  const token = '`'.repeat(len)
  let i = from
  for (;;) {
    const at = src.indexOf(token, i)
    if (at < 0) return -1
    const end = at + len
    if (src[end] === '`' || src[at - 1] === '`') {
      i = end
      continue
    }
    return at
  }
}

interface LinkTarget {
  label: string
  url: string
  end: number
}

/** Parse `[label](url)` starting at `start`; null when malformed. */
function parseLinkAt(src: string, start: number): LinkTarget | null {
  const labelEnd = findClosingBracket(src, start + 1)
  if (labelEnd < 0) return null
  if (src[labelEnd + 1] !== '(') return null
  const label = src.slice(start + 1, labelEnd)
  if (!label.trim()) return null
  const urlEnd = findClosingParen(src, labelEnd + 2)
  if (urlEnd < 0) return null
  let url = src.slice(labelEnd + 2, urlEnd).trim()
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim()
  // Drop an optional "title" part: [text](url "title")
  const space = url.search(/\s/)
  if (space >= 0) url = url.slice(0, space)
  if (url.length > MARKDOWN_LIMITS.urlChars) return null
  return { label, url, end: urlEnd + 1 }
}

function findClosingBracket(src: string, from: number): number {
  let depth = 0
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      if (depth === 0) return i
      depth -= 1
    }
    if (i - from > MARKDOWN_LIMITS.urlChars) return -1
  }
  return -1
}

function findClosingParen(src: string, from: number): number {
  let depth = 0
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      if (depth === 0) return i
      depth -= 1
    }
    if (i - from > MARKDOWN_LIMITS.urlChars) return -1
  }
  return -1
}

/** Index of the closing emphasis marker run, or -1 when there is none nearby. */
function findEmphasisEnd(src: string, from: number, marker: string, len: number): number {
  const token = marker.repeat(len)
  let i = from
  while (i < src.length) {
    const at = src.indexOf(token, i)
    if (at < 0 || at > from + 500) return -1
    const next = src[at + len]
    // "**" is never the closing marker of a single-* emphasis run, and vice versa.
    if (src[at + 1] === marker && len === 1) {
      i = at + 2
      continue
    }
    const inner = src.slice(from, at)
    const badInner = inner.trim() === '' || /\s$/.test(inner)
    const badUnderscore = marker === '_' && next !== undefined && /[\w]/.test(next)
    if (badInner || badUnderscore) {
      i = at + len
      continue
    }
    return at
  }
  return -1
}

const ESCAPABLE = '\\`*_{}[]()#+-.!_>|<>~'

function parseInline(
  src: string,
  budget: InlineBudget,
  depth = 0,
  allowLinks = true,
): MarkdownInline[] {
  const out: MarkdownInline[] = []
  if (budget.exhausted) return out
  let i = 0
  while (i < src.length) {
    if (budget.nodes >= MARKDOWN_LIMITS.inlineNodes) {
      budget.exhausted = true
      break
    }
    const ch = src[i]
    const prev = i > 0 ? src[i - 1] : ''

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      pushInline(out, text(src[i + 1]))
      budget.nodes += 1
      i += 2
      continue
    }

    if (ch === '\n') {
      pushInline(out, { type: 'break' })
      budget.nodes += 1
      i += 1
      continue
    }

    if (ch === '`') {
      let run = 0
      while (src[i + run] === '`') run += 1
      const end = findCodeSpanEnd(src, i + run, run)
      if (end > 0) {
        const body = src.slice(i + run, end).replace(/\n/g, ' ')
        if (body.trim() !== '') {
          pushInline(out, { type: 'code', text: body })
          budget.nodes += 1
          i = end + run
          continue
        }
      }
      pushInline(out, text('`'.repeat(run)))
      i += run
      continue
    }

    if (ch === '[' && allowLinks) {
      const link = parseLinkAt(src, i)
      if (link && isSafeHref(link.url)) {
        const children =
          depth < MARKDOWN_LIMITS.inlineDepth
            ? parseInline(link.label, budget, depth + 1, false)
            : [text(link.label)]
        pushInline(out, { type: 'link', url: link.url, children })
        budget.nodes += 1
        i = link.end
        continue
      }
    }

    if (ch === '<' && allowLinks) {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i))
      if (m && isSafeHref(m[1])) {
        const url = trimUrlTail(m[1])
        pushInline(out, { type: 'link', url, children: [text(url)] })
        budget.nodes += 1
        i += m[0].length
        continue
      }
    }

    if ((ch === '*' || ch === '_') && depth < MARKDOWN_LIMITS.inlineDepth) {
      const next = src[i + 1]
      const intrawordUnderscore = ch === '_' && prev !== '' && /[\w]/.test(prev)
      if (next !== undefined && !/\s/.test(next) && !intrawordUnderscore) {
        // Prefer ***both*** / ___both___ over nested single/double runs.
        if (src.slice(i, i + 3) === ch.repeat(3)) {
          const end3 = findEmphasisEnd(src, i + 3, ch, 3)
          if (end3 > 0) {
            const inner = parseInline(src.slice(i + 3, end3), budget, depth + 1, allowLinks)
            pushInline(out, { type: 'em', children: [{ type: 'strong', children: inner }] })
            budget.nodes += 1
            i = end3 + 3
            continue
          }
        }
        const len = next === ch ? 2 : 1
        const end = findEmphasisEnd(src, i + len, ch, len)
        if (end > 0) {
          const inner = parseInline(src.slice(i + len, end), budget, depth + 1, allowLinks)
          pushInline(out, { type: len === 2 ? 'strong' : 'em', children: inner })
          budget.nodes += 1
          i = end + len
          continue
        }
      }
      pushInline(out, text(ch))
      i += 1
      continue
    }

    if (ch === 'h' && allowLinks && (prev === '' || /[\s([{<"']/.test(prev))) {
      BARE_URL_RE.lastIndex = i
      const m = BARE_URL_RE.exec(src)
      if (m && m.index === i) {
        const url = trimUrlTail(m[0])
        if (url.length > 0 && isSafeHref(url)) {
          pushInline(out, { type: 'link', url, children: [text(url)] })
          budget.nodes += 1
          // Keep trailing punctuation that trimUrlTail stripped as text.
          i += url.length
          continue
        }
      }
    }

    pushInline(out, text(ch))
    budget.nodes += 1
    i += 1
  }
  return out
}

/** Parse one line of inline markdown (used by paragraphs, headings, cells). */
export function parseInlineMarkdown(source: string): MarkdownInline[] {
  return parseInline(source, { nodes: 0, exhausted: false })
}

// -- block parser ------------------------------------------------------------

const FENCE_OPEN_RE = /^\s*(`{3,})([^`]*)$/
const FENCE_CLOSE_RE = /^\s*(`{3,})\s*$/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const RULE_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/

function fenceLang(info: string): string | null {
  const first = info.trim().split(/\s+/)[0] ?? ''
  const clean = first.replace(/[^\w+#.-]/g, '').slice(0, 20)
  return clean || null
}

function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '\\|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  if (cells.length > 0 && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return cells.slice(0, MARKDOWN_LIMITS.tableCols)
}

function isTableDelimiter(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  const cells = splitTableRow(line)
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c))
}

function tableAligns(line: string): MarkdownAlign[] {
  return splitTableRow(line).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

function indentLevel(indent: string): number {
  const width = indent.replace(/\t/g, '  ').length
  return Math.min(3, Math.floor(width / 2))
}

/** True when a line starts a block that ends a paragraph. */
function startsBlock(line: string, next: string | undefined): boolean {
  if (FENCE_OPEN_RE.test(line)) return true
  if (HEADING_RE.test(line)) return true
  if (RULE_RE.test(line)) return true
  if (QUOTE_RE.test(line)) return true
  if (LIST_RE.test(line)) return true
  if (line.includes('|') && next !== undefined && isTableDelimiter(next)) return true
  return false
}

/**
 * Parse a payload body into renderable blocks. Always returns at least the
 * literal text when the input is non-empty; never throws on malformed input.
 */
export function parseMarkdown(raw: string): MarkdownBlock[] {
  if (typeof raw !== 'string' || raw === '') return []

  let source = raw.replace(/\r\n?/g, '\n')
  let clipped = false
  if (source.length > MARKDOWN_LIMITS.inputChars) {
    source = source.slice(0, MARKDOWN_LIMITS.inputChars)
    clipped = true
  }

  const lines = source.split('\n').map((line) => {
    if (line.length <= MARKDOWN_LIMITS.lineChars) return line
    clipped = true
    return `${line.slice(0, MARKDOWN_LIMITS.lineChars)}…`
  })

  const blocks: MarkdownBlock[] = []
  const budget: InlineBudget = { nodes: 0, exhausted: false }
  const inline = (value: string) => parseInline(value, budget)
  let i = 0

  const overBudget = () => blocks.length >= MARKDOWN_LIMITS.blocks

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (overBudget()) {
      clipped = true
      break
    }

    const fence = FENCE_OPEN_RE.exec(line)
    if (fence) {
      const fenceLen = fence[1].length
      const lang = fenceLang(fence[2] ?? '')
      const body: string[] = []
      i += 1
      // An unterminated fence extends to the end of the body (CommonMark
      // tolerant behavior, matching the previous rich-text renderer).
      while (i < lines.length) {
        const close = FENCE_CLOSE_RE.exec(lines[i])
        if (close && close[1].length >= fenceLen) {
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1].length) as 1 | 2 | 3 | 4 | 5 | 6
      const label = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      blocks.push({ type: 'heading', level, inlines: inline(label) })
      i += 1
      continue
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    if (QUOTE_RE.test(line)) {
      const quoteLines: MarkdownInline[][] = []
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i])
        if (!m) break
        // Flatten deeper quote markers: "> > x" reads as "x" in one quote.
        let content = m[1]
        let deeper = QUOTE_RE.exec(content)
        while (deeper) {
          content = deeper[1]
          deeper = QUOTE_RE.exec(content)
        }
        quoteLines.push(inline(content))
        i += 1
      }
      blocks.push({ type: 'quote', lines: quoteLines })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitTableRow(line).map((c) => inline(c))
      const align = tableAligns(lines[i + 1])
      const rows: MarkdownInline[][][] = []
      i += 2
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        lines[i].includes('|') &&
        rows.length < MARKDOWN_LIMITS.tableRows &&
        !startsBlock(lines[i], lines[i + 1])
      ) {
        const cells = splitTableRow(lines[i])
        const row: MarkdownInline[][] = []
        for (let c = 0; c < header.length; c += 1) row.push(inline(cells[c] ?? ''))
        rows.push(row)
        i += 1
      }
      if (rows.length >= MARKDOWN_LIMITS.tableRows) clipped = true
      blocks.push({ type: 'table', align, header, rows })
      continue
    }

    const list = LIST_RE.exec(line)
    if (list) {
      const ordered = /\d/.test(list[2])
      const startMatch = /^(\d{1,9})/.exec(list[2])
      const start = ordered && startMatch ? Number(startMatch[1]) : 1
      const items: MarkdownListItem[] = []
      while (i < lines.length && items.length < MARKDOWN_LIMITS.listItems) {
        const item = LIST_RE.exec(lines[i])
        if (!item) break
        const itemOrdered = /\d/.test(item[2])
        // A marker-kind switch closes the list.
        if (items.length > 0 && itemOrdered !== ordered) break
        const level = indentLevel(item[1])
        const parts = [item[3]]
        i += 1
        // Indented continuation lines join the same item.
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !LIST_RE.test(lines[i]) &&
          !FENCE_OPEN_RE.test(lines[i]) &&
          !HEADING_RE.test(lines[i]) &&
          !QUOTE_RE.test(lines[i]) &&
          /^\s{2,}/.test(lines[i])
        ) {
          parts.push(lines[i].trim())
          i += 1
        }
        items.push({ level, inlines: inline(parts.join('\n')) })
      }
      if (items.length >= MARKDOWN_LIMITS.listItems) clipped = true
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // Paragraph: run until a blank line or the start of another block.
    const paragraph: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !startsBlock(lines[i], lines[i + 1])
    ) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'paragraph', inlines: inline(paragraph.join('\n')) })
  }

  if (clipped) {
    blocks.push({ type: 'note', text: 'Message truncated for display.' })
  }
  return blocks
}