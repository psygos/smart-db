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
  type SearchState,
} from "../SmartApp.helpers";

export interface LastAssignment {
  partTypeName: string;
  partTypeId: string;
  location: string;
}

interface ScanTabProps {
  scanCode: string;
  onScanCodeChange: (value: string) => void;
  scanMode: "increment" | "inspect";
  onScanModeChange: (mode: "increment" | "inspect") => void;
  incrementAmount: number;
  onIncrementAmountChange: (amount: number) => void;
  scanInputRef: React.RefObject<HTMLInputElement | null>;
  scanResultRef: React.RefObject<HTMLDivElement | null>;
  scanResult: ScanResponse | null;
  pendingAction: string | null;
  onScan: (event: FormEvent<HTMLFormElement>) => void;
  onCameraScan: (code: string) => void;
  onScanNext: () => void;
  onRegisterUnknown: (code: string) => void;
  cameraLookupCode: string | null;
  cameraBlockedReason: string | null;
  // Label
  labelSearch: SearchState;
  labelOptions: PartType[];
  fullPartTypeCatalog: PartType[];
  assignForm: AssignFormState;
  assignIssues: AssignFormIssues;
  onAssignFormChange: (updater: (current: AssignFormState) => AssignFormState) => void;
  knownLocations: string[];
  knownCategories: string[];
  onLabelSearch: (query: string) => void;
  onAssign: (event: FormEvent<HTMLFormElement>) => void;
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

      {props.scanMode === "increment" ? (
        <p className="scan-mode-hint">Each scan adds +1 to count</p>
      ) : (
        <p className="scan-mode-hint">View only — scanning won't change quantities</p>
      )}



      <div aria-live="polite" ref={props.scanResultRef}>
      {props.scanResult?.mode === "unknown" ? (() => {
        const unknownResult = props.scanResult;
        const handleRegister = () => props.onRegisterUnknown(unknownResult.code);
        return (
          <div className="result-card">
            <h3>{unknownResult.code} is unknown to Smart DB</h3>
            <p>
              Register this barcode to start tracking it. Future scans will
              automatically increment the quantity on hand.
            </p>
            <button
              type="button"
              onClick={handleRegister}
              disabled={props.pendingAction !== null}
              style={{ marginTop: "0.75rem" }}
            >
              Register this barcode
            </button>
            <small style={{ display: "block", marginTop: "0.5rem" }}>{unknownResult.partDb.message}</small>
          </div>
        );
      })() : null}

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
                {props.assignForm.existingPartTypeId ? (() => {
                  // Look up across BOTH the visible search results and the full catalog,
                  // so the fork button stays reachable even if the user filters the picker.
                  const selected =
                    props.labelOptions.find((pt) => pt.id === props.assignForm.existingPartTypeId) ??
                    props.fullPartTypeCatalog.find((pt) => pt.id === props.assignForm.existingPartTypeId);
                  if (!selected) return null;
                  return (
                    <button
                      type="button"
                      className="disclosure wide"
                      onClick={() =>
                        props.onAssignFormChange((current) => ({
                          ...current,
                          partTypeMode: "new",
                          existingPartTypeId: "",
                          canonicalName: selected.canonicalName,
                          category: formatCategoryPath(selected.categoryPath),
                          countable: selected.countable,
                          entityKind: selected.countable ? "instance" : "bulk",
                          unitSymbol: selected.unit.symbol,
                        }))
                      }
                    >
                      Create a variant of "{selected.canonicalName}"
                    </button>
                  );
                })() : null}
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
                <label className="wide">
                  Category path
                  <input
                    value={props.assignForm.category}
                    placeholder="Electronics / Resistors / SMD 0603"
                    onChange={(event) =>
                      props.onAssignFormChange((current) => ({
                        ...current,
                        category: event.target.value,
                      }))
                    }
                  />
                  <small style={{ marginTop: "0.3rem", textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-sans)" }}>
                    Use <code>/</code> for sub-categories. Each level is created in Part-DB.
                  </small>
                  {props.assignIssues.category ? (
                    <span className="field-error">{props.assignIssues.category}</span>
                  ) : null}
                </label>
                {props.knownCategories.length > 0 ? (
                  <div className="wide picker" role="listbox" aria-label="Known categories">
                    {(() => {
                      const query = props.assignForm.category.trim().toLowerCase();
                      const matches = query
                        ? props.knownCategories.filter((cat) => cat.toLowerCase().includes(query))
                        : props.knownCategories;
                      const top = matches.slice(0, 6);
                      if (top.length === 0) {
                        return <p className="muted-copy">No matches. What you typed will be a new category.</p>;
                      }
                      return top.map((cat) => {
                        const segments = cat.split(" / ");
                        const leaf = segments[segments.length - 1] ?? cat;
                        return (
                          <button
                            key={cat}
                            type="button"
                            role="option"
                            aria-selected={props.assignForm.category === cat}
                            className={props.assignForm.category === cat ? "selected" : ""}
                            onClick={() =>
                              props.onAssignFormChange((current) => ({
                                ...current,
                                category: cat,
                              }))
                            }
                          >
                            <strong>{leaf}</strong>
                            <span>{cat}</span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                ) : null}
                <div className="wide mode-toggle" role="radiogroup" aria-label="Tracking mode">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={props.assignForm.entityKind === "instance"}
                    className={props.assignForm.entityKind === "instance" ? "selected" : ""}
                    onClick={() =>
                      props.onAssignFormChange((current) => ({
                        ...current,
                        entityKind: "instance",
                        countable: true,
                      }))
                    }
                  >
                    Discrete item
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={props.assignForm.entityKind === "bulk"}
                    className={props.assignForm.entityKind === "bulk" ? "selected" : ""}
                    onClick={() =>
                      props.onAssignFormChange((current) => ({
                        ...current,
                        entityKind: "bulk",
                        countable: false,
                      }))
                    }
                  >
                    Bulk / measured
                  </button>
                </div>
                {props.assignForm.entityKind === "bulk" ? (
                  <>
                    <label>
                      Unit of measure
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
                    <label>
                      Starting quantity
                      <input
                        type="number"
                        min="0"
                        inputMode="decimal"
                        value={props.assignForm.initialQuantity}
                        step={quantityInputStep(selectedMeasurementUnit.isInteger)}
                        placeholder="0"
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
                  </>
                ) : null}
              </>
            )}
            <label className="wide">
              Location
              <input
                value={props.assignForm.location}
                placeholder="e.g. Shelf A · Bin 7"
                autoComplete="off"
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
            {props.knownLocations.length > 0 ? (
              <div className="wide picker" role="listbox" aria-label="Known locations">
                {(() => {
                  const query = props.assignForm.location.trim().toLowerCase();
                  const matches = query
                    ? props.knownLocations.filter((loc) => loc.toLowerCase().includes(query))
                    : props.knownLocations;
                  const top = matches.slice(0, 6);
                  if (top.length === 0) {
                    return <p className="muted-copy">No matches — what you typed will be a new location.</p>;
                  }
                  return top.map((loc) => (
                    <button
                      key={loc}
                      type="button"
                      role="option"
                      aria-selected={props.assignForm.location === loc}
                      className={props.assignForm.location === loc ? "selected" : ""}
                      onClick={() =>
                        props.onAssignFormChange((current) => ({
                          ...current,
                          location: loc,
                        }))
                      }
                    >
                      <strong>{loc}</strong>
                      <span>existing location</span>
                    </button>
                  ));
                })()}
              </div>
            ) : null}
            <button
              type="button"
              className="disclosure"
              onClick={() => setShowAdvanced((prev) => !prev)}
            >
              {showAdvanced ? "Fewer options" : "More options"}
            </button>
            {showAdvanced && (
              <>
                {props.assignForm.partTypeMode === "existing" ? (
                  <div className="derived-kind">
                    <strong>Kind</strong>
                    <span>
                      {props.assignForm.entityKind === "instance" ? "Physical instance" : "Bulk / measured"}
                    </span>
                  </div>
                ) : null}
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
                )}
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
          <h3>{props.scanResult.entity.partType.canonicalName}</h3>
          <p className="muted-copy">
            {props.scanResult.entity.qrCode} · {props.scanResult.entity.targetType} in {props.scanResult.entity.location}
          </p>
          {props.scanResult.entity.targetType === "bulk" && props.scanResult.entity.quantity !== null ? (
            <div className="quantity-display">
              <span className="quantity-label">On hand</span>
              <span className="quantity-value">
                {formatQuantity(props.scanResult.entity.quantity)}
                <span className="quantity-unit">{props.scanResult.entity.partType.unit.symbol}</span>
              </span>
              {props.scanResult.entity.minimumQuantity !== null ? (
                <span className="quantity-threshold">
                  min {formatQuantity(props.scanResult.entity.minimumQuantity)} {props.scanResult.entity.partType.unit.symbol}
                </span>
              ) : null}
            </div>
          ) : (
            <p>
              Current state: <strong>{props.scanResult.entity.state}</strong>
            </p>
          )}
          <p className="muted-copy" style={{ fontSize: "0.78rem" }}>Part-DB sync: {props.scanResult.entity.partDbSyncStatus}</p>
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
              <>
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
              {props.eventForm.event === "moved" &&
                props.scanResult.entity.targetType === "bulk" ? (
                <label>
                  Units to move
                  <input
                    type="number"
                    min="0"
                    step={bulkQuantityStep}
                    inputMode="decimal"
                    value={props.eventForm.splitQuantity}
                    placeholder={`All (${props.scanResult.entity.quantity ?? 0})`}
                    onChange={(event) =>
                      props.onEventFormChange((current) => ({
                        ...current,
                        splitQuantity: event.target.value,
                      }))
                    }
                  />
                  <small style={{ marginTop: "0.2rem", textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-sans)" }}>
                    Leave empty to move the entire bin.
                  </small>
                  {props.eventIssues.splitQuantity ? (
                    <span className="field-error">{props.eventIssues.splitQuantity}</span>
                  ) : null}
                </label>
              ) : null}
              </>
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

      {props.scanResult && !props.cameraLookupCode && (
        <button
          type="button"
          className="scan-next-bottom"
          onClick={() => {
            props.onScanNext();
          }}
          disabled={props.pendingAction !== null}
        >
          Scan next item
        </button>
      )}
      </div>
    </section>
  );
}
