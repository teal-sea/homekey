// Copies the NAM engine's worklet and wasm from node_modules into public/nam/,
// so they are served as same-origin static files (SPEC rule 8). Run before dev and build.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const from = path.join(root, 'node_modules/neural-amp-modeler-wasm/dist/engine')
const to = path.join(root, 'public/nam')
fs.mkdirSync(to, { recursive: true })
for (const file of ['nam-worklet.js', 'nam-engine.wasm']) fs.copyFileSync(path.join(from, file), path.join(to, file))
fs.copyFileSync(path.join(root, 'node_modules/neural-amp-modeler-wasm/LICENSE'), path.join(to, 'LICENSE'))
console.log(`copied NAM engine assets to ${path.relative(root, to)}/`)
