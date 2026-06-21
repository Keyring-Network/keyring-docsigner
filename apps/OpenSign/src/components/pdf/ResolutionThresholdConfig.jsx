import { useState } from "react";
import Parse from "parse";
import Alert from "../../primitives/Alert";

/**
 * ResolutionThresholdConfig
 *
 * Panel for configuring per-signer weight factors and group thresholds for a
 * shareholder resolution document. Calls the `importResolutionSchema` Parse
 * Cloud Function on save.
 *
 * Props:
 *   signers    - array of signer objects with Name / Email fields
 *   documentId - Parse objectId of the contracts_Document record
 *   onSaved    - callback invoked after a successful save
 */
const ResolutionThresholdConfig = ({ signers, documentId, onSaved }) => {
  const [thresholdA, setThresholdA] = useState(75);
  const [thresholdB, setThresholdB] = useState(50);

  // Keyed by signer index: { weightA: number, weightB: number, excludedFromB: bool }
  const [signerConfig, setSignerConfig] = useState(() =>
    (signers || []).map(() => ({ weightA: 1, weightB: 1, excludedFromB: false }))
  );

  const [isSaving, setIsSaving] = useState(false);
  const [alert, setAlert] = useState({ type: "", message: "" });

  const showAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => setAlert({ type: "", message: "" }), 3000);
  };

  const handleExcludedChange = (idx) => {
    // Radio-style: only one signer can be excluded from Group B at a time.
    setSignerConfig((prev) =>
      prev.map((cfg, i) => ({ ...cfg, excludedFromB: i === idx ? !cfg.excludedFromB : false }))
    );
  };

  const handleWeightChange = (idx, field, raw) => {
    const parsed = parseFloat(raw);
    const value = isNaN(parsed) ? 0 : Math.min(100, Math.max(0, parsed));
    setSignerConfig((prev) =>
      prev.map((cfg, i) => (i === idx ? { ...cfg, [field]: value } : cfg))
    );
  };

  const handleSave = async () => {
    if (!documentId) {
      showAlert("danger", "Document ID is missing.");
      return;
    }

    const signersPayload = (signers || []).map((signer, i) => ({
      name: signer.Name || signer.Role || "",
      email: signer.Email || signer.email || "",
      weightA: signerConfig[i]?.weightA ?? 1,
      weightB: signerConfig[i]?.weightB ?? 1,
      excludedFromGroupB: signerConfig[i]?.excludedFromB ?? false
    }));

    const params = {
      documentId,
      thresholdA: thresholdA / 100,
      thresholdB: thresholdB / 100,
      signers: signersPayload
    };

    setIsSaving(true);
    try {
      await Parse.Cloud.run("importResolutionSchema", params);
      showAlert("success", "Resolution thresholds saved successfully.");
      onSaved && onSaved();
    } catch (err) {
      console.error("importResolutionSchema error", err);
      showAlert("danger", err.message || "Failed to save resolution thresholds.");
    } finally {
      setIsSaving(false);
    }
  };

  const excludedCount = signerConfig.filter((c) => c.excludedFromB).length;

  return (
    <div className="mt-3 mx-1">
      {alert.message && (
        <Alert type={alert.type}>{alert.message}</Alert>
      )}

      {/* Collapsible section header */}
      <details className="border border-base-300 rounded-xl overflow-hidden">
        <summary className="px-3 py-2 text-[13px] font-semibold text-base-content cursor-pointer select-none bg-base-200 hover:bg-base-300 transition-colors">
          <span className="ml-1">Resolution Thresholds</span>
        </summary>

        <div className="px-3 py-3 bg-base-100 flex flex-col gap-3">
          {/* Group threshold inputs */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <label className="text-[12px] font-medium text-base-content w-[160px] shrink-0">
                Group A threshold (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={thresholdA}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setThresholdA(isNaN(v) ? 0 : Math.min(100, Math.max(0, v)));
                }}
                className="op-input op-input-bordered op-input-sm w-[80px] text-[12px]"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[12px] font-medium text-base-content w-[160px] shrink-0">
                Group B threshold (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={thresholdB}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setThresholdB(isNaN(v) ? 0 : Math.min(100, Math.max(0, v)));
                }}
                className="op-input op-input-bordered op-input-sm w-[80px] text-[12px]"
              />
            </div>
          </div>

          {/* Signer table */}
          {signers && signers.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="border-b border-base-300">
                    <th className="text-left font-semibold text-base-content pb-1 pr-2">
                      Signer
                    </th>
                    <th className="text-center font-semibold text-base-content pb-1 px-2">
                      Group A weight
                    </th>
                    <th className="text-center font-semibold text-base-content pb-1 px-2">
                      Group B weight
                    </th>
                    <th className="text-center font-semibold text-base-content pb-1 pl-2">
                      Exclude from B
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {signers.map((signer, i) => (
                    <tr key={i} className="border-b border-base-200 last:border-0">
                      <td className="py-1.5 pr-2">
                        <div className="font-medium truncate max-w-[100px]">
                          {signer.Name || signer.Role || "—"}
                        </div>
                        <div className="text-base-content opacity-60 truncate max-w-[100px]">
                          {signer.Email || signer.email || ""}
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.01}
                          value={signerConfig[i]?.weightA ?? 1}
                          onChange={(e) => handleWeightChange(i, "weightA", e.target.value)}
                          className="op-input op-input-bordered op-input-xs w-[60px] text-center text-[11px]"
                        />
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.01}
                          value={signerConfig[i]?.weightB ?? 1}
                          onChange={(e) => handleWeightChange(i, "weightB", e.target.value)}
                          disabled={signerConfig[i]?.excludedFromB}
                          className="op-input op-input-bordered op-input-xs w-[60px] text-center text-[11px] disabled:opacity-40"
                        />
                      </td>
                      <td className="py-1.5 pl-2 text-center">
                        <input
                          type="checkbox"
                          checked={signerConfig[i]?.excludedFromB ?? false}
                          onChange={() => handleExcludedChange(i)}
                          className="op-checkbox op-checkbox-xs"
                          title="Exclude this signer from Group B (radio-style — only one allowed)"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {excludedCount > 1 && (
                <p className="text-[10px] text-warning mt-1">
                  Only one signer should be excluded from Group B.
                </p>
              )}
            </div>
          )}

          {/* Save button */}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="op-btn op-btn-primary op-btn-sm text-[12px]"
            >
              {isSaving ? (
                <span className="op-loading op-loading-spinner op-loading-xs"></span>
              ) : (
                "Save Thresholds"
              )}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
};

export default ResolutionThresholdConfig;
