import { useState, useEffect } from "react";
import Parse from "parse";

/**
 * useResolutionThreshold
 *
 * Fetches resolution threshold progress for a document via the
 * getResolutionProgress Cloud Function. Returns null threshold for
 * non-resolution documents.
 *
 * @param {string} documentId
 * @returns {{ threshold, groupAPercent, groupBPercent, loading, error }}
 */
export function useResolutionThreshold(documentId) {
  const [threshold, setThreshold] = useState(undefined);
  const [groupAPercent, setGroupAPercent] = useState(0);
  const [groupBPercent, setGroupBPercent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!documentId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const result = await Parse.Cloud.run("getResolutionProgress", { documentId });

        if (cancelled) return;

        if (!result) {
          setThreshold(null);
        } else {
          setThreshold(result.threshold);
          setGroupAPercent(result.groupAPercent ?? 0);
          setGroupBPercent(result.groupBPercent ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[useResolutionThreshold] error:", err);
          setError(err);
          setThreshold(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  return { threshold, groupAPercent, groupBPercent, loading, error };
}

export default useResolutionThreshold;
