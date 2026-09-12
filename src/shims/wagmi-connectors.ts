/**
 * Shim for the `wagmi/connectors` entry point.
 *
 * RainbowKit 2.2.x targets wagmi v2 and its wallet bundle imports the `porto`
 * and `gemini` connectors by name. wagmi v3 (`@wagmi/connectors` 8.x) no
 * longer ships them, and Turbopack refuses a module graph with missing named
 * exports, which took the whole wallet config down. `next.config.ts` aliases
 * `wagmi/connectors` here; everything real comes straight from
 * `@wagmi/connectors`, and the two retired connectors become stubs that only
 * throw if a wallet actually tries to use them (neither is offered here).
 *
 * Remove this file and the alias once RainbowKit supports wagmi v3.
 */
export * from "@wagmi/connectors";

function unavailable(name: string): never {
  throw new Error(`The ${name} connector is not available with wagmi v3.`);
}

export function porto(): never {
  return unavailable("Porto");
}

export function gemini(): never {
  return unavailable("Gemini");
}
