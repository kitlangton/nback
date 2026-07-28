/**
 * Bundles the app for npm distribution. Raw TSX cannot ship: the Solid JSX
 * transform plugin refuses files inside node_modules, so installed copies
 * would fall back to the default React transform and crash.
 *
 * The bundle lands at dist/bin/index.js — two levels below the package root,
 * matching src/services/audio.ts — so the `../../audio/` lookup that resolves
 * bundled WAVs via import.meta.url works identically in dev and installed.
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: "dist/bin",
  target: "bun",
  // solid-js and @opentui/solid must be bundled: their runtime resolution
  // picks solid's server build unless the transform plugin's server.js →
  // solid.js swap runs, and that plugin only exists at build time here.
  // @opentui/core stays external for its native renderer assets.
  external: ["@opentui/core", "effect"],
  // No banner needed: Bun preserves the #!/usr/bin/env bun shebang from the
  // entrypoint source at the top of the bundle.
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const message of result.logs) console.error(message)
  process.exit(1)
}
console.log(result.outputs.map((output) => output.path).join("\n"))
