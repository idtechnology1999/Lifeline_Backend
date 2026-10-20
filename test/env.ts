// Test settings. Loaded before every test file, ahead of the app's own .env
// (ConfigModule never overrides variables that are already set).
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:lifeline_dev@127.0.0.1:5432/lifeline_test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  // Redis database 1, so tests never touch dev data in database 0
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1',
  APP_URL: 'http://127.0.0.1:8000',
  APP_KEY: 'test-key',
  APP_DEBUG: 'true',
  STORAGE_DIR: join(tmpdir(), 'lifeline-test-storage'),
  FIREBASE_SERVICE_ACCOUNT: '',
});
