/** Where live session tokens are kept. */
export interface TokenCache {
  put(token: string, userId: string): Promise<void>;
  get(token: string): Promise<string | null>;
  revoke(token: string): Promise<void>;
}
