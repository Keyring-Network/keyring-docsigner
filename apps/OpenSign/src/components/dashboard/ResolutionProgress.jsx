import { useResolutionThreshold } from "../../hook/useResolutionThreshold";

/**
 * ResolutionProgress
 *
 * Shows threshold signing progress for resolution documents.
 * Returns null for normal (non-resolution) documents.
 *
 * Props:
 *   documentId {string} - Parse objectId of the contracts_Document
 */
const ResolutionProgress = ({ documentId }) => {
  const { threshold, groupAPercent, groupBPercent, loading } =
    useResolutionThreshold(documentId);

  // Not yet loaded
  if (loading) return null;

  // Not a resolution document
  if (!threshold) return null;

  const { thresholdA, thresholdB, status } = threshold;

  const thresholdAPercent = thresholdA * 100;
  const thresholdBPercent = thresholdB * 100;

  const statusBadge = () => {
    switch (status) {
      case "ACTIVE":
        return (
          <span className="op-badge op-badge-primary text-[10px] px-1.5 py-0.5 rounded font-semibold">
            ACTIVE
          </span>
        );
      case "EXECUTED":
        return (
          <span className="op-badge op-badge-success text-[10px] px-1.5 py-0.5 rounded font-semibold">
            EXECUTED
          </span>
        );
      case "CANCELLED":
        return (
          <span className="op-badge op-badge-error text-[10px] px-1.5 py-0.5 rounded font-semibold">
            CANCELLED
          </span>
        );
      default:
        // DRAFT or PENDING_APPROVAL
        return (
          <span className="op-badge text-[10px] px-1.5 py-0.5 rounded font-semibold bg-base-300 text-base-content">
            DRAFT
          </span>
        );
    }
  };

  const ProgressBar = ({ percent, thresholdPercent, label }) => {
    const clamped = Math.min(percent, 100);
    const met = percent >= thresholdPercent;
    return (
      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-gray-500 w-12 shrink-0">{label}</span>
        {/* Track */}
        <div className="relative flex-1 h-1.5 bg-base-300 rounded-full overflow-visible min-w-[48px]">
          {/* Fill */}
          <div
            className={`h-full rounded-full transition-all ${met ? "bg-success" : "bg-primary"}`}
            style={{ width: `${clamped}%` }}
          />
          {/* Threshold marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-base-content/50"
            style={{ left: `${thresholdPercent}%` }}
            title={`Required: ${thresholdPercent.toFixed(0)}%`}
          />
        </div>
        <span className={`w-16 text-right tabular-nums ${met ? "text-success" : "text-base-content"}`}>
          {percent.toFixed(0)}%&nbsp;/&nbsp;{thresholdPercent.toFixed(0)}%
        </span>
      </div>
    );
  };

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <div className="flex items-center gap-1 mb-0.5">
        {statusBadge()}
        {status === "EXECUTED" && (
          <span className="text-[10px] text-success font-medium">Executed ✓</span>
        )}
      </div>
      <ProgressBar
        label="Group A"
        percent={groupAPercent}
        thresholdPercent={thresholdAPercent}
      />
      <ProgressBar
        label="Group B"
        percent={groupBPercent}
        thresholdPercent={thresholdBPercent}
      />
    </div>
  );
};

export default ResolutionProgress;
