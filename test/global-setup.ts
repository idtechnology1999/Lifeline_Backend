import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './env.js';

/**
 * Bring the test database up to date with the migrations (creates it if
 * missing). Tables are emptied before each test by helpers.ts.
 */
export default function setup() {
  if (!new URL(TEST_DATABASE_URL).pathname.endsWith('_test')) {
    throw new Error(`Refusing to run tests against ${TEST_DATABASE_URL}: the database name must end in _test.`);
  }
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
