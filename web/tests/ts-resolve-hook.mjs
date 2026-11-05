// Resolve hook: allow extensionless relative imports of TypeScript sources
// (runtime.ts imports './chat') under plain-node type stripping.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (e) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + '.ts', context)
    }
    throw e
  }
}
