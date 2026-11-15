import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type Row = Record<string, any>;
export interface Q {
  query<T = Row>(sql: string, params?: any[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: any[]): Promise<T | undefined>;
}

type Impl = {
  run(sql: string, params?: any[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  kind: string;
};

let impl: Impl;

const wrap = (run: (s: string, p?: any[]) => Promise<Row[]>): Q => ({
  query: run as any,
  one: async (s, p) => (await run(s, p))[0] as any,
});

const toNum = (v: string) => (v === null ? null : Number(v));

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    pg.types.setTypeParser(1700, toNum as any); // numeric
    pg.types.setTypeParser(20, toNum as any); // int8 / count(*)
    const pool = new pg.Pool({ connectionString: url, max: 20 });
    impl = {
      kind: 'postgresql',
      run: async (s, p) => (await pool.query(s, p)).rows,
      exec: async (s) => void (await pool.query(s)),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(wrap(async (s, p) => (await c.query(s, p)).rows));
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else {
    // Embedded PostgreSQL (WASM) for zero-config local development.
    const dir = path.resolve(process.env.PGLITE_DIR || './data/pglite');
    mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir, { parsers: { 1700: toNum, 20: toNum } as any });
    await lite.waitReady;
    impl = {
      kind: `embedded PGlite (${dir})`,
      run: async (s, p) => (await lite.query(s, p)).rows as Row[],
      exec: async (s) => void (await lite.exec(s)),
      tx: (fn) => lite.transaction((t) => fn(wrap(async (s, p) => (await t.query(s, p)).rows as Row[]))),
    };
  }
  const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await impl.exec(schema);
  await impl.exec(readFileSync(fileURLToPath(new URL('./payroll/schema.sql', import.meta.url)), 'utf8'));
  return impl.kind;
}

export const db: Q = wrap((s, p) => impl.run(s, p));
export const tx = <T>(fn: (q: Q) => Promise<T>) => impl.tx(fn);
export const json = (v: any) => JSON.stringify(v ?? null);
