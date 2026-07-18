"use client";

import { useEffect, useState } from "react";

/**
 * Fetch a JSON GET endpoint once on mount, guarding against setState-after-unmount — the `let alive
 * = true` boilerplate that was copy-pasted across the governance screens. Returns the parsed body
 * (null until loaded / on error), a loading flag (false once the request settles, success OR error —
 * so a screen can distinguish "loading" from "loaded but empty"), and any error message. Pass
 * url=null to skip the fetch.
 */
export function useFetchOnce<T>(url: string | null): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T;
        if (alive) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);
  return { data, loading, error };
}
