/**
 * Unit tests for the session-export download client (wave 23 adds the HTML
 * format): the format table, MIME types and the synthesized download filename.
 * The Markdown/JSON behaviour is pinned byte-identically to the pre-wave-23
 * paths; HTML must never silently download as `.md`.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/sessionExport.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EXPORT_FORMATS } from '../src/download'
import { exportDownloadName } from '../src/search'
import type { SessionExportFormat } from '../src/types'

test('every export format has a label and a download MIME type', () => {
  const formats: SessionExportFormat[] = ['markdown', 'json', 'html']
  for (const format of formats) {
    const view = EXPORT_FORMATS[format]
    assert.ok(view !== undefined, format)
    assert.match(view.label, /^Export as /)
    assert.ok(view.mime.length > 0)
  }
  // Markdown/JSON stay byte-identical to the pre-wave-23 table.
  assert.deepEqual(EXPORT_FORMATS.markdown, {
    label: 'Export as Markdown',
    mime: 'text/markdown; charset=utf-8',
  })
  assert.deepEqual(EXPORT_FORMATS.json, { label: 'Export as JSON', mime: 'application/json' })
  // HTML is its own self-contained document, served as text/html.
  assert.deepEqual(EXPORT_FORMATS.html, {
    label: 'Export as HTML',
    mime: 'text/html; charset=utf-8',
  })
})

test('the download filename helper gives HTML its own extension', () => {
  assert.equal(exportDownloadName('20260101-120000.jsonl', 'markdown'), '20260101-120000.md')
  assert.equal(exportDownloadName('20260101-120000.jsonl', 'json'), '20260101-120000.json')
  assert.equal(exportDownloadName('20260101-120000.jsonl', 'html'), '20260101-120000.html')
  // sanitization is shared with the older formats (one code path)
  assert.equal(exportDownloadName('../../etc/passwd.jsonl', 'html'), 'passwd.html')
  assert.equal(exportDownloadName('a:b*c?.jsonl', 'html'), 'a-b-c-.html')
  assert.equal(exportDownloadName('', 'html'), 'session.html')
  assert.equal(exportDownloadName(null, 'html'), 'session.html')
  assert.equal(exportDownloadName('CON.jsonl', 'html'), 'session.html')
  // an unknown/legacy format still falls back to Markdown, exactly as before
  assert.equal(exportDownloadName('x.jsonl', 'pdf' as unknown as 'markdown'), 'x.md')
})
