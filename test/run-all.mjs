/**
 * Test runner: discovers and executes every test/*.test.mjs in a child
 * process. Adding a new test file automatically includes it in CI.
 * A failure in ANY test fails the whole run.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.mjs'))
  .sort();

console.log('Discovered ' + TESTS.length + ' test file(s): ' + TESTS.join(', ') + '\n');

let failed = 0;
const failedNames = [];

for (const file of TESTS) {
  console.log('── ' + file + ' ' + '─'.repeat(Math.max(0, 58 - file.length)));
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    timeout: 120000
  });
  if (res.status !== 0) {
    failed++;
    failedNames.push(file);
    console.log('>>> FAILED: ' + file + '\n');
  } else {
    console.log('>>> ok: ' + file + '\n');
  }
}

if (failed) {
  console.error('RUN-ALL: ' + failed + ' test file(s) failed: ' + failedNames.join(', '));
  process.exit(1);
}
console.log('RUN-ALL: all ' + TESTS.length + ' test files passed');
