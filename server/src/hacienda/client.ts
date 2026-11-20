/**
 * Ministerio de Hacienda "API de Recepción" client.
 *  - Token: OpenID Connect password grant against Hacienda's IDP (ATV API user + password).
 *  - POST /recepcion  — submit a signed comprobante (base64).
 *  - GET  /recepcion/{clave} — processing status (aceptado / rechazado / procesando) + respuesta XML.
 * HACIENDA_IDP_URL / HACIENDA_API_URL override the endpoints (used by the automated tests with a mock server).
 */
export type HaciendaEnv = 'stag' | 'prod';
/** 'sim' = Simulación: documents are generated, signed and "accepted" locally and never sent to Hacienda. */
export const SIM_ENV: string = 'sim';
const realEnv = (env: string) => {
  if (env !== 'stag' && env !== 'prod') throw new Error('Ambiente de simulación: no se contacta a Hacienda');
  return env as HaciendaEnv;
};

const IDP: Record<HaciendaEnv, string> = {
  stag: 'https://idp.comprobanteselectronicos.go.cr/auth/realms/rut-stag/protocol/openid-connect/token',
  prod: 'https://idp.comprobanteselectronicos.go.cr/auth/realms/rut/protocol/openid-connect/token',
};
const CLIENT_ID: Record<HaciendaEnv, string> = { stag: 'api-stag', prod: 'api-prod' };
const API: Record<HaciendaEnv, string> = {
  stag: 'https://api-sandbox.comprobanteselectronicos.go.cr/recepcion/v1/',
  prod: 'https://api.comprobanteselectronicos.go.cr/recepcion/v1/',
};
const idpUrl = (env: HaciendaEnv) => IDP[realEnv(env)] && (process.env.HACIENDA_IDP_URL || IDP[env]);
const apiUrl = (env: HaciendaEnv) => API[realEnv(env)] && (process.env.HACIENDA_API_URL || API[env]).replace(/\/?$/, '/');

const tokens = new Map<string, { token: string; exp: number }>();
export const clearToken = (env: HaciendaEnv, username: string) => tokens.delete(`${env}:${username}`);

async function request(url: string, init: RequestInit, timeoutMs = Number(process.env.HACIENDA_HTTP_TIMEOUT_MS || 30000)) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e: any) {
    throw new Error(`Sin conexión con Hacienda (${e.name === 'AbortError' ? 'tiempo de espera agotado' : e.cause?.code || e.message})`);
  } finally {
    clearTimeout(t);
  }
}

export async function getToken(env: HaciendaEnv, username: string, password: string): Promise<string> {
  const k = `${env}:${username}`;
  const c = tokens.get(k);
  if (c && c.exp > Date.now() + 30000) return c.token;
  const res = await request(idpUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: CLIENT_ID[env], username, password }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(res.status === 401 || body.error === 'invalid_grant' ? 'Usuario o contraseña de la API de Hacienda incorrectos' : `Hacienda IDP ${res.status}: ${body.error_description || body.error || 'error'}`);
  }
  tokens.set(k, { token: body.access_token, exp: Date.now() + Number(body.expires_in || 300) * 1000 });
  return body.access_token;
}

export type SendBody = {
  clave: string;
  fecha: string;
  emisor: { tipoIdentificacion: string; numeroIdentificacion: string };
  receptor?: { tipoIdentificacion: string; numeroIdentificacion: string };
  consecutivoReceptor?: string; // Mensaje Receptor only
  comprobanteXml: string; // base64 of the signed XML
};

/** Returns { status, cause }: 201/202 = received; 400 = rejected at reception (X-Error-Cause explains why). */
export async function sendDocument(env: HaciendaEnv, token: string, body: SendBody) {
  const res = await request(apiUrl(env) + 'recepcion', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, cause: res.headers.get('x-error-cause') || text.slice(0, 500) || null };
}

export async function getStatus(env: HaciendaEnv, token: string, clave: string) {
  const res = await request(apiUrl(env) + 'recepcion/' + clave, { headers: { Authorization: `bearer ${token}` } });
  const body: any = res.ok ? await res.json().catch(() => ({})) : {};
  return {
    http: res.status,
    cause: res.headers.get('x-error-cause'),
    state: String(body['ind-estado'] || '').toLowerCase() as '' | 'aceptado' | 'rechazado' | 'procesando' | 'recibido' | 'error',
    responseXml: body['respuesta-xml'] ? Buffer.from(body['respuesta-xml'], 'base64').toString('utf8') : null,
  };
}
