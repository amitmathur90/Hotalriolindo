import 'dotenv/config';
import { initDb } from './db.ts';
import { seedDemo } from './seed.ts';

console.log(`[db] ${await initDb()}`);
console.log((await seedDemo()) ? 'Demo data created.' : 'Demo data already present.');
process.exit(0);
