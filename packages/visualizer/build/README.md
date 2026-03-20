# Build Scripts

This directory contains build-time scripts for generating ERD visualization artifacts.

## generate-projection.ts

Generates `projection.json` artifact from OpenAPI spec for a given API version.

### Purpose

The projection artifact provides enhanced metadata for ERD visualization:
- **Namespace classification** (v1, v2, compatibility, utility)
- **Semantic tags** for columns (primary_key, foreign_key, expandable_ref, timestamp, etc.)
- **Logical types** inferred from OpenAPI schemas
- **Relationship candidates** with confidence levels
- **Deleted-variant metadata** linking live and deleted tables

This metadata enables the visualizer to reconstruct foreign key relationships and projection modes without re-parsing OpenAPI schemas client-side.

### Usage

```bash
pnpm tsx packages/visualizer/build/generate-projection.ts \
  --api-version=2025-01-27 \
  --output-dir=./packages/visualizer/public/explorer-data/2025-01-27
```

### Arguments

- `--api-version=YYYY-MM-DD` - Stripe API version to generate projection for (required)
- `--output-dir=/path/to/output` - Directory to write projection.json (required)

### Output Structure

The generated `projection.json` file has the following structure:

```json
{
  "apiVersion": "v1",
  "generatedAt": "2026-03-13T12:00:00Z",
  "capabilities": {
    "hasV2Namespace": true,
    "hasExplicitForeignKeys": false,
    "hasDeletedVariants": true,
    "timestampFormat": "raw",
    "tableCount": 107,
    "relationshipCount": 95
  },
  "tables": {
    "charges": {
      "tableName": "charges",
      "namespace": "v1",
      "familyKey": "charge",
      "isCompatibilityOnly": false,
      "isDeletedVariant": false,
      "columns": [
        {
          "name": "customer",
          "semanticTags": ["foreign_key", "expandable_ref"],
          "logicalType": "string",
          "referencesTable": "customers",
          "referencesColumn": "id",
          "resourceFamilyKey": "customer",
          "nullable": true
        }
      ]
    }
  },
  "relationships": [
    {
      "fromTable": "charges",
      "fromColumn": "customer",
      "toTable": "customers",
      "toColumn": "id",
      "confidence": "high"
    }
  ],
  "deletedVariants": [
    {
      "liveTableName": "customers",
      "deletedTableName": "customers",
      "familyKey": "customer",
      "additionalColumns": [],
      "usesSoftDelete": true,
      "softDeleteColumn": "deleted"
    }
  ]
}
```

### How It Works

1. **Fetch OpenAPI Spec**: Uses `resolveOpenApiSpec` from sync-engine to fetch the spec for the given API version (from cache or GitHub)
2. **Parse Spec**: Uses `SpecParser` to extract the GET-retrievable table superset and columns from the OpenAPI spec
3. **Classify Namespace**: Determines v1 vs v2 based on `sourceSchemaName` starting with "v2."
4. **Infer Semantic Tags**: Analyzes column names, types, and expandable references to tag columns with semantic meaning
5. **Extract Relationships**: Builds FK relationship candidates from expandable references and naming patterns
6. **Detect Deleted Variants**: Identifies tables with soft-delete columns or separate deleted-variant tables
7. **Compute Capabilities**: Calculates feature flags for the API version
8. **Write Artifact**: Outputs projection.json to the specified directory

### Namespace Detection Rules

- **v2**: `sourceSchemaName` starts with "v2."
- **v1**: Default for standard OpenAPI-derived resources
- **compatibility**: Tables from `compatibility_fallback` schema
- **utility**: System tables (migration_meta, sync_runs, webhook_events)
- **unclassified**: Ambiguous or hybrid resources

### Semantic Tag Rules

- **primary_key**: Column name is "id"
- **foreign_key**: Column name ends with "_id" or matches FK patterns (customer, account)
- **expandable_ref**: Column marked as expandable in OpenAPI spec
- **timestamp**: Column type is bigint/timestamptz or name ends with "_at" or is "created"
- **soft_delete**: Column name is "deleted" and type is boolean
- **resource_type**: Column name is "object" and type is text (discriminator)
- **metadata**: Column name is "metadata" and type is json
- **array**: Column name ends with "s" and type is json
- **object**: Column type is json (not array)

### Relationship Confidence Levels

- **high**: Expandable reference with explicit FK annotation
- **medium**: Column name ends with "_id"
- **low**: Nullable or ambiguous FK patterns

### Testing

```bash
# Generate projection for test version
pnpm tsx packages/visualizer/build/generate-projection.ts \
  --api-version=2025-01-27 \
  --output-dir=/tmp/test-projection

# Verify structure
cat /tmp/test-projection/projection.json | jq '.capabilities'
```

### Dependencies

- `@supabase/stripe-sync-engine` - SpecParser and specFetchHelper
- Node.js fs/path modules for file I/O

### Type Definitions

See `packages/visualizer/src/types/projection.ts` for full TypeScript type definitions.
