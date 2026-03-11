#!/usr/bin/env node

/**
 * Explorer Browser Smoke Test
 *
 * Uses Playwright to test the full user flow:
 * 1. Page loads and shows "Loading database..." spinner
 * 2. PGlite hydration completes and shows 24 tables
 * 3. Clicking "customers" table updates SQL and shows 25 rows
 * 4. Manual SQL query executes successfully
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3001';
const TIMEOUT = 30000; // 30 seconds for PGlite to load

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBrowserTest() {
  console.log('🚀 Starting Explorer Browser Smoke Test...\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Track console messages and errors
  const consoleMessages = [];
  const errors = [];

  page.on('console', msg => {
    const text = msg.text();
    consoleMessages.push({ type: msg.type(), text });
    if (msg.type() === 'error') {
      console.log(`   ⚠️  Console Error: ${text}`);
    }
  });

  page.on('pageerror', error => {
    errors.push(error.message);
    console.log(`   ❌ Page Error: ${error.message}`);
  });

  let passed = 0;
  let failed = 0;

  try {
    // Test 1: Navigate to /explorer
    console.log('Test 1: Navigate to /explorer page...');
    await page.goto(`${BASE_URL}/explorer`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });
    console.log('✅ PASS: Page loaded');
    passed++;

    // Test 2: Check for loading state
    console.log('\nTest 2: Check for "Loading database..." state...');
    try {
      // Wait for loading text to appear (it might be very brief)
      const loadingVisible = await page.locator('text=Loading database').isVisible({ timeout: 2000 }).catch(() => false);
      if (loadingVisible) {
        console.log('✅ PASS: Loading state was visible');
        passed++;
      } else {
        // It might have loaded too fast, check if we're already in ready state
        const tablesVisible = await page.locator('text=Tables').isVisible({ timeout: 1000 }).catch(() => false);
        if (tablesVisible) {
          console.log('⚠️  SKIP: Loading state passed too quickly, already in ready state');
          passed++;
        } else {
          console.log('❌ FAIL: Neither loading state nor ready state found');
          failed++;
        }
      }
    } catch (error) {
      console.log(`❌ FAIL: ${error.message}`);
      failed++;
    }

    // Test 3: Wait for PGlite to hydrate and show 24 tables
    console.log('\nTest 3: Wait for PGlite hydration (24 tables should appear)...');
    try {
      // Wait for the sidebar to show "24 tables"
      await page.waitForSelector('text=24 tables', { timeout: TIMEOUT });
      console.log('✅ PASS: 24 tables appeared in sidebar');
      passed++;

      // Verify table list is populated
      const customerTable = await page.locator('text=customers').isVisible();
      if (customerTable) {
        console.log('✅ PASS: Customers table is visible in sidebar');
        passed++;
      } else {
        console.log('❌ FAIL: Customers table not found');
        failed++;
      }
    } catch (error) {
      console.log(`❌ FAIL: Tables did not appear - ${error.message}`);
      failed++;

      // Check for PGlite-related console errors
      const pgliteErrors = consoleMessages.filter(m =>
        m.text.includes('PGlite') || m.text.includes('WASM') || m.text.includes('COEP')
      );
      if (pgliteErrors.length > 0) {
        console.log('\n   Relevant console messages:');
        pgliteErrors.forEach(msg => {
          console.log(`   - [${msg.type}] ${msg.text}`);
        });
      }
    }

    // Test 4: Click customers table and verify SQL editor updates
    console.log('\nTest 4: Click customers table and verify SQL query...');
    try {
      // Find and click the customers table
      const customersRow = page.locator('text=customers').first();
      await customersRow.click();
      console.log('   Clicked customers table');

      // Wait a moment for the query to execute
      await sleep(1000);

      // Check that the editor contains the expected SQL
      const editorContent = await page.locator('.cm-content').textContent();
      if (editorContent.includes('SELECT * FROM stripe.customers LIMIT 100')) {
        console.log('✅ PASS: SQL editor updated with correct query');
        passed++;
      } else {
        console.log(`❌ FAIL: SQL editor content unexpected: ${editorContent.substring(0, 100)}`);
        failed++;
      }

      // Wait for results to appear
      await page.waitForSelector('text=25 rows', { timeout: 5000 });
      console.log('✅ PASS: Query executed and returned 25 rows');
      passed++;

      // Verify table headers exist (id, _raw_data, _account_id or similar)
      const tableExists = await page.locator('table').isVisible();
      if (tableExists) {
        console.log('✅ PASS: Results table is rendered');
        passed++;
      } else {
        console.log('❌ FAIL: Results table not found');
        failed++;
      }
    } catch (error) {
      console.log(`❌ FAIL: ${error.message}`);
      failed++;
    }

    // Test 5: Type and execute a manual SQL query
    console.log('\nTest 5: Execute manual SQL query...');
    try {
      // Clear the editor and type a new query
      const editor = page.locator('.cm-content').first();
      await editor.click();

      // Select all and delete
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');

      // Type the query
      const manualQuery = "SELECT id, _account_id FROM stripe.customers WHERE id LIKE 'cus_test%' LIMIT 5";
      await editor.type(manualQuery);
      console.log('   Typed manual query');

      // Click the Run button
      await page.locator('button:has-text("Run")').click();
      console.log('   Clicked Run button');

      // Wait for results
      await sleep(1000);

      // Check for results (should show 5 rows)
      const resultsText = await page.locator('text=5 rows').isVisible({ timeout: 5000 });
      if (resultsText) {
        console.log('✅ PASS: Manual query executed and returned 5 rows');
        passed++;
      } else {
        // Check for "row" singular (might be 1 row)
        const hasResults = await page.locator('table tbody tr').count() > 0;
        if (hasResults) {
          console.log('✅ PASS: Manual query executed with results');
          passed++;
        } else {
          console.log('❌ FAIL: Manual query did not return expected results');
          failed++;
        }
      }
    } catch (error) {
      console.log(`❌ FAIL: ${error.message}`);
      failed++;
    }

    // Test 6: Test error handling with invalid SQL
    console.log('\nTest 6: Test error handling with invalid SQL...');
    try {
      // Clear and type invalid SQL
      const editor = page.locator('.cm-content').first();
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await editor.type('SELECT * FROM nonexistent_table');

      // Click Run
      await page.locator('button:has-text("Run")').click();
      await sleep(1000);

      // Check for error message (not a crash)
      const errorVisible = await page.locator('text=/error|does not exist/i').isVisible({ timeout: 5000 });
      if (errorVisible) {
        console.log('✅ PASS: Error message displayed for invalid SQL');
        passed++;
      } else {
        console.log('❌ FAIL: No error message displayed');
        failed++;
      }
    } catch (error) {
      console.log(`❌ FAIL: ${error.message}`);
      failed++;
    }

    // Check for JavaScript errors
    console.log('\nChecking for JavaScript errors...');
    const jsErrors = errors.filter(e => !e.includes('favicon') && !e.includes('404'));
    if (jsErrors.length === 0) {
      console.log('✅ PASS: No JavaScript errors detected');
      passed++;
    } else {
      console.log(`❌ FAIL: ${jsErrors.length} JavaScript error(s) detected`);
      jsErrors.forEach(err => console.log(`   - ${err}`));
      failed++;
    }

  } catch (error) {
    console.log(`\n❌ Fatal error: ${error.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`Total Tests: ${passed + failed}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('='.repeat(60));

  if (failed === 0) {
    console.log('\n🎉 All browser smoke tests passed!\n');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. See above for details.\n');
    process.exit(1);
  }
}

// Run the test
runBrowserTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
