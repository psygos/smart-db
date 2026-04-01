import type { FormEvent } from "react";
import type { PartType, QrBatch, RegisterQrBatchRequest } from "@smart-db/contracts";
import { PanelTitle } from "../components/PanelTitle";

type SearchState = {
  query: string;
  results: PartType[];
  status: "idle" | "loading" | "error";
  error: string | null;
};

interface AdminTabProps {
  sessionUsername: string;
  pendingAction: string | null;
  // Batch
  batchForm: RegisterQrBatchRequest;
  onBatchFormChange: (updater: (current: RegisterQrBatchRequest) => RegisterQrBatchRequest) => void;
  onRegisterBatch: (event: FormEvent<HTMLFormElement>) => void;
  latestBatch: QrBatch | null;
  latestBatchLabelsUrl: string | null;
  // Merge
  provisionalPartTypes: PartType[];
  mergeSourceId: string;
  onMergeSourceIdChange: (value: string) => void;
  mergeDestinationId: string;
  onMergeDestinationIdChange: (value: string) => void;
  mergeSearch: SearchState;
  mergeOptions: PartType[];
  onMergeSearch: (query: string) => void;
  onMerge: () => void;
  onApprovePartType: (id: string) => void;
}

export function AdminTab(props: AdminTabProps) {
  return (
    <>
      <section className="panel">
        <PanelTitle
          title="Print QR batches"
          copy={`Pre-register sticker ranges. This batch will be attributed to ${props.sessionUsername}.`}
        />
        {props.latestBatch ? (
          <div className="latest-batch-card">
            <div>
              <strong>Latest batch</strong>
              <p>
                {props.latestBatch.id} · {props.latestBatch.prefix}-{props.latestBatch.startNumber}
                {" "}to{" "}
                {props.latestBatch.prefix}-{props.latestBatch.endNumber}
              </p>
              <small>
                {props.latestBatch.endNumber - props.latestBatch.startNumber + 1} labels · created by{" "}
                {props.latestBatch.actor}
              </small>
            </div>
            {props.latestBatchLabelsUrl ? (
              <a className="button-link" href={props.latestBatchLabelsUrl}>
                Download PDF Labels
              </a>
            ) : null}
          </div>
        ) : (
          <p className="muted-copy">No QR batch has been registered yet.</p>
        )}
        <form className="form-grid" onSubmit={props.onRegisterBatch}>
          <label>
            Prefix
            <input
              value={props.batchForm.prefix}
              onChange={(event) =>
                props.onBatchFormChange((current) => ({
                  ...current,
                  prefix: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Start number
            <input
              type="number"
              value={props.batchForm.startNumber}
              onChange={(event) =>
                props.onBatchFormChange((current) => ({
                  ...current,
                  startNumber: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Count
            <input
              type="number"
              value={props.batchForm.count}
              onChange={(event) =>
                props.onBatchFormChange((current) => ({
                  ...current,
                  count: Number(event.target.value),
                }))
              }
            />
          </label>
          <button type="submit" disabled={props.pendingAction !== null}>
            {props.pendingAction === "batch" ? "Registering..." : "Register batch"}
          </button>
        </form>
      </section>

      <section className="panel">
        <PanelTitle
          title="Canonicalize provisional types"
          copy="Merge cleanup uses its own predictive search state and request ordering."
        />
        <div className="stack">
          <label>
            Provisional source
            <select
              value={props.mergeSourceId}
              onChange={(event) => props.onMergeSourceIdChange(event.target.value)}
            >
              <option value="">Select provisional type</option>
              {props.provisionalPartTypes.map((partType) => (
                <option key={partType.id} value={partType.id}>
                  {partType.canonicalName} · {partType.category}
                </option>
              ))}
            </select>
          </label>
          {props.mergeSourceId && (
            <button
              type="button"
              onClick={() => props.onApprovePartType(props.mergeSourceId)}
              disabled={props.pendingAction !== null}
            >
              Keep As-Is
            </button>
          )}
          <label>
            Find canonical destination
            <input
              value={props.mergeSearch.query}
              onChange={(event) => props.onMergeSearch(event.target.value)}
              placeholder="Search existing type"
            />
          </label>
          {props.mergeSearch.error ? <p className="banner error">{props.mergeSearch.error}</p> : null}
          <div className="picker">
            {props.mergeOptions.map((partType) => (
              <button
                key={partType.id}
                type="button"
                className={props.mergeDestinationId === partType.id ? "selected" : ""}
                onClick={() => props.onMergeDestinationIdChange(partType.id)}
              >
                <strong>{partType.canonicalName}</strong>
                <span>{partType.category}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={props.onMerge}
            disabled={props.pendingAction !== null}
          >
            {props.pendingAction === "merge" ? "Merging..." : "Merge provisional type"}
          </button>
        </div>
      </section>
    </>
  );
}
