/**
 * Node ESM resolve hook: the app's source uses extensionless relative imports
 * (required by the repo's tsc config). This hook lets `node --test` load those
 * .ts files for unit testing without touching the app's import style.
 */
export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[a-z]+$/.test(specifier)
  ) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      /* fall through to default resolution */
    }
  }
  return next(specifier, context);
}
