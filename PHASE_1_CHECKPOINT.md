# Phase 1 Checkpoint: all_projected Mode Implementation

## Status: ⚠️ REQUIRES DECISION

## Implementation Complete
The `all_projected` table mode has been successfully implemented in `packages/sync-engine/src/database/migrate.ts`:

- ✅ `MigrationConfig` accepts `tableMode?: 'runtime_required' | 'all_projected'`
- ✅ When `'all_projected'`, `allowedTables` is NOT passed to `parser.parse()`
- ✅ Both `runMigrations()` and `runMigrationsFromContent()` support the parameter
- ✅ Backward compatible (defaults to `'runtime_required'`)
- ✅ All tests pass

## Critical Finding

**The 'all_projected' mode currently produces ZERO additional tables.**

### Measured Results
```
Runtime required mode: 23 tables
All projected mode:    23 tables
Delta:                 0 tables
```

### Root Cause
The `SpecParser` implementation defaults to `RUNTIME_REQUIRED_TABLES` when `allowedTables` is omitted:

```typescript
// From specParser.ts line 44:
const allowedTables = new Set(options.allowedTables ?? RUNTIME_REQUIRED_TABLES)
```

This means:
1. **Migration filtering is NOT the bottleneck** - The parser itself limits the scope
2. **Parser scope IS the bottleneck** - We're not filtering tables after parsing; we're not parsing them at all

### Implication for Phase 2
The original assumption was:
> "The OpenAPI spec contains many more tables than RUNTIME_REQUIRED_TABLES, and the current migration code filters them out"

**This assumption is INCORRECT.** The parser never sees tables outside RUNTIME_REQUIRED_TABLES.

## Decision Required

Per the task directive:
> "Execute Phase 1 checkpoint in subtask_2: After adding all_projected mode, count parsed tables vs migrated tables and document finding - **if delta <20 tables, get explicit user decision on parser scope vs shipping current projectable set before Phase 2**"

### Option 1: Expand Parser Scope (Enables Full Projection)
**Change `specParser.ts` to truly parse all resolvable tables:**

```typescript
// Line 44: Remove default
const allowedTables = options.allowedTables ? new Set(options.allowedTables) : null

// Lines 62-64: Make filtering conditional
if (allowedTables && !allowedTables.has(tableName)) {
  continue
}
```

**Pros:**
- Unlocks potentially 50-100+ tables for schema exploration
- Matches type documentation intent
- Enables the original vision for the explorer

**Cons:**
- Contradicts task requirement "No changes to specParser.ts"
- Unknown number of projectable tables (could be very large)
- May expose incomplete/untested OpenAPI schemas

**Risk:** Medium - Parser change is straightforward, but downstream impact unknown

### Option 2: Ship Explorer Against Current 23-Table Set
**Accept the current scope and build explorer with existing tables:**

**Pros:**
- Stays within task constraints ("No changes to specParser.ts")
- 23 tables covers core Stripe objects (customers, subscriptions, invoices, charges, etc.)
- Guaranteed stable schema (these tables are runtime-tested)
- Faster delivery (no parser modification required)

**Cons:**
- Limited exploration surface
- Misses potentially valuable lesser-known resources
- Original vision significantly reduced

**Risk:** Low - Known, stable schema

### Option 3: Hybrid Approach
**Manually expand RUNTIME_REQUIRED_TABLES to include high-value exploration targets:**

Add to `resourceRegistry.ts`:
```typescript
export const EXPLORATION_TABLES = [
  ...RUNTIME_REQUIRED_TABLES,
  'applications',
  'application_fees',
  'balance_transactions',
  'events',
  'files',
  'payouts',
  'tokens',
  'transfers',
  // ... carefully selected additional tables
]
```

Then use in 'all_projected' mode:
```typescript
if (tableMode === 'all_projected') {
  parseOptions.allowedTables = [...EXPLORATION_TABLES]
} else {
  parseOptions.allowedTables = [...RUNTIME_REQUIRED_TABLES]
}
```

**Pros:**
- No parser changes required
- Controlled expansion of schema surface
- Can incrementally add tables based on testing
- Stays within task constraints

**Cons:**
- Still not "all" projectable tables
- Requires manual curation
- Partial solution to original vision

**Risk:** Low-Medium - Controlled expansion, but requires testing additional schemas

## Recommendation

**Option 3 (Hybrid)** is recommended as the pragmatic path forward:

1. **Immediate:** Use current 23-table set for Phase 2 initial delivery
2. **Incremental:** Add 5-10 high-value tables to EXPLORATION_TABLES
3. **Future:** Consider parser expansion if explorer proves valuable

This balances:
- ✅ Task constraint compliance (no parser changes)
- ✅ Delivery velocity (start with known-good tables)
- ✅ Expansion path (can grow exploration surface)
- ✅ Risk management (controlled schema additions)

## User Decision Required

**Before proceeding to Phase 2, please choose:**

1. **Option 1**: Modify parser to enable true "all tables" projection
2. **Option 2**: Ship explorer with current 23-table set
3. **Option 3**: Manually curate expanded table set (recommended)

**Please respond with your choice, or provide alternative direction.**

## Current Implementation Status

The `tableMode` parameter is fully implemented and ready for any of the three options:

- **Option 1**: Would just require parser modification
- **Option 2**: Works as-is (use `tableMode: 'all_projected'` or `'runtime_required'`)
- **Option 3**: Would define EXPLORATION_TABLES and use in 'all_projected' mode

All three paths are supported by the current implementation architecture.

---

**Phase 1 checkpoint reached. Awaiting user decision to proceed to Phase 2.**
