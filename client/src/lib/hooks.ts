import { useCallback, useEffect, useRef, useState } from 'react';
import { keepPreviousData, QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from './toast';
import { api, ApiError, Paged } from './api';

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

type Params = Record<string, string | number | boolean | undefined | null | string[]>;

/** Paged, sortable, searchable server list with its own UI state. */
export function usePaged<T>(path: string, params: Params = {}, opts: { pageSize?: number; sort?: string; enabled?: boolean } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 25);
  const [sort, setSort] = useState<string | undefined>(opts.sort);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const paramsKey = JSON.stringify(params);
  useEffect(() => setPage(1), [q, paramsKey, pageSize, sort]);
  const query = useQuery({
    queryKey: [path, { ...params, page, pageSize, sort, search: q }],
    queryFn: () => api.get<Paged<T>>(path, { ...params, page, pageSize, sort, search: q || undefined }),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
  return { ...query, page, setPage, pageSize, setPageSize, sort, setSort, search, setSearch };
}

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) {
    // Duplicate-value messages already name the field (and forms show it inline).
    if (e.code === 'DUPLICATE') return e.message;
    const fields = Object.entries(e.fieldErrors);
    const human = (k: string) => k.split('.').pop()!.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase());
    if (fields.length) return `${e.message}: ${fields.map(([k, v]) => `${human(k)} — ${v}`).join('; ')}`;
    return e.message;
  }
  return (e as Error)?.message ?? 'Error';
}

/**
 * Mutation with the standard feedback contract:
 * - success toast only after the server confirms (pass success: '' to stay silent);
 * - error toast with the server's message; field errors exposed as `fieldErrors` for inline display;
 * - a second submit while one is in flight is ignored (no duplicate records).
 */
export function useApiMutation<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: { success?: string | ((r: TRes) => string); invalidate?: string[]; onSuccess?: (r: TRes, v: TVars) => void; silentError?: boolean } = {}) {
  const qc = useQueryClient();
  const inFlight = useRef(false);
  const m = useMutation({
    mutationFn: async (v: TVars) => {
      inFlight.current = true;
      try {
        return await fn(v);
      } finally {
        inFlight.current = false;
      }
    },
    onSuccess: (r, v) => {
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg === undefined) toast.success();
      else if (msg) toast.success(msg);
      for (const p of opts.invalidate ?? []) qc.invalidateQueries({ predicate: (q) => String((q.queryKey as QueryKey)[0]).startsWith(p) });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (!opts.silentError) toast.error(errorMessage(e));
    },
  });
  const { mutate: rawMutate, mutateAsync: rawMutateAsync } = m;
  const mutate = useCallback((v: TVars) => {
    if (inFlight.current) return;
    rawMutate(v);
  }, [rawMutate]);
  const mutateAsync = useCallback((v: TVars) => (inFlight.current ? Promise.reject(new Error('busy')) : rawMutateAsync(v)), [rawMutateAsync]);
  const fieldErrors = m.error instanceof ApiError ? m.error.fieldErrors : {};
  return { ...m, mutate, mutateAsync, fieldErrors };
}

export const useGet = <T>(path: string | null, params?: Params, opts: { enabled?: boolean; staleTime?: number } = {}) =>
  useQuery({
    queryKey: [path, params ?? {}],
    queryFn: () => api.get<T>(path!, params),
    enabled: !!path && (opts.enabled ?? true),
    staleTime: opts.staleTime,
  });

/** Loads an authenticated image (e.g. an employee photo) as an object URL. */
export function useAuthedImage(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    api
      .raw(path)
      .then((r) => r.blob())
      .then((b) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url;
}
