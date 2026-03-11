# Implementation Summary: Table Mode Migration Feature

## Changes Implemented

### 1. Core Implementation (`packages/sync-engine/src/database/migrate.ts`)

#### Added `tableMode` field to `MigrationConfig`
```typescript
export type MigrationConfig = {
  // ... existing fields
  /**
   * Table filtering mode for OpenAPI schema migration:
   * - 'runtime_required': Only migrate tables in RUNTIME_REQUIRED_TABLES (default)
   * - 'all_projected': Migrate all resolvable tables from the OpenAPI spec
   */
  tableMode?: 'runtime_required' | 'all_projected'
}
```

#### Modified `applyOpenApiSchema()` function
- Added logic to conditionally pass `allowedTables` based on `tableMode`
- When `tableMode` is `'runtime_required'` (or undefined): passes `allowedTables: [...RUNTIME_REQUIRED_TABLES]`
- When `tableMode` is `'all_projected'`: omits the `allowedTables` property entirely
- Updated logging to include `tableMode` in the info output

#### Both public functions accept the parameter
- `runMigrations(config: MigrationConfig)` - accepts and forwards `tableMode`
- `runMigrationsFromContent(config: MigrationConfig, migrations: EmbeddedMigration[])` - accepts and forwards `tableMode`

### 2. Documentation

#### Created `packages/sync-engine/docs/table-mode-migration.md`
- Comprehensive documentation of the feature
- Usage examples for both modes
- Implementation details and current behavior
- Important note about SpecParser's default behavior
- Migration safety guarantees

### 3. Testing

#### Created `packages/sync-engine/src/database/__tests__/migrate.tableMode.test.ts`
- Unit tests for type checking
- Validates both `'runtime_required'` and `'all_projected'` modes
- Ensures backwards compatibility (undefined defaults to runtime_required behavior)

#### Created `packages/sync-engine/scripts/test-table-modes.ts`
- Verification script to compare table counts between modes
- Documents actual runtime behavior
- Can be run with: `npx tsx scripts/test-table-modes.ts`

### 4. Test Results

All tests pass:
```
✓ src/database/__tests__/migrate.tableMode.test.ts (4 tests)
```

Test script output confirms current behavior:
```
=== runtime_required mode ===
Tables parsed: 23

=== all_projected mode ===
Tables parsed: 23

Difference: 0 tables
```

## Acceptance Criteria Met

✅ **MigrationConfig gains an optional `tableMode?: 'runtime_required' | 'all_projected'` field**
   - Implemented and exported as a public type

✅ **When tableMode is 'all_projected', applyOpenApiSchema does NOT pass allowedTables to parser.parse()**
   - Implemented: `allowedTables` property is omitted from parseOptions when mode is 'all_projected'

✅ **When tableMode is undefined or 'runtime_required', existing allowedTables: [...RUNTIME_REQUIRED_TABLES] behavior is preserved**
   - Implemented with explicit default: `const tableMode = config.tableMode ?? 'runtime_required'`
   - Backwards compatible: existing code without `tableMode` continues to work

✅ **runMigrations and runMigrationsFromContent both accept and forward the tableMode option**
   - Both functions accept `MigrationConfig` which includes the optional `tableMode` field
   - The parameter is properly forwarded through to `applyOpenApiSchema()`

✅ **No changes to specParser.ts itself — the option already supports omitting allowedTables**
   - Confirmed: No modifications made to `specParser.ts`
   - Implementation respects the interface contract

✅ **Document how many tables the 'all_projected' mode produces vs the current runtime subset**
   - Documented in `docs/table-mode-migration.md`
   - Test script created to verify actual counts
   - Current result: 23 tables in both modes (parser defaults to RUNTIME_REQUIRED_TABLES when allowedTables is omitted)

## Current Behavior & Important Notes

### Parser Default Behavior
The `SpecParser` implementation currently defaults to `RUNTIME_REQUIRED_TABLES` when `allowedTables` is undefined:

```typescript
// From specParser.ts line 44:
const allowedTables = new Set(options.allowedTables ?? RUNTIME_REQUIRED_TABLES)
```

This means:
- **Both modes currently produce 23 tables**
- The type documentation suggests omitting `allowedTables` should parse "all resolvable x-resourceId entries"
- The implementation doesn't match this expectation

### Why This Design?
Per task requirements:
- "No changes to specParser.ts itself — the option already supports omitting allowedTables"
- The implementation follows the interface contract as documented
- Future modifications to `specParser.ts` to truly parse all tables would automatically enable the 'all_projected' mode without changes to `migrate.ts`

### Migration Safety
- Default behavior unchanged (`tableMode` defaults to `'runtime_required'`)
- Existing code continues to work without modification
- The new parameter is optional and backward compatible

## Files Modified

1. **packages/sync-engine/src/database/migrate.ts**
   - Added `tableMode` field to `MigrationConfig` (exported type)
   - Modified `applyOpenApiSchema()` to handle both modes
   - Updated logging to include mode information

## Files Created

1. **packages/sync-engine/docs/table-mode-migration.md**
   - Feature documentation

2. **packages/sync-engine/src/database/__tests__/migrate.tableMode.test.ts**
   - Unit tests

3. **packages/sync-engine/scripts/test-table-modes.ts**
   - Verification script

4. **IMPLEMENTATION_SUMMARY.md** (this file)
   - Implementation summary

## Usage Examples

### Default (runtime_required)
```typescript
await runMigrations({
  databaseUrl: 'postgresql://localhost:5432/mydb',
  stripeApiVersion: '2020-08-27',
})
```

### All projected tables
```typescript
await runMigrations({
  databaseUrl: 'postgresql://localhost:5432/mydb',
  stripeApiVersion: '2020-08-27',
  tableMode: 'all_projected',
})
```

### With embedded migrations
```typescript
await runMigrationsFromContent(
  {
    databaseUrl: 'postgresql://localhost:5432/mydb',
    tableMode: 'all_projected',
  },
  migrations
)
```

## Verification

To verify the implementation:

1. **Type checking**: `npx tsc --noEmit` (passes)
2. **Unit tests**: `npx vitest run src/database/__tests__/migrate.tableMode.test.ts` (passes)
3. **Runtime behavior**: `npx tsx scripts/test-table-modes.ts` (documents actual table counts)

## Next Steps (Not Implemented)

If you need `all_projected` mode to truly parse ALL resolvable tables (beyond RUNTIME_REQUIRED_TABLES):

1. Modify `packages/sync-engine/src/openapi/specParser.ts` line 44:
   ```typescript
   // Change from:
   const allowedTables = new Set(options.allowedTables ?? RUNTIME_REQUIRED_TABLES)

   // To:
   const allowedTables = options.allowedTables ? new Set(options.allowedTables) : null
   ```

2. Update the filtering logic at lines 62-64:
   ```typescript
   if (allowedTables && !allowedTables.has(tableName)) {
     continue
   }
   ```

This was not implemented per the task requirement: "No changes to specParser.ts itself".
