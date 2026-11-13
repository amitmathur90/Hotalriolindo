export class ApiError extends Error {
  constructor(public status: number, message: string, public offline = false) {
    super(message);
  }
}

export type Client = <T = any>(path: string, opts?: { method?: string; body?: any; headers?: Record<string, string> }) => Promise<T>;

/** Creates an API client bound to a token + store provider. */
export function makeClient(getToken: () => string | null, getStore: () => string | null = () => null, onUnauthorized?: () => void): Client {
  return async (path, opts = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
    const s = getStore();
    if (s && !headers['X-Store-Id']) headers['X-Store-Id'] = s;
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'No connection to server', true);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      throw new ApiError(res.status, data?.error || res.statusText, res.status >= 502);
    }
    return data;
  };
}

// Back office session (email/password)
export const bo = {
  get token() { return localStorage.getItem('its.bo.token'); },
  set token(v: string | null) { if (v) localStorage.setItem('its.bo.token', v); else localStorage.removeItem('its.bo.token'); },
  get store() { return localStorage.getItem('its.bo.store'); },
  set store(v: string | null) { if (v) localStorage.setItem('its.bo.store', v); else localStorage.removeItem('its.bo.store'); },
};
export const boApi = makeClient(() => bo.token, () => bo.store, () => {
  bo.token = null;
  if (!location.pathname.startsWith('/login')) location.href = '/login';
});
