export class ApiError extends Error {
  constructor(public status: number, message: string, public offline = false) {
    super(message);
  }
}

export type Client = <T = any>(path: string, opts?: { method?: string; body?: any; headers?: Record<string, string>; text?: boolean; blob?: boolean }) => Promise<T>;

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
    if (opts.blob && res.ok) return (await res.blob()) as any; // e.g. PDF downloads
    const raw = await res.text().catch(() => '');
    let data: any = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      throw new ApiError(res.status, data?.error || res.statusText, res.status >= 502);
    }
    return (opts.text ? raw : data) as any; // text: raw body, e.g. XML downloads
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

/** Fetches a file with the session (e.g. an invoice PDF) and opens it in a new tab (or downloads it). */
export async function openFile(api: Client, path: string, filename?: string) {
  const win = filename ? null : window.open('', '_blank');
  try {
    const blob = await api<Blob>(path, { blob: true });
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename!;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    win?.close();
    throw e;
  }
}
