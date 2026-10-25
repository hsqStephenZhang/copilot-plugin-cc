export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@github/copilot-sdk") {
    return { url: new URL("./fake-copilot-fixture.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
