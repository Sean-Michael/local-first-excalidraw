import argon2 from "argon2";
import type { Pool } from "@shopapp/db";

export interface User {
  id: string;
  email: string;
}

/** Users table access. */
export class UserRepository {
  constructor(private pool: Pool) {}

  async verifyPassword(email: string, password: string): Promise<User | null> {
    const { rows } = await this.pool.query("select id, email, password_hash from users where email = $1", [email]);
    const row = rows[0];
    if (!row || !(await argon2.verify(row.password_hash, password))) return null;
    return { id: row.id, email: row.email };
  }
}
