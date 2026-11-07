// Focused tests for src/search.ts — the pure helpers behind the palette's
// session content search and the sidebar's export download filenames. No DOM,
// no fetch; run directly (matches the other suites):
//   node --import ./tests/register-ts.mjs --test tests/search.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_CONTENT_HITS_PER_SESSION,
  MAX_CONTENT_ITEMS,
  MAX_SEARCH_LIMIT,
  MIN_CONTENT_QUERY,
  PALETTE_CONTENT_PREFIX,
  SEARCH_DEBOUNCE_MS,
  clampSearchLimit,
  contentItemSession,
  contentItemsFromResult,
  exportDownloadName,
  normalizeSearchQuery,
  sessionFileNameFromHit,
  shouldSearchContent,
  truncateText,
} from '../src/search.ts'
import type { PaletteItem } from '../src/palette.ts'
import type { SearchHit, SearchResult } from '../src/types.ts'
import { ApiError, exportSession, searchSessions } from '../src/api.ts'

/** Complete hit with overridable fields (backend shape from the task contract). */
function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    session: '20260101-120000.jsonl',
    title: 'Fix login',
    field: 'message',
    seq: 3,
    role: 'senior',
    kind: 'message',
    snippet: 'we should fix the login flow first',
    ts: '2026-01-01T12:00:03Z',
    ...overrides,
  }
}

function result(hits: SearchHit[], overrides: Partial<SearchResult> = {}): SearchResult {
  return { query: 'login', scanned_sessions: 1, truncated: false, hits, ...overrides }
}

const ids = (items: PaletteItem[]): string[] => items.map((item) => item.id)

test('constants: the palette/backend contract values stay pinned', () => {
  assert.equal(MIN_CONTENT_QUERY, 2)
  assert.equal(SEARCH_DEBOUNCE_MS, 180)
  assert.ok(DEFAULT_SEARCH_LIMIT > 0)
  assert.ok(DEFAULT_SEARCH_LIMIT <= MAX_SEARCH_LIMIT)
  assert.ok(MAX_SEARCH_LIMIT >= 1)
  assert.ok(MAX_CONTENT_HITS_PER_SESSION >= 2 && MAX_CONTENT_HITS_PER_SESSION <= 3)
  assert.ok(MAX_CONTENT_ITEMS >= MAX_CONTENT_HITS_PER_SESSION)
  assert.equal(PALETTE_CONTENT_PREFIX, 'content:')
})

test('normalizeSearchQuery trims, collapses whitespace and tolerates non-strings', () => {
  assert.equal(normalizeSearchQuery('  redis   migration  '), 'redis migration')
  assert.equal(normalizeSearchQuery('\n\tfix\nlogin\t'), 'fix login')
  assert.equal(normalizeSearchQuery(''), '')
  assert.equal(normalizeSearchQuery('   '), '')
  assert.equal(normalizeSearchQuery(null), '')
  assert.equal(normalizeSearchQuery(undefined), '')
  assert.equal(normalizeSearchQuery(42), '')
  assert.equal(normalizeSearchQuery({ q: 'x' }), '')
  // bounded: very long input is truncated with the shared ellipsis marker
  const long = normalizeSearchQuery('a'.repeat(500))
  assert.ok(long.length <= 200)
  assert.ok(long.endsWith('…'))
})

test('shouldSearchContent gates on the 2-char minimum after normalization', () => {
  for (const tooShort of ['', ' ', ' a ', 'x', '\n', null, undefined, 7]) {
    assert.equal(shouldSearchContent(tooShort), false, `expected gate for ${JSON.stringify(tooShort)}`)
  }
  for (const searchable of ['ab', ' a b ', 'redis migration', ' 12 ']) {
    assert.equal(shouldSearchContent(searchable), true, `expected search for ${JSON.stringify(searchable)}`)
  }
})

test('clampSearchLimit floors, bounds and falls back safely', () => {
  assert.equal(clampSearchLimit(undefined), DEFAULT_SEARCH_LIMIT)
  assert.equal(clampSearchLimit(Number.NaN), DEFAULT_SEARCH_LIMIT)
  assert.equal(clampSearchLimit(Number.POSITIVE_INFINITY), DEFAULT_SEARCH_LIMIT)
  assert.equal(clampSearchLimit(7.9), 7)
  assert.equal(clampSearchLimit(0), 1)
  assert.equal(clampSearchLimit(-3), 1)
  assert.equal(clampSearchLimit(MAX_SEARCH_LIMIT + 1000), MAX_SEARCH_LIMIT)
})

test('contentItemsFromResult maps a hit to a palette item for the Messages group', () => {
  const items = contentItemsFromResult(result([hit()]))
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.kind, 'content')
  assert.equal(item.id, `${PALETTE_CONTENT_PREFIX}20260101-120000.jsonl:3`)
  assert.equal(item.label, 'Fix login — we should fix the login flow first')
  assert.equal(item.hint, 'Senior · message')
  assert.equal(item.session, '20260101-120000.jsonl')
})

test('title hits: no snippet duplication, "Session title" hint, title id suffix', () => {
  const items = contentItemsFromResult(
    result([hit({ field: 'title', seq: null, role: null, kind: null, snippet: 'Fix login' })]),
  )
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.id, `${PALETTE_CONTENT_PREFIX}20260101-120000.jsonl:title`)
  assert.equal(item.label, 'Fix login')
  assert.equal(item.hint, 'Session title')
})

test('hints name the role and kind; unknown/absent metadata falls back honestly', () => {
  const [operatorMessage] = contentItemsFromResult(
    result([hit({ role: 'user', kind: 'message', seq: 1 })]),
  )
  assert.equal(operatorMessage?.hint, 'You · message')

  const [operatorRoleMessage] = contentItemsFromResult(
    result([hit({ role: 'operator', kind: 'message', seq: 2 })]),
  )
  assert.equal(operatorRoleMessage?.hint, 'You · message')

  const [decision] = contentItemsFromResult(
    result([hit({ field: 'decision', role: 'junior', kind: 'decision', seq: 8 })]),
  )
  assert.equal(decision?.hint, 'Junior · decision')

  const [bare] = contentItemsFromResult(result([hit({ role: null, kind: null, seq: 9 })]))
  assert.equal(bare?.hint, 'Message')

  const [bareDecision] = contentItemsFromResult(
    result([hit({ field: 'decision', role: null, kind: null, seq: 10 })]),
  )
  assert.equal(bareDecision?.hint, 'Decision')

  // an unrecognized runtime field never throws and reads like a message
  const [odd] = contentItemsFromResult(
    result([hit({ field: 'other' as unknown as SearchHit['field'], role: null, kind: null })]),
  )
  assert.equal(odd?.hint, 'Message')
})

test('ordering follows backend relevance order across sessions', () => {
  const items = contentItemsFromResult(
    result([
      hit({ session: 'b.jsonl', seq: 2, snippet: 'second' }),
      hit({ session: 'a.jsonl', seq: 5, snippet: 'first' }),
      hit({ session: 'b.jsonl', seq: 1, snippet: 'third' }),
      hit({ session: 'c.jsonl', seq: 0, snippet: 'fourth' }),
    ]),
  )
  assert.deepEqual(ids(items), [
    `${PALETTE_CONTENT_PREFIX}b.jsonl:2`,
    `${PALETTE_CONTENT_PREFIX}a.jsonl:5`,
    `${PALETTE_CONTENT_PREFIX}b.jsonl:1`,
    `${PALETTE_CONTENT_PREFIX}c.jsonl:0`,
  ])
  assert.deepEqual(
    items.map((item) => item.label),
    ['Fix login — second', 'Fix login — first', 'Fix login — third', 'Fix login — fourth'],
  )
})

test('per-session cap drops extra hits but keeps other sessions', () => {
  const hits = Array.from({ length: 5 }, (_, seq) =>
    hit({ session: 'busy.jsonl', seq, snippet: `hit ${seq}` }),
  )
  hits.push(hit({ session: 'other.jsonl', seq: 42, snippet: 'other session' }))

  const items = contentItemsFromResult(result(hits))
  assert.equal(
    items.filter((item) => item.session === 'busy.jsonl').length,
    MAX_CONTENT_HITS_PER_SESSION,
  )
  assert.ok(items.some((item) => item.session === 'other.jsonl'))

  // an explicit per-session budget is honored (used for focused views/tests)
  const oneEach = contentItemsFromResult(result(hits), { maxPerSession: 1 })
  assert.equal(oneEach.filter((item) => item.session === 'busy.jsonl').length, 1)
})

test('dedupe: repeated seq / repeated title hits collapse to one item', () => {
  const items = contentItemsFromResult(
    result([
      hit({ seq: 3 }),
      hit({ seq: 3, snippet: 'same envelope, different snippet order' }),
      hit({ field: 'title', seq: null, role: null, kind: null }),
      hit({ field: 'title', seq: null, role: null, kind: null }),
    ]),
  )
  assert.deepEqual(ids(items), [
    `${PALETTE_CONTENT_PREFIX}20260101-120000.jsonl:3`,
    `${PALETTE_CONTENT_PREFIX}20260101-120000.jsonl:title`,
  ])
})

test('overall cap bounds the group; explicit limits are honored', () => {
  const hits = Array.from({ length: 30 }, (_, index) =>
    hit({ session: `s${index}.jsonl`, seq: index, snippet: `hit ${index}` }),
  )
  assert.equal(contentItemsFromResult(result(hits)).length, MAX_CONTENT_ITEMS)
  assert.equal(contentItemsFromResult(result(hits), { limit: 3 }).length, 3)
  assert.equal(contentItemsFromResult(result(hits), { limit: 0 }).length, 0)
})

test('labels are truncated with an ellipsis and keep both bounds in budget', () => {
  const title = 't'.repeat(300)
  const snippet = 's'.repeat(300)
  const [item] = contentItemsFromResult(result([hit({ title, snippet })]))
  assert.ok(item)
  const [titlePart, snippetPart] = item.label.split(' — ')
  assert.ok(titlePart!.length <= 60 + 1, 'title part is bounded')
  assert.ok(titlePart!.endsWith('…'))
  assert.ok(snippetPart!.length <= 80 + 1, 'snippet part is bounded')
  assert.ok(snippetPart!.endsWith('…'))
})

test('empty/duplicate snippets and blank titles degrade cleanly', () => {
  // empty snippet: just the title, never a dangling separator
  const [emptySnippet] = contentItemsFromResult(result([hit({ snippet: '   ' })]))
  assert.equal(emptySnippet?.label, 'Fix login')

  // snippet identical to the title is not repeated
  const [same] = contentItemsFromResult(result([hit({ snippet: 'FIX LOGIN' })]))
  assert.equal(same?.label, 'Fix login')

  // blank title falls back to the derived session title, not an empty label
  const [blankTitle] = contentItemsFromResult(
    result([hit({ title: '   ', session: '20260101-120000.jsonl', snippet: 'body' })]),
  )
  assert.equal(blankTitle?.label, '20260101 120000 — body')
})

test('single-line labels collapse control characters and newlines', () => {
  const [item] = contentItemsFromResult(
    result([hit({ snippet: 'first line\nsecond\tline\u0000end' })]),
  )
  assert.equal(item?.label, 'Fix login — first line second line end')
  assert.equal(item?.label.includes('\n'), false)
})

test('empty/malformed results are safe (no throw, no items)', () => {
  assert.deepEqual(contentItemsFromResult(null), [])
  assert.deepEqual(contentItemsFromResult(undefined), [])
  assert.deepEqual(contentItemsFromResult({} as SearchResult), [])
  assert.deepEqual(contentItemsFromResult({ hits: null } as unknown as SearchResult), [])
  assert.deepEqual(
    contentItemsFromResult({
      ...result([]),
      hits: [
        null,
        7,
        'nope',
        { title: 'no session', snippet: 'x' },
        { session: '', title: 'blank session', seq: 1 },
        { session: '   ', title: 'spaces session', seq: 1 },
      ] as unknown as SearchHit[],
    }),
    [],
  )
})

test('session names from hits are basenames only (no path traversal)', () => {
  const [item] = contentItemsFromResult(
    result([hit({ session: '../../secrets/token.jsonl', seq: 4 })]),
  )
  assert.equal(item?.session, 'token.jsonl')
  assert.equal(item?.id, `${PALETTE_CONTENT_PREFIX}token.jsonl:4`)

  assert.equal(sessionFileNameFromHit('C:\\sessions\\20260101-120000.jsonl'), '20260101-120000.jsonl')
  assert.equal(sessionFileNameFromHit('/var/sessions/a.jsonl'), 'a.jsonl')
  assert.equal(sessionFileNameFromHit('a.jsonl'), 'a.jsonl')
  assert.equal(sessionFileNameFromHit('.'), '')
  assert.equal(sessionFileNameFromHit('..'), '')
  assert.equal(sessionFileNameFromHit('  '), '')
  assert.equal(sessionFileNameFromHit(null), '')
  assert.equal(sessionFileNameFromHit(12), '')
})

test('contentItemSession extracts the target session, null for other kinds', () => {
  const [item] = contentItemsFromResult(result([hit({ seq: 11 })]))
  assert.equal(contentItemSession(item), '20260101-120000.jsonl')

  // fallback: id parsing when the explicit field is missing (older callers/tests)
  const fromId: PaletteItem = {
    id: `${PALETTE_CONTENT_PREFIX}legacy.jsonl:7`,
    kind: 'content',
    label: 'Legacy',
  }
  assert.equal(contentItemSession(fromId), 'legacy.jsonl')

  const titleFromId: PaletteItem = {
    id: `${PALETTE_CONTENT_PREFIX}legacy.jsonl:title`,
    kind: 'content',
    label: 'Legacy',
  }
  assert.equal(contentItemSession(titleFromId), 'legacy.jsonl')

  assert.equal(contentItemSession(null), null)
  assert.equal(contentItemSession(undefined), null)
  assert.equal(contentItemSession({ id: 'session:a.jsonl', kind: 'session', label: 'A' }), null)
  assert.equal(contentItemSession({ id: 'content:', kind: 'content', label: 'empty' }), null)
})

test('exportDownloadName synthesizes safe markdown/json filenames', () => {
  assert.equal(exportDownloadName('20260101-120000.jsonl', 'markdown'), '20260101-120000.md')
  assert.equal(exportDownloadName('20260101-120000.jsonl', 'json'), '20260101-120000.json')
  assert.equal(exportDownloadName('fix-login', 'markdown'), 'fix-login.md')
  assert.equal(exportDownloadName('  spaced name.jsonl  ', 'json'), 'spaced name.json')
  // path parts and illegal characters never reach the download attribute
  assert.equal(exportDownloadName('../../etc/passwd.jsonl', 'markdown'), 'passwd.md')
  assert.equal(exportDownloadName('a:b*c?.jsonl', 'markdown'), 'a-b-c-.md')
  // empty/reserved/degenerate input falls back to a stable name
  assert.equal(exportDownloadName('', 'markdown'), 'session.md')
  assert.equal(exportDownloadName(null, 'json'), 'session.json')
  assert.equal(exportDownloadName('..', 'markdown'), 'session.md')
  assert.equal(exportDownloadName('CON.jsonl', 'markdown'), 'session.md')
  // an unexpected format degrades to markdown rather than throwing
  assert.equal(exportDownloadName('x.jsonl', 'pdf' as unknown as 'markdown'), 'x.md')
})

test('truncateText is code-point safe with a single ellipsis', () => {
  assert.equal(truncateText('short', 10), 'short')
  assert.equal(truncateText('exactly', 7), 'exactly')
  assert.equal(truncateText('abcdefgh', 5), 'abcd…')
  assert.equal(truncateText('abc', 1), '…')
  assert.equal(truncateText('abc', 0), '')
  assert.equal(truncateText('', 5), '')
  assert.equal(truncateText('🚀🚀🚀', 2), '🚀…', 'surrogate pairs stay intact')
})

// -- api.ts contract wiring (mock fetch; still fully offline) ------------------
// These pin the exact wire URLs the backend lane implements: a mismatch here
// would only surface as an empty palette group / failed download at runtime.

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

function fakeResponse(status: number, body: unknown, raw?: string): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => raw ?? JSON.stringify(body),
  }
}

/** Run `run` with a stubbed global fetch, restoring the real one afterwards. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<FakeResponse>,
  run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init })
    return impl(url, init)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('searchSessions: encoded /api/search URL, default limit, typed result', async () => {
  const payload: SearchResult = {
    query: 'redis migration',
    scanned_sessions: 3,
    truncated: false,
    hits: [hit({ seq: 2 })],
  }
  await withFetch(
    async () => fakeResponse(200, payload),
    async (calls) => {
      const result = await searchSessions('redis migration')
      assert.deepEqual(result, payload)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.url, `/api/search?q=redis%20migration&limit=${DEFAULT_SEARCH_LIMIT}`)
    },
  )
})

test('searchSessions: requested limits are clamped to the client maximum', async () => {
  await withFetch(
    async () => fakeResponse(200, result([])),
    async (calls) => {
      await searchSessions('ab', 5)
      await searchSessions('ab', 10_000)
      assert.equal(calls[0]?.url, '/api/search?q=ab&limit=5')
      assert.equal(calls[1]?.url, `/api/search?q=ab&limit=${MAX_SEARCH_LIMIT}`)
    },
  )
})

test('exportSession: raw text body and per-format export URL', async () => {
  await withFetch(
    async (url) =>
      fakeResponse(200, null, url.includes('format=json') ? '{"envelopes":[]}' : '# Fix login\n'),
    async (calls) => {
      const markdown = await exportSession('20260101-120000.jsonl', 'markdown')
      const json = await exportSession('20260101-120000.jsonl', 'json')
      assert.equal(markdown, '# Fix login\n')
      assert.equal(json, '{"envelopes":[]}')
      assert.equal(
        calls[0]?.url,
        '/api/sessions/20260101-120000.jsonl/export?format=markdown',
      )
      assert.equal(calls[1]?.url, '/api/sessions/20260101-120000.jsonl/export?format=json')
    },
  )
})

test('export/search failures surface as ApiError with status and detail', async () => {
  // endpoint missing (older backend): 404 with a JSON detail
  await withFetch(
    async () => fakeResponse(404, { detail: 'not found' }),
    async () => {
      await assert.rejects(
        () => exportSession('gone.jsonl', 'markdown'),
        (error: unknown) =>
          error instanceof ApiError && error.status === 404 && error.message === 'not found',
      )
    },
  )

  // transport failure: status 0 keeps the "backend unreachable" contract
  await withFetch(
    () => Promise.reject(new Error('offline')),
    async () => {
      await assert.rejects(
        () => searchSessions('redis'),
        (error: unknown) => error instanceof ApiError && error.status === 0,
      )
    },
  )
})
