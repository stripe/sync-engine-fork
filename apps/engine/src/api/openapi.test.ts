import { describe, it, expect } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { createApp, createConnectorResolver } from '../index.js'
import { defaultConnectors } from '../lib/default-connectors.js'
import oas31Schema from './oas31-schema.json' with { type: 'json' }

const resolver = createConnectorResolver(defaultConnectors)
const app = createApp(resolver)

async function getSpec() {
  const res = await app.request('/openapi.json')
  return res.json()
}

describe('OpenAPI spec', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const spec = await getSpec()
    const ajv = new Ajv2020({ strict: false })
    const validate = ajv.compile(oas31Schema)
    const valid = validate(spec)
    expect(valid, ajv.errorsText(validate.errors)).toBe(true)
  })

  it('has typed SourceConfig and DestinationConfig', async () => {
    const spec = await getSpec()
    const schemas = spec.components.schemas
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'StripeSourceConfig',
        'PostgresDestinationConfig',
        'GoogleSheetsDestinationConfig',
        'SourceConfig',
        'DestinationConfig',
        'PipelineConfig',
      ])
    )
  })

  it('has no $schema in component schemas', async () => {
    const spec = await getSpec()
    for (const [name, schema] of Object.entries<Record<string, unknown>>(spec.components.schemas)) {
      expect(schema, `${name} should not have $schema`).not.toHaveProperty('$schema')
    }
  })
})
