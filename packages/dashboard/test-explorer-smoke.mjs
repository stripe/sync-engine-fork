#!/usr/bin/env node

/**
 * Explorer Smoke Test
 *
 * Tests the /explorer route functionality by:
 * 1. Checking page loads
 * 2. Verifying manifest.json is accessible
 * 3. Verifying bootstrap.sql is accessible
 * 4. Checking HTML structure
 */

const BASE_URL = 'http://localhost:3001';

async function testExplorerRoute() {
  console.log('🚀 Starting Explorer Smoke Test...\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Explorer page loads
  console.log('Test 1: Check /explorer page loads...');
  try {
    const response = await fetch(`${BASE_URL}/explorer`);
    if (response.status === 200) {
      console.log('✅ PASS: Explorer page returns 200 OK');
      passed++;

      const html = await response.text();

      // Check for Next.js hydration
      if (html.includes('__NEXT_DATA__')) {
        console.log('✅ PASS: Page includes Next.js data');
        passed++;
      } else {
        console.log('❌ FAIL: Missing Next.js data');
        failed++;
      }

      // Check for loading state
      if (html.includes('Loading database') || html.includes('explorer')) {
        console.log('✅ PASS: Page contains explorer-related content');
        passed++;
      } else {
        console.log('❌ FAIL: Page missing explorer content');
        failed++;
      }
    } else {
      console.log(`❌ FAIL: Expected 200, got ${response.status}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error.message}`);
    failed++;
  }
  console.log();

  // Test 2: Manifest.json is accessible
  console.log('Test 2: Check manifest.json is accessible...');
  try {
    const response = await fetch(`${BASE_URL}/explorer-data/manifest.json`);
    if (response.status === 200) {
      const manifest = await response.json();

      console.log('✅ PASS: Manifest is accessible');
      passed++;

      // Verify manifest structure
      if (manifest.totalTables === 24) {
        console.log('✅ PASS: Manifest reports 24 tables');
        passed++;
      } else {
        console.log(`❌ FAIL: Expected 24 tables, got ${manifest.totalTables}`);
        failed++;
      }

      // Check for customers table
      if (manifest.manifest && manifest.manifest.customers === 25) {
        console.log('✅ PASS: Customers table has 25 rows in manifest');
        passed++;
      } else {
        console.log(`❌ FAIL: Customers table row count mismatch`);
        failed++;
      }

      console.log(`   Total tables: ${manifest.totalTables}`);
      console.log(`   Tables with data: ${manifest.verification.tablesWithData}`);
    } else {
      console.log(`❌ FAIL: Expected 200, got ${response.status}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error.message}`);
    failed++;
  }
  console.log();

  // Test 3: Bootstrap SQL is accessible
  console.log('Test 3: Check bootstrap.sql is accessible...');
  try {
    const response = await fetch(`${BASE_URL}/explorer-data/bootstrap.sql`);
    if (response.status === 200) {
      const sql = await response.text();

      console.log('✅ PASS: Bootstrap SQL is accessible');
      passed++;

      // Check SQL contains expected elements
      if (sql.includes('CREATE SCHEMA IF NOT EXISTS stripe')) {
        console.log('✅ PASS: SQL contains schema creation');
        passed++;
      } else {
        console.log('❌ FAIL: SQL missing schema creation');
        failed++;
      }

      if (sql.includes('CREATE TABLE IF NOT EXISTS stripe.customers')) {
        console.log('✅ PASS: SQL contains customers table creation');
        passed++;
      } else {
        console.log('❌ FAIL: SQL missing customers table');
        failed++;
      }

      // Count INSERT statements for customers
      const customerInserts = (sql.match(/INSERT INTO stripe\.customers/g) || []).length;
      if (customerInserts === 25) {
        console.log(`✅ PASS: SQL contains 25 customer INSERTs`);
        passed++;
      } else {
        console.log(`❌ FAIL: Expected 25 customer INSERTs, found ${customerInserts}`);
        failed++;
      }

      console.log(`   SQL size: ${(sql.length / 1024).toFixed(2)} KB`);
    } else {
      console.log(`❌ FAIL: Expected 200, got ${response.status}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error.message}`);
    failed++;
  }
  console.log();

  // Test 4: Check CORS/COEP headers
  console.log('Test 4: Check security headers for PGlite...');
  try {
    const response = await fetch(`${BASE_URL}/explorer`);
    const coep = response.headers.get('Cross-Origin-Embedder-Policy');
    const coop = response.headers.get('Cross-Origin-Opener-Policy');

    if (coep === 'require-corp') {
      console.log('✅ PASS: Cross-Origin-Embedder-Policy is set correctly');
      passed++;
    } else {
      console.log(`❌ FAIL: COEP header incorrect: ${coep}`);
      failed++;
    }

    if (coop === 'same-origin') {
      console.log('✅ PASS: Cross-Origin-Opener-Policy is set correctly');
      passed++;
    } else {
      console.log(`❌ FAIL: COOP header incorrect: ${coop}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error.message}`);
    failed++;
  }
  console.log();

  // Summary
  console.log('=' .repeat(60));
  console.log(`Total Tests: ${passed + failed}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('=' .repeat(60));

  if (failed === 0) {
    console.log('\n🎉 All smoke tests passed!\n');
    console.log('✨ Server-side validation complete.');
    console.log('⚠️  Note: Browser-side tests (JavaScript execution, PGlite WASM, CodeMirror)');
    console.log('   require manual verification in a browser.');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. See above for details.\n');
    process.exit(1);
  }
}

// Run the tests
testExplorerRoute().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
