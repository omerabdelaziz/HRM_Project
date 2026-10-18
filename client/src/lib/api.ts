// Thin fetch wrapper: JSON in/out, bearer token in memory, silent refresh via the httpOnly cookie.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** Field-level validation messages keyed by path. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
  }
}

let accessToken: string | null = null;
let companyId: string | null = (() => {
  try {
    return localStorage.getItem('hrms.company');
  } catch {
    return null;
  }
})();

export const companyStore = {
  get: () => companyId,
  set: (id: string | null) => {
    companyId = id;
    try {
      if (id) localStorage.setItem('hrms.company', id);
      else localStorage.removeItem('hrms.company');
    } catch {
      /* storage unavailable */
    }
  },
};
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => {
    accessToken = t;
  },
  onExpired: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export async function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return false;
        accessToken = (await r.json()).accessToken;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function qs(params?: Query) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; raw?: boolean; retry?: boolean } = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (companyId) headers['X-Company-Id'] = companyId;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}${qs(opts.query)}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await refreshAccessToken()) return request<T>(method, path, body, { ...opts, retry: false });
    listeners.forEach((fn) => fn());
  }
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, payload.error?.code ?? 'HTTP_ERROR', payload.error?.message ?? res.statusText, payload.error?.details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  raw: (path: string, query?: Query) => request<Response>('GET', path, undefined, { query, raw: true }),
};

/** Downloads a protected file (export, PDF) with the current token. */
export async function download(path: string, query?: Query, fallbackName = 'download') {
  const res = await api.raw(path, query);
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = decodeURIComponent(/filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return res;
}

/** Opens a protected file (e.g. a payslip PDF) in a new tab. */
export async function openFile(path: string) {
  const res = await api.raw(path);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
