# Explorer Page Smoke Test Results

## Test Execution Date
2026-03-11

## Server Configuration
- Dev Server: http://localhost:3001
- Route: /explorer
- Data Source: /public/explorer-data/

## Automated Test Results

### ✅ Test 1: Server-Side Infrastructure
**Status**: PASSED

- [x] Dev server running successfully on port 3001
- [x] /explorer route returns HTTP 200
- [x] Page includes Next.js hydration scripts
- [x] Server-side rendering produces valid HTML
- [x] No server errors in logs

### ✅ Test 2: Static Data Artifacts
**Status**: PASSED

- [x] manifest.json accessible at /explorer-data/manifest.json
- [x] Manifest reports 24 tables total
- [x] Manifest shows 25 rows for customers table
- [x] All 24 tables have data (verification.tablesWithData === 24)
- [x] No failed tables in manifest
- [x] bootstrap.sql accessible at /explorer-data/bootstrap.sql
- [x] SQL file contains schema creation
- [x] SQL file contains customers table with 25 INSERT statements
- [x] SQL file size: 6.08 KB

### ✅ Test 3: Security Headers for PGlite
**Status**: PASSED

Required headers for SharedArrayBuffer/WASM:
- [x] Cross-Origin-Embedder-Policy: require-corp
- [x] Cross-Origin-Opener-Policy: same-origin

### ✅ Test 4: HTML Structure
**Status**: PASSED

- [x] Page renders sidebar with "Tables" header
- [x] SQL Editor section present
- [x] Results section present
- [x] Run button present
- [x] Empty state message visible: "Select a table from the left sidebar or write a SQL query and click Run"

## Manual Browser Testing Required

**Note**: Automated browser testing blocked by macOS System Integrity Protection (SIP).
The following tests require manual verification in a real browser:

### Test 5: Client-Side Loading States

**Steps:**
1. Open http://localhost:3001/explorer in Chrome/Firefox
2. Watch the initial page load

**Expected:**
- [ ] "Loading database..." spinner appears briefly
- [ ] Spinner icon animates (rotating)
- [ ] Loading text visible during initialization

**Result:** _[To be filled by manual tester]_

---

### Test 6: PGlite Hydration and Table List

**Steps:**
1. Wait for PGlite to initialize (should take < 5 seconds)
2. Check the left sidebar

**Expected:**
- [ ] Sidebar header shows "24 tables"
- [ ] All 24 table names visible in sidebar:
  - accounts, active_entitlements, charges, checkout_session_line_items
  - checkout_sessions, coupons, credit_notes, customers, disputes
  - early_fraud_warnings, features, invoices, payment_intents
  - payment_methods, plans, prices, products, refunds, reviews
  - setup_intents, subscription_items, subscription_schedules
  - subscriptions, tax_ids
- [ ] Each table shows row count next to name
- [ ] Customers table shows "25 rows"
- [ ] Tables are clickable (hover shows visual feedback)
- [ ] No JavaScript errors in browser console (F12 → Console)

**Result:** _[To be filled by manual tester]_

---

### Test 7: Table Selection and Query Execution

**Steps:**
1. Click on "customers" table in the left sidebar
2. Observe the SQL Editor (top-right panel)
3. Observe the Results panel (bottom-right)

**Expected:**
- [ ] SQL Editor populates with: `SELECT * FROM stripe.customers LIMIT 100`
- [ ] CodeMirror editor syntax highlights the SQL
- [ ] Query executes automatically
- [ ] Results panel header shows "25 rows"
- [ ] Results table renders with 25 rows
- [ ] Table has columns: id, _raw_data, _account_id
- [ ] Customer IDs visible: cus_test1, cus_test2, ... cus_test25
- [ ] _raw_data column shows JSON objects
- [ ] _account_id shows "acct_test" for all rows
- [ ] Table is scrollable if content overflows
- [ ] No console errors

**Result:** _[To be filled by manual tester]_

---

### Test 8: Manual SQL Query Execution

**Steps:**
1. Click in the SQL Editor
2. Select all text (Cmd+A or Ctrl+A)
3. Type: `SELECT id, _account_id FROM stripe.customers WHERE id LIKE 'cus_test%' LIMIT 5`
4. Press Ctrl+Enter (or Cmd+Enter on Mac) OR click "Run" button
5. Observe results

**Expected:**
- [ ] Query typed into editor successfully
- [ ] CodeMirror provides syntax highlighting
- [ ] Keyboard shortcut (Ctrl+Enter) executes query
- [ ] "Run" button executes query
- [ ] Results panel shows "5 rows"
- [ ] Results table shows exactly 5 rows
- [ ] Only id and _account_id columns visible
- [ ] All rows match the LIKE pattern
- [ ] No console errors

**Result:** _[To be filled by manual tester]_

---

### Test 9: Complex Query with Multiple Tables

**Steps:**
1. Clear editor and type:
```sql
SELECT
  c.id as customer_id,
  (c._raw_data->>'email') as email,
  ch.id as charge_id,
  (ch._raw_data->>'amount')::int as amount
FROM stripe.customers c
JOIN stripe.charges ch ON ch._account_id = c._account_id
LIMIT 10
```
2. Execute the query

**Expected:**
- [ ] Query executes without errors
- [ ] Results show joined data from customers and charges
- [ ] Columns: customer_id, email, charge_id, amount
- [ ] Up to 10 rows returned
- [ ] JSON extraction (->>'email') works correctly
- [ ] Type casting (::int) works correctly

**Result:** _[To be filled by manual tester]_

---

### Test 10: Error Handling - Invalid SQL

**Steps:**
1. Clear editor and type: `SELECT * FROM nonexistent_table`
2. Execute the query
3. Observe error handling

**Expected:**
- [ ] Query executes (not blocked)
- [ ] Error message appears in Results panel
- [ ] Error message includes "does not exist" or similar
- [ ] Error styling (red background/border)
- [ ] Error icon (⚠️) visible
- [ ] Page does NOT crash
- [ ] Can still execute valid queries after error
- [ ] No unhandled exceptions in console

**Result:** _[To be filled by manual tester]_

---

### Test 11: Error Handling - Syntax Error

**Steps:**
1. Clear editor and type: `SELECT * FROM WHERE`
2. Execute the query

**Expected:**
- [ ] Syntax error message displayed
- [ ] Error indicates syntax issue
- [ ] Page remains functional
- [ ] Can correct and re-execute

**Result:** _[To be filled by manual tester]_

---

### Test 12: UI Responsiveness

**Steps:**
1. Resize browser window to various sizes
2. Test with different zoom levels (90%, 100%, 110%, 125%)

**Expected:**
- [ ] Sidebar remains visible and functional
- [ ] Editor panel resizes appropriately
- [ ] Results table scrolls horizontally for many columns
- [ ] Results table scrolls vertically for many rows
- [ ] No layout breaks at small sizes (>1024px width minimum)
- [ ] Text remains readable at all zoom levels

**Result:** _[To be filled by manual tester]_

---

### Test 13: CodeMirror Integration

**Steps:**
1. Click in SQL Editor
2. Test various editor features

**Expected:**
- [ ] Cursor blinks and is positioned correctly
- [ ] Can select text with mouse
- [ ] Can select text with keyboard (Shift+arrows)
- [ ] Copy/paste works (Cmd+C / Cmd+V)
- [ ] Undo/redo works (Cmd+Z / Cmd+Shift+Z)
- [ ] Line numbers visible in gutter
- [ ] SQL keywords highlighted in different color
- [ ] Strings highlighted appropriately
- [ ] Auto-indentation works

**Result:** _[To be filled by manual tester]_

---

### Test 14: PGlite WASM Loading

**Steps:**
1. Open browser DevTools (F12)
2. Go to Network tab
3. Filter by "wasm"
4. Reload page

**Expected:**
- [ ] .wasm files load successfully (HTTP 200)
- [ ] No CORS errors for .wasm files
- [ ] WASM files served with correct MIME type
- [ ] No "SharedArrayBuffer" errors in console
- [ ] No "Cross-Origin-Opener-Policy" errors

**Result:** _[To be filled by manual tester]_

---

### Test 15: Performance and Memory

**Steps:**
1. Open browser DevTools → Performance tab
2. Record page load
3. Execute several queries
4. Check Memory tab

**Expected:**
- [ ] Initial page load < 5 seconds
- [ ] PGlite initialization < 5 seconds
- [ ] Query execution < 500ms for simple queries
- [ ] No memory leaks (heap size stable after multiple queries)
- [ ] Browser remains responsive during queries
- [ ] No long tasks (> 50ms) blocking main thread

**Result:** _[To be filled by manual tester]_

---

## Summary

### Automated Tests: 4/4 PASSED ✅
- Server infrastructure
- Data artifacts
- Security headers
- HTML structure

### Manual Tests: 0/15 COMPLETED ⏳
- Requires browser testing by human operator
- All manual test cases documented above

## Next Steps

To complete smoke testing:

1. **Open http://localhost:3001/explorer in Chrome or Firefox**
2. **Work through Tests 5-15 sequentially**
3. **Check [x] boxes as tests pass**
4. **Document any failures with details**
5. **Take screenshots of any errors**
6. **Note browser console errors if any occur**

## Known Limitations

- Automated browser testing blocked by macOS SIP (System Integrity Protection)
- Playwright/Puppeteer cannot launch Chrome headless on this system
- Manual verification required for client-side functionality

## Success Criteria

For the smoke test to PASS, the following must be true:

- [x] Dev server running without errors
- [x] All static assets accessible
- [x] Security headers correctly configured
- [ ] Page loads and shows loading state
- [ ] 24 tables appear after hydration
- [ ] Clicking customers table shows 25 rows
- [ ] Manual SQL query executes successfully
- [ ] Invalid SQL shows error message (not crash)
- [ ] No JavaScript console errors
- [ ] CodeMirror editor functional

**Status**: PARTIALLY COMPLETE - Manual testing required
