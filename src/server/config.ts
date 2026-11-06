export interface Config {
  port: number;
  host: string;
  /** Base URL encoded into pairing QR codes. Undefined = derive from request / LAN IP. */
  publicUrl: string | undefined;
  dbPath: string;
  trustProxy: boolean;
  pairingTtlMs: number;
  isProduction: boolean;
  staticDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
    throw new Error('PUBLIC_URL must start with http:// or https://');
  }
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    dbPath: env.DB_PATH ?? './data/sendlink.db',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    pairingTtlMs: Number(env.PAIRING_TTL_SECONDS ?? 120) * 1000,
    isProduction: env.NODE_ENV === 'production',
    staticDir: env.STATIC_DIR ?? 'dist/public',
  };
}
