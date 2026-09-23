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
