// Pure path helpers for the workspace finder breadcrumbs: display crumbs for
// one absolute path of either platform, plus separator selection for the
// editable path draft. Extracted from WorkspaceFinder.vue — keep behavior
// byte-identical; this is not a general path library.

export interface Crumb {
  label: string
  path: string
}

export function separatorFor(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** Display breadcrumbs for one absolute path of either platform. */
export function pathCrumbs(path: string): Crumb[] {
  if (!path) return []
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)
  if (drive) {
    const root = `${drive[1]}\\`
    const out: Crumb[] = [{ label: root, path: root }]
    let acc = root
    for (const part of path.slice(drive[0].length).split(/[\\/]+/).filter(Boolean)) {
      acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  if (path.startsWith('\\\\')) {
    const parts = path.replace(/^\\\\/, '').split(/[\\/]+/).filter(Boolean)
    if (!parts.length) return [{ label: path, path }]
    const root = `\\\\${parts[0]}\\${parts[1] ?? ''}`
    const out: Crumb[] = [{ label: root, path: root }]
    let acc = root
    for (const part of parts.slice(2)) {
      acc = `${acc}\\${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  if (path.startsWith('/')) {
    if (path === '/') return [{ label: '/', path: '/' }]
    const out: Crumb[] = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of path.split('/').filter(Boolean)) {
      acc = `${acc}/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }
  return [{ label: path, path }]
}
