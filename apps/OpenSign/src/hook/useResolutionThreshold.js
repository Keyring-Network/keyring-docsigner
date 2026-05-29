import { useState, useEffect } from "react";
import Parse from "parse";

/**
 * useResolutionThreshold
 *
 * Fetches resolutions_Threshold and resolutions_SignerWeight for a document
 * and computes group progress percentages.
 *
 * Schema (from cloud/resolutions.js):
 *   resolutions_Threshold: { document (ptr), thresholdA, thresholdB, status }
 *   resolutions_SignerWeight: { document (ptr), signerEmail, weightGroupA, weightGroupB, excludedFromB }
 *
 * AuditTrail entries: { UserPtr: { Email, objectId }, Activity: 'Signed'|... }
 *
 * @param {string} documentId
 * @returns {{ threshold, signerWeights, groupAPercent, groupBPercent, loading, error }}
 *          Returns threshold=null when the document has no resolution threshold (normal doc).
 */
export function useResolutionThreshold(documentId) {
  const [threshold, setThreshold] = useState(undefined); // undefined = not yet loaded
  const [signerWeights, setSignerWeights] = useState([]);
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

    async function fetch() {
      try {
        setLoading(true);
        setError(null);

        const docPtr = {
          __type: "Pointer",
          className: "contracts_Document",
          objectId: documentId
        };

        // 1. Fetch resolutions_Threshold
        const tQuery = new Parse.Query("resolutions_Threshold");
        tQuery.equalTo("document", {
          __type: "Pointer",
          className: "contracts_Document",
          objectId: documentId
        });
        const thresholdObj = await tQuery.first();

        if (!thresholdObj) {
          // Not a resolution document — exit gracefully
          if (!cancelled) {
            setThreshold(null);
            setLoading(false);
          }
          return;
        }

        const thresholdData = {
          objectId: thresholdObj.id,
          thresholdA: thresholdObj.get("thresholdA") ?? 0.75,
          thresholdB: thresholdObj.get("thresholdB") ?? 0.50,
          status: thresholdObj.get("status") || "DRAFT"
        };

        // 2. Fetch signer weights
        const swQuery = new Parse.Query("resolutions_SignerWeight");
        swQuery.equalTo("document", {
          __type: "Pointer",
          className: "contracts_Document",
          objectId: documentId
        });
        swQuery.limit(1000);
        const swObjects = await swQuery.find();

        const weights = swObjects.map(sw => ({
          signerEmail: (sw.get("signerEmail") || "").toLowerCase(),
          weightGroupA: sw.get("weightGroupA") ?? 0,
          weightGroupB: sw.get("weightGroupB") ?? 0,
          excludedFromB: sw.get("excludedFromB") ?? false
        }));

        // 3. Fetch the document's AuditTrail to find who has signed
        const docQuery = new Parse.Query("contracts_Document");
        const doc = await docQuery.get(documentId);
        const auditTrail = doc.get("AuditTrail") || [];

        const completionActivities = ["Signed", "Approved"];
        const signedEmails = new Set(
          auditTrail
            .filter(entry => completionActivities.includes(entry?.Activity))
            .map(entry => {
              // AuditTrail UserPtr may have Email directly or nested
              const email =
                entry?.UserPtr?.Email ||
                entry?.UserPtr?.email ||
                entry?.email ||
                "";
              return email.toLowerCase();
            })
            .filter(Boolean)
        );

        // 4. Compute percentages
        let totalA = 0;
        let signedA = 0;
        let totalB = 0;
        let signedB = 0;

        for (const sw of weights) {
          const hasSigned = signedEmails.has(sw.signerEmail);

          totalA += sw.weightGroupA;
          if (hasSigned) signedA += sw.weightGroupA;

          if (!sw.excludedFromB) {
            totalB += sw.weightGroupB;
            if (hasSigned) signedB += sw.weightGroupB;
          }
        }

        const computedGroupAPercent = totalA > 0 ? (signedA / totalA) * 100 : 0;
        const computedGroupBPercent = totalB > 0 ? (signedB / totalB) * 100 : 0;

        if (!cancelled) {
          setThreshold(thresholdData);
          setSignerWeights(weights);
          setGroupAPercent(computedGroupAPercent);
          setGroupBPercent(computedGroupBPercent);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[useResolutionThreshold] error:", err);
          setError(err);
          setThreshold(null);
          setLoading(false);
        }
      }
    }

    fetch();

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  return { threshold, signerWeights, groupAPercent, groupBPercent, loading, error };
}

export default useResolutionThreshold;
