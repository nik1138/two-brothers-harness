/**
 * Tool-card preview model: the additive bounded `preview` the backend adds to
 * `workspace_list_dir` / `workspace_read_file` / `workspace_search_text`
 * results, the runtime projection that carries it, and the ToolActivity
 * wiring that turns it into an expandable plain-text `<pre>`.
 *
 * The rendering itself is covered by the browser E2E (`tool-preview`); this
 * suite is the DOM-free contract the component consumes.
 *
 * Run with: node --import ./tests/register-ts.mjs --test tests/toolPreview.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { projectRuntimeEvents, resetRuntimeProjection } from '../src/runtime.ts'
import type { ToolActivityItem } from '../src/runtime.ts'
import { TOOL_PREVIEW_MAX_CHARS, toolPreviewOf } from '../src/toolPreview.ts'
import type { RunEvent } from '../src/types.ts'

test('toolPreviewOf reads the additive preview string', () => {
  assert.equal(toolPreviewOf({ status: 'ok', preview: 'file a.txt\ndir src' }), 'file a.txt\ndir src')
  assert.equal(toolPreviewOf({ preview: '<img src=x onerror=alert(1)>' }), '<img src=x onerror=alert(1)>')
})

test('toolPreviewOf tolerates absent, malformed and empty previews', () => {
  for (const missing of [undefined, null, [], 'preview', 42, {}, { preview: 42 }, { preview: null }]) {
    assert.equal(toolPreviewOf(missing), null, JSON.stringify(missing))
  }
  assert.equal(toolPreviewOf({ preview: '' }), null)
  assert.equal(toolPreviewOf({ preview: '  \n\t ' }), null)
})

test('toolPreviewOf keeps a hostile oversized preview bounded', () => {
  const bounded = toolPreviewOf({ preview: 'x'.repeat(TOOL_PREVIEW_MAX_CHARS * 3) })
  assert.ok(bounded !== null)
  assert.equal(bounded.length, TOOL_PREVIEW_MAX_CHARS)
  assert.ok(bounded.endsWith('…'))
})

test('a workspace_list_dir tool_completed event carries its preview through the projection', () => {
  resetRuntimeProjection([])
  const events = [
    {
      type: 'tool_started',
      tool: 'workspace_list_dir',
      args: { path: '.' },
      actor: 'junior',
      run_id: 'run-1',
      at: 10,
    },
    {
      type: 'tool_completed',
      tool: 'workspace_list_dir',
      status: 'ok',
      result: { status: 'ok', path: '.', preview: 'file a.txt\ndir src' },
      actor: 'junior',
      run_id: 'run-1',
      at: 11,
    },
  ] as unknown as RunEvent[]
  const items = projectRuntimeEvents(events)
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item?.type, 'tool')
  if (item?.type !== 'tool') return
  const tool = item as ToolActivityItem
  assert.equal(tool.tool, 'workspace_list_dir')
  assert.equal(toolPreviewOf(tool.result), 'file a.txt\ndir src')
})

test('ToolActivity renders the preview as interpolated text in an expandable card', () => {
  // ToolActivity has no DOM harness; pin the wiring the E2E then exercises.
  const source = readFileSync(
    fileURLToPath(new URL('../src/components/ToolActivity.vue', import.meta.url)),
    'utf8',
  )
  assert.match(source, /import \{ toolPreviewOf \} from '\.\.\/toolPreview'/)
  assert.match(source, /const preview = computed<string \| null>\(\(\) => toolPreviewOf\(view\.result\)\)/)
  assert.match(source, /preview\.value !== null/, 'a preview makes the card expandable')
  assert.match(
    source,
    /<pre v-if="preview" class="tool-text tool-preview">\{\{ preview \}\}<\/pre>/,
    'the preview is plain interpolated text in a <pre>',
  )
  assert.ok(!source.includes('v-html'), 'no raw HTML path may exist in the tool card')
})
