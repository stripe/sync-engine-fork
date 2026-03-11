# Schema Explorer Docker Harness

A standalone Docker Postgres harness for the Schema Explorer that creates isolated database instances with strict safety checks.

## Features

- **Isolated Instances**: Each run creates a fresh container with unique random identifiers
- **Random Port Allocation**: Uses ports 50000-60000, avoiding standard Postgres ports
- **Safety Checks**: Refuses to run if configuration matches shared/production instances
- **Complete Cleanup**: Stop command removes container, volume, and metadata
- **Status Monitoring**: Check if harness is running and view connection details

## Usage

### Start Container

```bash
pnpm explorer:db:start
```

Creates a new Postgres container with:
- Random container name: `schema-explorer-{8-char-suffix}`
- Random host port: Between 50000-60000
- Unique volume: `schema-explorer-vol-{8-char-suffix}`
- Connection metadata saved to: `.tmp/schema-explorer-run.json`

### Check Status

```bash
pnpm explorer:db:status
```

Displays:
- Container ID and name
- Host port
- Connection URL
- Running status
- Creation timestamp

### Stop & Cleanup

```bash
pnpm explorer:db:stop
```

Removes:
- Docker container
- Docker volume
- Metadata file

## Connection Metadata

When started, the harness writes connection details to `.tmp/schema-explorer-run.json`:

```json
{
  "databaseUrl": "postgresql://explorer:explorer_pass_xyz@localhost:54256/schema_explorer",
  "containerId": "abc123...",
  "containerName": "schema-explorer-abc123",
  "port": 54256,
  "volumeName": "schema-explorer-vol-abc123",
  "createdAt": "2026-03-11T07:30:00.000Z"
}
```

## Safety Checks

The harness **refuses to run** if:

1. **Forbidden Port**: Port is 5432 or 55432
2. **Forbidden Container Name**: Container name contains 'stripe-db'
3. **Non-localhost URL**: Database URL is not localhost/127.0.0.1
4. **URL Port Mismatch**: URL contains a forbidden port

This prevents conflicts with:
- User's existing Postgres instances
- Shared development databases (e.g., port 55432, container 'stripe-db')
- Production databases

## Implementation Details

### Container Configuration

- **Image**: `postgres:15-alpine`
- **User**: `explorer`
- **Password**: Randomly generated per instance (e.g., `explorer_pass_xyz`)
- **Database**: `schema_explorer`
- **Startup Verification**: Waits for Postgres to accept queries (max 30s)

### Files

- **Script**: `scripts/explorer-harness.ts`
- **Metadata**: `.tmp/schema-explorer-run.json` (ephemeral, git-ignored)
- **pnpm Scripts**: Defined in root `package.json`

### Pattern Source

Based on the isolation pattern in `packages/sync-engine/src/tests/testSetup.ts` with:
- Enhanced safety checks
- Persistent metadata output
- CLI commands for manual operation
- No .env file modification

## Troubleshooting

### Container Not Starting

If the container fails to start within 30 seconds:
- Check Docker is running
- Verify port is not already in use
- Check Docker has sufficient resources

### Cleanup Failed

If cleanup fails (container/volume already removed):
- The script continues with best-effort cleanup
- Manually remove: `rm .tmp/schema-explorer-run.json`

### Port Already in Use

The harness generates random ports to avoid conflicts. If you get a port conflict:
- Run `pnpm explorer:db:stop` to clean up
- Try `pnpm explorer:db:start` again (will get a new random port)

## Example Session

```bash
# Start isolated database
$ pnpm explorer:db:start
🚀 Starting Schema Explorer Postgres harness...
✅ Safety checks passed
📦 Creating Docker container 'schema-explorer-kn07zleg'...
✅ Schema Explorer Postgres is ready!
📋 Connection: postgresql://explorer:explorer_pass_bifyu1@localhost:54344/schema_explorer

# Check status
$ pnpm explorer:db:status
✅ Container is running
📋 Connection: postgresql://explorer:explorer_pass_bifyu1@localhost:54344/schema_explorer

# Use the database
# (connection URL from .tmp/schema-explorer-run.json)

# Cleanup when done
$ pnpm explorer:db:stop
🛑 Stopping Schema Explorer Postgres harness...
✅ Cleanup complete!
```

## Integration

To use the harness-managed database in your application:

```typescript
import * as fs from 'fs';
import * as path from 'path';

// Read connection metadata
const metadataPath = path.join(process.cwd(), '.tmp/schema-explorer-run.json');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

// Connect to database
const databaseUrl = metadata.databaseUrl;
const pool = new pg.Pool({ connectionString: databaseUrl });

// Use the connection
await pool.query('SELECT 1');
```

## Safety First

This harness is designed to be safe by default:
- ✅ Never touches user's existing Postgres
- ✅ Never modifies .env files
- ✅ Uses random ports to avoid conflicts
- ✅ Validates all inputs before execution
- ✅ Complete cleanup on stop

If you encounter a safety check error, **do not bypass it**. The check exists to protect your data.
