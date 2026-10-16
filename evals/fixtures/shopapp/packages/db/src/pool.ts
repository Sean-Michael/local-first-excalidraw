import pg from "pg";

export type Pool = pg.Pool;

/** One Postgres pool per process (shopapp-pg). */
export function createPool(url: string): Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}
