import { db, json } from '../db.ts';
import { decrypt, encrypt } from '../hacienda/secrets.ts';

/** Settings of an external integration (Cloudbeds, QuickBooks). Keys ending in "_enc" are stored encrypted. */
export type Provider = 'cloudbeds' | 'quickbooks';

export async function getIntegration(businessId: string, provider: Provider) {
  const row = await db.one(`SELECT * FROM integrations WHERE business_id=$1 AND provider=$2`, [businessId, provider]);
  return row || { business_id: businessId, provider, enabled: false, config: {}, last_sync_at: null, last_error: null };
}

export async function saveIntegration(businessId: string, provider: Provider, patch: { enabled?: boolean; config?: Record<string, any>; last_sync_at?: Date | null; last_error?: string | null }) {
  const cur = await getIntegration(businessId, provider);
  const config = { ...(cur.config || {}), ...(patch.config || {}) };
  for (const k of Object.keys(config)) if (config[k] === undefined) delete config[k];
  await db.query(
    `INSERT INTO integrations (business_id, provider, enabled, config, last_sync_at, last_error, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (business_id, provider) DO UPDATE SET enabled=EXCLUDED.enabled, config=EXCLUDED.config, last_sync_at=EXCLUDED.last_sync_at, last_error=EXCLUDED.last_error, updated_at=now()`,
    [businessId, provider, patch.enabled ?? cur.enabled, json(config), 'last_sync_at' in patch ? patch.last_sync_at : cur.last_sync_at, 'last_error' in patch ? patch.last_error : cur.last_error],
  );
  return getIntegration(businessId, provider);
}

export const secret = (cfg: any, key: string) => (cfg?.[key + '_enc'] ? decrypt(cfg[key + '_enc']) : '');
export const sealed = (value: string) => encrypt(value);

/** Config as shown in the Back Office: secrets replaced by has_<name> flags. */
export function publicConfig(cfg: any) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg || {})) {
    if (k.endsWith('_enc')) out['has_' + k.slice(0, -4)] = !!v;
    else if (k === 'access_token') continue;
    else out[k] = v;
  }
  return out;
}
