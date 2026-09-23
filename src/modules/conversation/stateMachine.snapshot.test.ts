import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FLOW_FIXTURES } from './flowFixtures.testutil.js'
import { compileFlow, presetFor } from './stateMachine.js'

// The compiled flow every kind of business runs, byte for byte. A change meant
// for one flow type that reaches another shows up here as a diff in a fixture
// nobody meant to touch — which is the only way to see it before a customer does.

describe('compiled preset flows', () => {
  for (const [name, settings] of FLOW_FIXTURES) {
    it(name, () => {
      const composition = presetFor(settings)
      expect({ composition, flow: compileFlow(composition) }).toMatchSnapshot()
    })
  }
})

const here = dirname(fileURLToPath(import.meta.url))

/** Files that belong to one flow type, and the module the other one lives in. */
const ISOLATED: ReadonlyArray<readonly [string, RegExp]> = [
  ['nodes/appointments.nodes.ts', /sales\.nodes/],
  ['nodes/sales.nodes.ts', /appointments\.nodes/],
]

describe('flow types stay apart', () => {
  // The snapshots catch a change that leaks. This catches the wiring that would
  // let one: once appointments imports from sales, editing an institute's node
  // can alter a clinic's, and nothing in the diff says so.
  for (const [file, forbidden] of ISOLATED) {
    it(`${file} does not import the other flow type`, () => {
      const source = readFileSync(resolve(here, file), 'utf8')
      const imports = source.split('\n').filter((line) => /^\s*import\b|from\s+'/.test(line))
      expect(imports.filter((line) => forbidden.test(line))).toEqual([])
    })
  }
})
