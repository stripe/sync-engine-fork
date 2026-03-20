import { resolveOpenApiSpec, SpecParser } from '../../sync-engine/src/openapi'

async function main() {
  const resolved = await resolveOpenApiSpec({ apiVersion: '2026-02-24' })
  const spec = resolved.spec
  
  const parser = new SpecParser()
  const parsed = parser.parse(spec)
  
  // For each deleted_* schema, check if the corresponding live table exists
  const schemas = spec.components?.schemas ?? {}
  const deletedSchemaNames = Object.keys(schemas).filter(s => s.startsWith('deleted_'))
  
  console.log('deleted_* schemas and whether their live table exists:')
  for (const schemaName of deletedSchemaNames) {
    // deleted_customer -> customers, deleted_product -> products, deleted_coupon -> coupons
    const resourceName = schemaName.replace('deleted_', '')
    const possibleTableNames = [
      resourceName + 's',
      resourceName.replace('.', '_') + 's',
      resourceName,
    ]
    const liveTable = parsed.tables.find(t => possibleTableNames.includes(t.tableName))
    
    // Check if deleted schema has a 'deleted' property
    const deletedSchema = schemas[schemaName] as any
    const hasDeletedProp = !!(deletedSchema?.properties?.deleted || deletedSchema?.properties?.id)
    const props = Object.keys(deletedSchema?.properties ?? {}).join(', ')
    
    console.log(` - ${schemaName} -> live table: ${liveTable?.tableName ?? 'NOT FOUND'} | props: ${props}`)
  }
}
main()
