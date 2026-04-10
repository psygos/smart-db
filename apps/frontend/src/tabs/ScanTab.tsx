import { useState } from "react";
import type { FormEvent } from "react";
import type {
  AssignQrRequest,
  InstanceStatus,
  MeasurementUnit,
  PartType,
  ScanResponse,
  StockEventKind,
} from "@smart-db/contracts";
import { instanceStatuses, measurementUnitCatalog } from "@smart-db/contracts";
import { PanelTitle } from "../components/PanelTitle";
import { QRScanner } from "../components/QRScanner";
import {
  actionLabel,
  formatCategoryPath,
  formatQuantity,
  formatTimestamp,
  quantityInputStep,
  type AssignFormIssues,
  type AssignFormState,
  type EventFormIssues,
  type EventFormState,
} from "../SmartApp.helpers";

type SearchState = {
  query: string;
  results: PartType[];
  status: "idle" | "loading" | "error";
  error: string | null;
};

export interface LastAssignment {
  partTypeName: string;
  partTypeId: string;
  location: string;
}

interface ScanTabProps {
  scanCode: string;
  onScanCodeChange: (value: string) => void;
  scanInputRef: React.RefObject<HTMLInputElement | null>;
  scanResultRef: React.RefObject<HTMLDivElement | null>;
  scanResult: ScanResponse | null;
  pendingAction: string | null;
  onScan: (event: FormEvent<HTMLFormElement>) => void;
  onCameraScan: (code: string) => void;
  onScanNext: () => void;
  cameraLookupCode: string | null;
  cameraBlockedReason: string | null;
  // Label
  labelSearch: SearchState;
  labelOptions: PartType[];
  assignForm: AssignFormState;
  assignIssues: AssignFormIssues;
  onAssignFormChange: (updater: (current: AssignFormState) => AssignFormState) => void;
  onLabelSearch: (query: string) => void;
  onAssign: (event: FormEvent<HTMLFormElement>) => void;
  sessionUsername: string;
  lastAssignment: LastAssignment | null;
  onAssignSame: () => void;
  // Interact
  eventForm: EventFormState;
  eventIssues: EventFormIssues;
  onEventFormChange: (updater: (current: EventFormState) => EventFormState) => void;
  onRecordEvent: (event: FormEvent<HTMLFormElement>) => void;
}

export function ScanTab(props: ScanTabProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selectedMeasurementUnit =
    measurementUnitCatalog.find((unit) => unit.symbol === props.assignForm.unitSymbol) ??
    measurementUnitCatalog[0];
  const bulkUnitSymbol =
    props.scanResult?.mode === "interact" && props.scanResult.entity.targetType === "bulk"
      ? props.scanResult.entity.partType.unit.symbol
      : selectedMeasurementUnit.symbol;
  const bulkQuantityStep =
    props.scanResult?.mode === "interact" && props.scanResult.entity.targetType === "bulk"
      ? quantityInputStep(props.scanResult.entity.partType.unit.isInteger)
      : quantityInputStep(selectedMeasurementUnit.isInteger);

  return (
    <section className="panel">
      <PanelTitle
        title="Scan"
        copy="Scan a sticker to assign it, update it, or look up what it belongs to."
      />
      <QRScanner
        onScan={props.onCameraScan}
        enabled
        isLookingUp={props.cameraLookupCode !== null}
        blockedReason={props.cameraBlockedReason}
        onScanNext={props.onScanNext}
      />
      <form className="scan-form" onSubmit={props.onScan}>
        <label className="sr-only" htmlFor="scan-code-input">
          Scan or type a QR / barcode
        </label>
        <input
          id="scan-code-input"
          ref={props.scanInputRef}
          aria-label="Scan or type a QR / barcode"
          placeholder="Scan or type a QR / barcode"
          value={props.scanCode}
          onChange={(event) => props.onScanCodeChange(event.target.value)}
        />
        <button type="submit" disabled={props.pendingAction !== null}>
          {props.pendingAction === "scan" ? "Opening..." : "Open"}
        </button>
      </form>

      <div aria-live="polite" ref={props.scanResultRef}>
      {props.scanResult?.mode === "unknown" ? (
        <div className="result-card">
          <h3>{props.scanResult.code} is unknown to Smart DB</h3>
          <p>
            That usually means this is a manufacturer barcode or a QR that
            has not been pre-registered yet.
          </p>
          <small>{props.scanResult.partDb.message}</small>
        </div>
      ) : null}

      {props.scanResult?.mode === "label" ? (
        <div className="result-card">
          <h3>Assign {props.scanResult.qrCode.code}</h3>
          {props.lastAssignment && (
            <div className="assign-same-bar">
              <button
                type="button"
                onClick={props.onAssignSame}
                disabled={props.pendingAction !== null}
              >
                Assign Same ({props.lastAssignment.partTypeName} · {props.lastAssignment.location})
              </button>
            </div>
          )}
          <form className="form-grid" onSubmit={props.onAssign}>
            <div className="wide mode-toggle" role="radiogroup" aria-label="Part type mode">
              <button
                type="button"
                role="radio"
                className={props.assignForm.partTypeMode === "existing" ? "selected" : ""}
                aria-checked={props.assignForm.partTypeMode === "existing"}
                onClick={() =>
                  props.onAssignFormChange((current) => ({
                    ...current,
                    partTypeMode: "existing",
                    canonicalName: "",
                    category: "",
                  }))
                }
              >
                Use existing type
              </button>
              <button
                type="button"
                role="radio"
                className={props.assignForm.partTypeMode === "new" ? "selected" : ""}
                aria-checked={props.assignForm.partTypeMode === "new"}
                onClick={() =>
                  props.onAssignFormChange((current) => ({
                    ...current,
                    partTypeMode: "new",
                    existingPartTypeId: "",
                  }))
                }
              >
                Create new type
              </button>
            </div>
            {props.assignForm.partTypeMode === "existing" ? (
              <>
                <label className="wide">
                  Search existing part types
                  <input
                    value={props.labelSearch.query}
                    onChange={(event) => props.onLabelSearch(event.target.value)}
                    placeholder="Arduino, JST, PLA, cotton..."
                  />
                </label>
                {props.labelSearch.error ? <p className="banner error wide">{props.labelSearch.error}</p> : null}
                {props.assignIssues.existingPartTypeId ? (
                  <p className="field-error wide">{props.assignIssues.existingPartTypeId}</p>
                ) : null}
                <div className="wide picker" role="radiogroup" aria-label="Existing part types">
                  {props.labelOptions.length > 0 ? (
                    props.labelOptions.map((partType) => (
                      <button
                        key={partType.id}
                        type="button"
                        role="radio"
                        aria-checked={props.assignForm.existingPartTypeId === partType.id}
                        className={
                          props.assignForm.existingPartTypeId === partType.id ? "selected" : ""
                        }
                        onClick={() =>
                          props.onAssignFormChange((current) => ({
                            ...current,
                            entityKind: partType.countable ? "instance" : "bulk",
                            partTypeMode: "existing",
                            existingPartTypeId: partType.id,
                            canonicalName: "",
                            category: formatCategoryPath(partType.categoryPath),
                            countable: partType.countable,
                            unitSymbol: partType.unit.symbol,
                            initialStatus: "available",
                            initialQuantity: "0",
                            minimumQuantity: "",
                          }))
                        }
                      >
                        <strong>{partType.canonicalName}</strong>
                        <span>{formatCategoryPath(partType.categoryPath)}</span>
                      </button>
                    ))
                  ) : (
                    <p className="muted-copy">No matching part types yet.</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <label className="wide">
                  New canonical name
                  <input
                    value={props.assignForm.canonicalName}
                    placeholder="Arduino Uno R3"
                    onChange={(event) =>
                      props.onAssignFormChange((current) => ({
                        ...current,
                        canonicalName: event.target.value,
                      }))
                    }
                  />
                  {props.assignIssues.canonicalName ? (
                    <span className="field-error">{props.assignIssues.canonicalName}</span>
                  ) : null}
                </label>
                <label>
                  Category path
                  <input
                    value={props.assignForm.category}
                    placeholder="Electronics/Resistors/SMD 0603"
                    onChange={(event) =>
                      props.onAssignFormChange((current) => ({
                        ...current,
                        category: event.target.value,
                      }))
                    }
                  />
                  {props.assignIssues.category ? (
                    <span className="field-error">{props.assignIssues.category}</span>
                  ) : null}
                </label>
              </>
            )}
            <label>
              Location
              <input
                value={props.assignForm.location}
                onChange={(event) =>
                  props.onAssignFormChange((current) => ({
                    ...current,
                    location: event.target.value,
                  }))
                }
              />
              {props.assignIssues.location ? (
                <span className="field-error">{props.assignIssues.location}</span>
              ) : null}
            </label>
            <button
              type="button"
              className="disclosure"
              onClick={() => setShowAdvanced((prev) => !prev)}
            >
              {showAdvanced ? "Fewer options" : "More options"}
            </button>
            {showAdvanced && (
              <>
                {props.assignForm.partTypeMode === "new" ? (
                  <label>
                    Kind
                    <select
                      value={props.assignForm.entityKind}
                      onChange={(event) =>
                        props.onAssignFormChange((current) => ({
                          ...current,
                          entityKind: event.target.value as AssignQrRequest["entityKind"],
                        }))
                      }
                    >
                      <option value="instance">Physical instance</option>
                      <option value="bulk">Bulk bin</option>
                    </select>
                  </label>
                ) : (
                  <div className="derived-kind">
                    <strong>Kind</strong>
                    <span>
                      {props.assignForm.entityKind === "instance" ? "Physical instance" : "Bulk bin"}
                    </span>
                  </div>
                )}
                {props.assignForm.entityKind === "instance" ? (
                  <label>
                    Initial status
                    <select
                        value={props.assignForm.initialStatus}
                      onChange={(event) =>
                        props.onAssignFormChange((current) => ({
                          ...current,
                          initialStatus: event.target.value as InstanceStatus,
                        }))
                      }
                    >
                      {instanceStatuses.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <>
                    <label>
                      Starting quantity
                      <input
                        type="number"
                        min="0"
                        inputMode="decimal"
                        value={props.assignForm.initialQuantity}
                        step={quantityInputStep(selectedMeasurementUnit.isInteger)}
                        onChange={(event) =>
                          props.onAssignFormChange((current) => ({
                            ...current,
                            initialQuantity: event.target.value,
                          }))
                        }
                      />
                      {props.assignIssues.initialQuantity ? (
                        <span className="field-error">{props.assignIssues.initialQuantity}</span>
                      ) : null}
                    </label>
                    <label>
                      Low-stock threshold
                      <input
                        type="number"
                        min="0"
                        inputMode="decimal"
                        value={props.assignForm.minimumQuantity}
                        step={quantityInputStep(selectedMeasurementUnit.isInteger)}
                        onChange={(event) =>
                          props.onAssignFormChange((current) => ({
                            ...current,
                            minimumQuantity: event.target.value,
                          }))
                        }
                        placeholder="Optional"
                      />
                      {props.assignIssues.minimumQuantity ? (
                        <span className="field-error">{props.assignIssues.minimumQuantity}</span>
                      ) : null}
                    </label>
                    {props.assignForm.partTypeMode === "new" ? (
                      <label>
                        Unit
                        <select
                          value={props.assignForm.unitSymbol}
                          onChange={(event) =>
                            props.onAssignFormChange((current) => ({
                              ...current,
                              unitSymbol: event.target.value,
                            }))
                          }
                        >
                          {measurementUnitCatalog.map((unit) => (
                            <option key={unit.symbol} value={unit.symbol}>
                              {unit.name} ({unit.symbol})
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </>
                )}
                {props.assignForm.partTypeMode === "new" ? (
                  <label>
                    Countable
                    <select
                      value={String(props.assignForm.countable)}
                      onChange={(event) =>
                        props.onAssignFormChange((current) => ({
                          ...current,
                          countable: event.target.value === "true",
                        }))
                      }
                    >
                      <option value="true">Discrete items</option>
                      <option value="false">Bulk / non-countable</option>
                    </select>
                  </label>
                ) : null}
                <label className="wide">
                  Notes
                  <textarea
                    value={props.assignForm.notes}
                    onChange={(event) =>
                      props.onAssignFormChange((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}
            <button type="submit" disabled={props.pendingAction !== null || Object.keys(props.assignIssues).length > 0}>
              {props.pendingAction === "assign" ? "Assigning..." : "Assign QR"}
            </button>
          </form>
        </div>
      ) : null}

      {props.scanResult?.mode === "interact" ? (
        <div className="result-card">
          <h3>
            {props.scanResult.entity.partType.canonicalName} · {props.scanResult.entity.qrCode}
          </h3>
          <p>
            {props.scanResult.entity.targetType} in {props.scanResult.entity.location} · current state{" "}
            <strong>{props.scanResult.entity.state}</strong>
          </p>
          {props.scanResult.entity.targetType === "bulk" && props.scanResult.entity.quantity !== null ? (
            <p className="muted-copy">
              Quantity: {formatQuantity(props.scanResult.entity.quantity)} {props.scanResult.entity.partType.unit.symbol}
              {props.scanResult.entity.minimumQuantity !== null
                ? ` · threshold ${formatQuantity(props.scanResult.entity.minimumQuantity)} ${props.scanResult.entity.partType.unit.symbol}`
                : ""}
            </p>
          ) : null}
            <div className="action-buttons">
              {props.scanResult.availableActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  aria-pressed={props.eventForm.event === action}
                  className={props.eventForm.event === action ? "selected" : ""}
                  onClick={() =>
                  props.onEventFormChange((current) => ({
                    ...current,
                    event: action as StockEventKind,
                  }))
                }
              >
                {actionLabel(action)}
              </button>
            ))}
          </div>
          <form className="form-grid" onSubmit={props.onRecordEvent}>
            {(props.eventForm.event === "moved" ||
              props.eventForm.event === "checked_out") && (
              <label>
                Location
                <input
                  value={props.eventForm.location}
                  onChange={(event) =>
                    props.onEventFormChange((current) => ({
                      ...current,
                      location: event.target.value,
                    }))
                  }
                />
                {props.eventIssues.location ? (
                  <span className="field-error">{props.eventIssues.location}</span>
                ) : null}
              </label>
            )}
            {props.eventForm.event === "checked_out" && (
              <label>
                Assignee
                <input
                  value={props.eventForm.assignee}
                  onChange={(event) =>
                    props.onEventFormChange((current) => ({
                      ...current,
                      assignee: event.target.value,
                    }))
                  }
                />
              </label>
            )}
            {(props.eventForm.event === "restocked" ||
              props.eventForm.event === "consumed" ||
              props.eventForm.event === "adjusted") &&
              props.scanResult.entity.targetType === "bulk" && (
              <label>
                {props.eventForm.event === "adjusted" ? `Adjustment (${bulkUnitSymbol})` : `Quantity change (${bulkUnitSymbol})`}
                <input
                  type="number"
                  step={bulkQuantityStep}
                  inputMode="decimal"
                  value={props.eventForm.quantityDelta}
                  onChange={(event) =>
                    props.onEventFormChange((current) => ({
                      ...current,
                      quantityDelta: event.target.value,
                    }))
                  }
                />
                {props.eventIssues.quantityDelta ? (
                  <span className="field-error">{props.eventIssues.quantityDelta}</span>
                ) : null}
              </label>
            )}
            {props.eventForm.event === "stocktaken" &&
              props.scanResult.entity.targetType === "bulk" && (
              <label>
                Quantity on hand ({bulkUnitSymbol})
                <input
                  type="number"
                  min="0"
                  step={bulkQuantityStep}
                  inputMode="decimal"
                  value={props.eventForm.quantity}
                  onChange={(event) =>
                    props.onEventFormChange((current) => ({
                      ...current,
                      quantity: event.target.value,
                    }))
                  }
                />
                {props.eventIssues.quantity ? (
                  <span className="field-error">{props.eventIssues.quantity}</span>
                ) : null}
              </label>
            )}
            <label className="wide">
              Notes
              <textarea
                value={props.eventForm.notes}
                onChange={(event) =>
                  props.onEventFormChange((current) => ({
                    ...current,
                    notes: event.target.value,
                    }))
                  }
                />
                {props.eventIssues.notes ? (
                  <span className="field-error">{props.eventIssues.notes}</span>
                ) : null}
              </label>
            <button type="submit" disabled={props.pendingAction !== null || Object.keys(props.eventIssues).length > 0}>
              {props.pendingAction === "event" ? "Saving..." : `Confirm ${actionLabel(props.eventForm.event)}`}
            </button>
          </form>

          <div className="event-list">
            {props.scanResult.recentEvents.map((stockEvent) => (
              <article key={stockEvent.id}>
                <strong>{actionLabel(stockEvent.event)}</strong>
                <span>
                  {stockEvent.actor} · {formatTimestamp(stockEvent.createdAt)}
                </span>
                <small>
                  {stockEvent.fromState ?? "none"} → {stockEvent.toState ?? "none"}
                </small>
              </article>
            ))}
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}
