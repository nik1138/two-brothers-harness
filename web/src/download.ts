/**
 * Shared download helpers for session exports. The session row menu and the
 * `/export` base command both go through here so the Blob/object-URL flow and
 * the synthesized filename live in exactly one place.
 */

import { exportSession } from './api'
import { exportDownloadName } from './search'
import type { SessionExportFormat } from './types'

/** Menu label and blob MIME type per download format. */
export const EXPORT_FORMATS: Record<SessionExportFormat, { label: string; mime: string }> = {
  markdown: { label: 'Export as Markdown', mime: 'text/markdown; charset=utf-8' },
  json: { label: 'Export as JSON', mime: 'application/json' },
  html: { label: 'Export as HTML', mime: 'text/html; charset=utf-8' },
}

/** Save already-fetched text through a Blob + object URL download. */
export function downloadTextFile(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // let the browser start the download before the object URL is invalidated
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Fetch the backend-rendered export and save it under the synthesized
 * filename. Resolves to the filename (useful for a confirmation notice).
 */
export async function downloadSessionExport(
  name: string,
  format: SessionExportFormat = 'markdown',
): Promise<string> {
  const text = await exportSession(name, format)
  const filename = exportDownloadName(name, format)
  downloadTextFile(text, filename, EXPORT_FORMATS[format].mime)
  return filename
}
