// The desktop child's resolve hook (#243, H1; the #230 process lane's
// idiom, verbatim in substance): retries an extensionless relative
// specifier with its `.ts` extension when the default resolver cannot
// resolve it — bundler resolution semantics for the raw-Node
// control-plane child.
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
