// The #230 process-lane resolve hook: retries an extensionless relative
// specifier with its `.ts` extension when the default resolver cannot
// resolve it — bundler resolution semantics for raw forked children.
// Absolute specifiers, packages, and already-extensioned specifiers
// pass through untouched on the first try.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
