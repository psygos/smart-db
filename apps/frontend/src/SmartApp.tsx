import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  AuthSession,
  DashboardSummary,
  InstanceStatus,
  QrBatch,
  PartDbConnectionStatus,
  PartDbSyncFailure,
  PartDbSyncStatusResponse,
  PartType,
  RegisterQrBatchRequest,
  ScanResponse,
} from "@smart-db/contracts";
import {
  hasSmartDbRole,
  smartDbRoles,
} from "@smart-db/contracts";
import {
  ApiClientError,
  api,
  downloadQrBatchLabelsPdf,
  loginUrl,
  type InventorySummaryRow,
} from "./api";
import { PanelTitle } from "./components/PanelTitle";
import { Metric } from "./components/Metric";
import { ScanTab, type LastAssignment } from "./tabs/ScanTab";
import { InventoryTab } from "./tabs/InventoryTab";
import { ActivityTab, type ScanHistoryEntry } from "./tabs/ActivityTab";
import { AdminTab } from "./tabs/AdminTab";
import { TabBar } from "./components/TabBar";
import type { TabId } from "./components/TabBar";
import { ToastContainer } from "./components/Toast";
import { useToasts } from "./hooks/useToasts";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useSessionTimer } from "./hooks/useSessionTimer";
import { usePolling } from "./hooks/usePolling";
import {
  actionLabel,
  buildAssignRequest,
  buildEventRequest,
  errorMessage,
  getEventFormIssues,
  getAssignFormIssues,
  type AssignFormState,
  type EventFormState,
} from "./SmartApp.helpers";

type PendingAction = "login" | "logout" | "batch" | "scan" | "assign" | "event" | "merge" | "sync" | null;

type AuthState =
  | {
      status: "checking" | "authenticating";
      session: null;
      error: string | null;
    }
  | {
      status: "unauthenticated";
      session: null;
      error: string | null;
    }
  | {
      status: "authenticated";
      session: AuthSession;
      error: string | null;
    };

type SearchState = {
  query: string;
  results: PartType[];
  status: "idle" | "loading" | "error";
  error: string | null;
};

const defaultBatchForm: RegisterQrBatchRequest = {
  prefix: "QR",
  startNumber: 1001,
  count: 25,
};

const defaultAssignForm: AssignFormState = {
  qrCode: "",
  entityKind: "instance",
  location: "",
  notes: "",
  partTypeMode: "existing",
  existingPartTypeId: "",
  canonicalName: "",
  category: "",
  countable: true,
  unitSymbol: "pcs",
  initialStatus: "available",
  initialQuantity: "0",
  minimumQuantity: "",
};

const defaultEventForm: EventFormState = {
  targetType: "instance",
  targetId: "",
  event: "moved",
  location: "Unknown",
  quantityDelta: "",
  quantity: "",
  quantityIsInteger: true,
  assignee: "",
  notes: "",
};

const defaultSearchState: SearchState = {
  query: "",
  results: [],
  status: "idle",
  error: null,
};

export default function SmartApp() {
  const [authState, setAuthState] = useState<AuthState>({
    status: "checking",
    session: null,
    error: null,
  });
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [partDbStatus, setPartDbStatus] = useState<PartDbConnectionStatus | null>(null);
  const [partDbSyncStatus, setPartDbSyncStatus] = useState<PartDbSyncStatusResponse | null>(null);
  const [partDbSyncFailures, setPartDbSyncFailures] = useState<PartDbSyncFailure[]>([]);
  const [latestBatch, setLatestBatch] = useState<QrBatch | null>(null);
  const [catalogSuggestions, setCatalogSuggestions] = useState<PartType[]>([]);
  const [knownLocations, setKnownLocations] = useState<string[]>([]);
  const [inventorySummary, setInventorySummary] = useState<InventorySummaryRow[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [provisionalPartTypes, setProvisionalPartTypes] = useState<PartType[]>([]);
  const [labelSearch, setLabelSearch] = useState<SearchState>(defaultSearchState);
  const [mergeSearch, setMergeSearch] = useState<SearchState>(defaultSearchState);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [batchForm, setBatchForm] = useState(defaultBatchForm);
  const [assignForm, setAssignForm] = useState(defaultAssignForm);
  const [eventForm, setEventForm] = useState(defaultEventForm);
  const [scanCode, setScanCode] = useState("");
  const [scanMode, setScanModeRaw] = useState<"increment" | "inspect">(() => {
    try {
      return localStorage.getItem("smartdb:scanMode") === "inspect" ? "inspect" : "increment";
    } catch { return "increment"; }
  });
  const [incrementAmount, setIncrementAmountRaw] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem("smartdb:incrementAmount"));
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch { return 1; }
  });
  function setScanMode(mode: "increment" | "inspect"): void {
    setScanModeRaw(mode);
    try { localStorage.setItem("smartdb:scanMode", mode); } catch {}
  }
  function setIncrementAmount(amount: number): void {
    setIncrementAmountRaw(amount);
    try { localStorage.setItem("smartdb:incrementAmount", String(amount)); } catch {}
  }
  const [scanHistory, setScanHistory] = useState<ScanHistoryEntry[]>([]);
  const [lastAssignment, setLastAssignment] = useState<LastAssignment | null>(null);
  const [cameraLookupCode, setCameraLookupCode] = useState<string | null>(null);
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeDestinationId, setMergeDestinationId] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [downloadingBatchId, setDownloadingBatchId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("scan");
  const { toasts, addToast, dismissToast } = useToasts();
  const isOnline = useOnlineStatus();
  const sessionTimer = useSessionTimer(
    authState.status === "authenticated" ? authState.session.expiresAt : null,
  );
  const isAdmin =
    authState.status === "authenticated" &&
    hasSmartDbRole(authState.session.roles, smartDbRoles.admin);

  const scanInputRef = useRef<HTMLInputElement>(null);
  const scanResultRef = useRef<HTMLDivElement>(null);
  const labelSearchAbortRef = useRef<AbortController | null>(null);
  const mergeSearchAbortRef = useRef<AbortController | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);
  const labelSearchRequestRef = useRef(0);
  const mergeSearchRequestRef = useRef(0);
  const scanRequestRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void restoreSession(controller.signal, consumeAuthError());
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (authState.status === "authenticated") {
      scanInputRef.current?.focus();
    }
  }, [authState.status]);

  useEffect(() => {
    if (!isAdmin && activeTab === "admin") {
      setActiveTab("scan");
    }
  }, [activeTab, isAdmin]);

  useEffect(() => {
    if (scanResult && typeof scanResultRef.current?.scrollIntoView === "function") {
      scanResultRef.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    }
  }, [scanResult]);

  async function restoreSession(signal: AbortSignal, authError: string | null): Promise<void> {
    setAuthState({
      status: "checking",
      session: null,
      error: null,
    });
    try {
      const session = await api.getSession(signal);
      setAuthState({
        status: "authenticated",
        session,
        error: null,
      });
      if (authError) {
        addToast(authError, "error");
      }
      await loadAuthenticatedData(session);
    } catch (caught) {
      if (signal.aborted) {
        return;
      }
      const unauthenticated =
        caught instanceof ApiClientError && caught.code === "unauthenticated";
      setAuthState({
        status: "unauthenticated",
        session: null,
        error: authError ?? (unauthenticated ? null : errorMessage(caught)),
      });
    }
  }

  function resetAuthenticatedView(): void {
    setDashboard(null);
    setPartDbStatus(null);
    setPartDbSyncStatus(null);
    setPartDbSyncFailures([]);
    setLatestBatch(null);
    setCatalogSuggestions([]);
    setKnownLocations([]);
    setInventorySummary([]);
    setProvisionalPartTypes([]);
    setLabelSearch(defaultSearchState);
    setMergeSearch(defaultSearchState);
    setScanResult(null);
    setBatchForm(defaultBatchForm);
    setAssignForm(defaultAssignForm);
    setEventForm(defaultEventForm);
    setScanCode("");
    setScanHistory([]);
    setLastAssignment(null);
    setCameraLookupCode(null);
    setMergeSourceId("");
    setMergeDestinationId("");
    setPendingAction(null);
    setDownloadingBatchId(null);
    labelSearchAbortRef.current?.abort();
    mergeSearchAbortRef.current?.abort();
    scanAbortRef.current?.abort();
  }

  function handleAuthenticationFailure(caught: unknown): void {
    resetAuthenticatedView();
    setAuthState({
      status: "unauthenticated",
      session: null,
      error: errorMessage(caught),
    });
  }

  function handleApiFailure(caught: unknown): boolean {
    if (caught instanceof ApiClientError && caught.code === "unauthenticated") {
      handleAuthenticationFailure(caught);
      return true;
    }

    return false;
  }

  async function loadAuthenticatedData(sessionOverride?: AuthSession | null): Promise<void> {
    const activeSession =
      sessionOverride ??
      (authState.status === "authenticated" ? authState.session : null);
    const canAccessAdmin =
      activeSession !== null && hasSmartDbRole(activeSession.roles, smartDbRoles.admin);

    const [dashboardResult, partDbResult, syncStatusResult, syncFailuresResult, provisionalResult, partTypesResult, latestBatchResult, locationsResult, inventoryResult] =
      await Promise.allSettled([
        api.getDashboard(),
        api.getPartDbStatus(),
        canAccessAdmin ? api.getPartDbSyncStatus() : Promise.resolve(null),
        canAccessAdmin ? api.getPartDbSyncFailures() : Promise.resolve([]),
        canAccessAdmin ? api.getProvisionalPartTypes() : Promise.resolve([]),
        api.searchPartTypes(""),
        canAccessAdmin ? api.getLatestQrBatch() : Promise.resolve(null),
        api.getKnownLocations(),
        api.getInventorySummary(),
      ]);

    for (const result of [dashboardResult, partDbResult, syncStatusResult, syncFailuresResult, provisionalResult, partTypesResult, latestBatchResult, locationsResult, inventoryResult]) {
      if (result.status === "rejected" && handleApiFailure(result.reason)) {
        return;
      }
    }

    if (dashboardResult.status === "fulfilled") {
      setDashboard(dashboardResult.value);
    } else {
      // dashboard refresh failures are silent; the part-db pill conveys connectivity
    }

    if (locationsResult.status === "fulfilled") {
      setKnownLocations(locationsResult.value);
    }

    if (inventoryResult.status === "fulfilled") {
      setInventorySummary(inventoryResult.value);
    }

    if (partDbResult.status === "fulfilled") {
      setPartDbStatus(partDbResult.value);
    }

    if (syncStatusResult.status === "fulfilled") {
      setPartDbSyncStatus(syncStatusResult.value);
    }

    if (syncFailuresResult.status === "fulfilled") {
      setPartDbSyncFailures(syncFailuresResult.value);
    }

    if (latestBatchResult.status === "fulfilled") {
      const latestBatchValue = latestBatchResult.value;
      setLatestBatch(latestBatchValue);
      if (latestBatchValue) {
        setBatchForm((current) =>
          current.prefix === defaultBatchForm.prefix &&
          current.startNumber === defaultBatchForm.startNumber &&
          current.count === defaultBatchForm.count
            ? {
                ...current,
                prefix: latestBatchValue.prefix,
                startNumber: latestBatchValue.endNumber + 1,
              }
            : current,
        );
      }
    }

    if (provisionalResult.status === "fulfilled") {
      setProvisionalPartTypes(provisionalResult.value);
    }

    if (partTypesResult.status === "fulfilled") {
      const partTypes = partTypesResult.value;
      setCatalogSuggestions(partTypes);
      setMergeSearch((current) =>
        current.query
          ? current
          : {
              ...current,
              results: partTypes,
              status: "idle",
              error: null,
            },
      );
      setLabelSearch((current) =>
        current.query
          ? current
          : {
              ...current,
              results: partTypes,
              status: "idle",
              error: null,
            },
      );
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPendingAction("login");

    setAuthState({
      status: "authenticating",
      session: null,
      error: null,
    });

    if (typeof window !== "undefined") {
      window.location.assign(loginUrl(window.location.href));
    }
  }

  async function handleLogout(): Promise<void> {
    setPendingAction("logout");


    try {
      const response = await api.logout();
      if (typeof window !== "undefined" && response.redirectUrl) {
        window.location.assign(response.redirectUrl);
        return;
      }
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      resetAuthenticatedView();
      setAuthState({
        status: "unauthenticated",
        session: null,
        error: null,
      });
      setPendingAction(null);
    }
  }

  async function performSearch(
    surface: "label" | "merge",
    query: string,
  ): Promise<void> {
    const normalizedQuery = query;
    const requestRef =
      surface === "label" ? labelSearchRequestRef : mergeSearchRequestRef;
    const abortRef =
      surface === "label" ? labelSearchAbortRef : mergeSearchAbortRef;
    const setState = surface === "label" ? setLabelSearch : setMergeSearch;

    abortRef.current?.abort();
    requestRef.current += 1;
    const requestId = requestRef.current;

    if (!normalizedQuery.trim()) {
      setState({
        query: normalizedQuery,
        results: catalogSuggestions,
        status: "idle",
        error: null,
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setState((current) => ({
      ...current,
      query: normalizedQuery,
      status: "loading",
      error: null,
    }));

    try {
      const results = await api.searchPartTypes(normalizedQuery, controller.signal);
      if (requestId !== requestRef.current) {
        return;
      }

      setState({
        query: normalizedQuery,
        results,
        status: "idle",
        error: null,
      });
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }

      if (handleApiFailure(caught)) {
        return;
      }

      setState((current) => ({
        ...current,
        query: normalizedQuery,
        status: "error",
        error: errorMessage(caught),
      }));
      addToast(errorMessage(caught), "error");
    }
  }

  async function performScan(
    code: string,
    options: { silent?: boolean; source?: "manual" | "camera" } = {},
  ): Promise<void> {
    const { silent = false, source = "manual" } = options;
    scanAbortRef.current?.abort();
    scanRequestRef.current += 1;
    const requestId = scanRequestRef.current;
    const controller = new AbortController();
    scanAbortRef.current = controller;

    if (source === "camera") {
      setCameraLookupCode(code);
    }

    if (!silent) {
      setPendingAction("scan");
    }

    try {
      const scanOptions: { signal: AbortSignal; autoIncrement: boolean; incrementAmount?: number } = {
        signal: controller.signal,
        autoIncrement: scanMode === "increment",
      };
      if (scanMode === "increment") {
        scanOptions.incrementAmount = incrementAmount;
      }
      const response = await api.scan(code, scanOptions);
      if (requestId !== scanRequestRef.current) {
        return;
      }

      setScanResult(response);
      setScanHistory((prev) => [
        { code, mode: response.mode, timestamp: new Date().toISOString() },
        ...prev,
      ].slice(0, 20));
      if (response.mode === "label") {
        setAssignForm({
          ...defaultAssignForm,
          qrCode: response.qrCode.code,
        });
        setLabelSearch({
          query: "",
          results: response.suggestions,
          status: "idle",
          error: null,
        });
      }

      if (response.mode === "interact") {
        setEventForm(buildDefaultEventFormForEntity(response.entity));
        if (response.entity.targetType === "bulk" && (response as { autoIncremented?: boolean }).autoIncremented) {
          addToast(`+${incrementAmount} ${response.entity.partType.canonicalName} (now ${(response.entity as { quantity?: number }).quantity ?? "?"})`, "success");
        }
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }

      if (handleApiFailure(caught)) {
        return;
      }

      addToast(errorMessage(caught), "error");
    } finally {
      if (source === "camera" && requestId === scanRequestRef.current) {
        setCameraLookupCode(null);
      }
      if (!silent && requestId === scanRequestRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function handleRegisterBatch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPendingAction("batch");


    try {
      const response = await api.registerQrBatch(batchForm);
      addToast(
        `Registered ${response.created} QR codes${response.skipped ? ` (${response.skipped} duplicates skipped)` : ""}`,
        "success",
      );
      setLatestBatch(response.batch);
      setBatchForm((current) => ({
        ...current,
        prefix: response.batch.prefix,
        startNumber: response.batch.endNumber + 1,
      }));
      await loadAuthenticatedData();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDownloadLatestBatchLabels(): Promise<void> {
    if (!latestBatch) {
      return;
    }

    setDownloadingBatchId(latestBatch.id);
    try {
      await downloadQrBatchLabelsPdf(latestBatch.id);
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setDownloadingBatchId(null);
    }
  }

  async function handleDrainPartDbSync(): Promise<void> {
    setPendingAction("sync");
    try {
      const result = await api.drainPartDbSync();
      addToast(`Sync drained · ${result.delivered} delivered${result.failed ? `, ${result.failed} failed` : ""}`, result.failed ? "info" : "success");
      await loadAuthenticatedData();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleBackfillPartDbSync(): Promise<void> {
    setPendingAction("sync");
    try {
      const result = await api.backfillPartDbSync();
      addToast(
        `Backfill queued · ${result.queuedPartTypes} parts, ${result.queuedLots} lots`,
        "success",
      );
      await loadAuthenticatedData();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRetryPartDbSync(id: string): Promise<void> {
    setPendingAction("sync");
    try {
      await api.retryPartDbSync(id);
      addToast("Retry queued", "info");
      await loadAuthenticatedData();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleScan(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const code = scanCode.trim();
    if (!code) return;
    // Clear the input immediately so the next hardware-scanner value lands fresh.
    setScanCode("");
    await performScan(code);
    // Refocus so the wedge scanner keeps typing into the right field.
    scanInputRef.current?.focus();
  }

  async function handleCameraScan(code: string): Promise<void> {
    if (pendingAction !== null) {
      addToast("Finish the current action first", "error");
      return;
    }

    if (hasInProgressScanWork(scanResult, assignForm, labelSearch.query, eventForm)) {
      addToast("Clear the current scan first", "error");
      return;
    }

    // Skip the input — the result card shows what was scanned.
    // Keeping the input clean means the next wedge stroke starts fresh.
    await performScan(code, { source: "camera" });
  }

  function handleScanNext(): void {
    setCameraLookupCode(null);
    setScanCode("");
    setScanResult(null);
    setAssignForm(defaultAssignForm);
    setEventForm(defaultEventForm);
    setLabelSearch(defaultSearchState);
  }

  function handleRegisterUnknown(code: string): void {
    setScanResult({
      mode: "label",
      qrCode: {
        code,
        batchId: "external",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      suggestions: catalogSuggestions,
      partDb: { configured: false, connected: false, message: "" },
    });
    setAssignForm({
      ...defaultAssignForm,
      qrCode: code,
      entityKind: "bulk",
      countable: false,
      unitSymbol: "kg",
    });
    setLabelSearch({ query: "", results: catalogSuggestions, status: "idle", error: null });
  }

  async function handleAssign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPendingAction("assign");


    try {
      const request = buildAssignRequest(assignForm);
      const response = await api.assignQr(request);
      addToast(`${response.partType.canonicalName} assigned to ${request.qrCode}`, "success");
      setLastAssignment({
        partTypeName: response.partType.canonicalName,
        partTypeId: response.partType.id,
        location: response.location,
      });
      setAssignForm(defaultAssignForm);
      // Clear the scan input so the next hardware-wedge keystrokes start fresh.
      setScanCode("");
      await performScan(request.qrCode, { silent: true });
      // Re-clear in case performScan repopulated it.
      setScanCode("");
      await loadAuthenticatedData();
      scanInputRef.current?.focus();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleAssignSame(): Promise<void> {
    if (!lastAssignment || !scanResult || scanResult.mode !== "label") return;
    setPendingAction("assign");
    try {
      const request = buildAssignRequest({
        ...defaultAssignForm,
        qrCode: scanResult.qrCode.code,
        partTypeMode: "existing",
        existingPartTypeId: lastAssignment.partTypeId,
        location: lastAssignment.location,
      });
      const response = await api.assignQr(request);
      addToast(`${response.partType.canonicalName} assigned to ${request.qrCode}`, "success");
      setLastAssignment({
        partTypeName: response.partType.canonicalName,
        partTypeId: response.partType.id,
        location: response.location,
      });
      setAssignForm(defaultAssignForm);
      setScanCode("");
      await performScan(request.qrCode, { silent: true });
      setScanCode("");
      await loadAuthenticatedData();
      scanInputRef.current?.focus();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRecordEvent(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPendingAction("event");


    try {
      const request = buildEventRequest(eventForm);
      const response = await api.recordEvent(request);
      addToast(`${actionLabel(response.event)} recorded`, "success");
      if (scanResult?.mode === "interact") {
        await performScan(scanResult.qrCode.code, { silent: true });
      }
      await loadAuthenticatedData();
      scanInputRef.current?.focus();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function handleApprovePartType(id: string): Promise<void> {
    try {
      await api.approvePartType(id);
      addToast("Part type approved", "success");
      setMergeSourceId("");
      await loadAuthenticatedData();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    }
  }

  async function handleMergePartTypes(): Promise<void> {
    if (!mergeSourceId || !mergeDestinationId) {
      addToast("Pick a source and destination", "error");
      return;
    }

    if (!window.confirm("Merge this provisional type into the canonical record? This cannot be undone.")) {
      return;
    }

    setPendingAction("merge");


    try {
      await api.mergePartTypes({
        sourcePartTypeId: mergeSourceId,
        destinationPartTypeId: mergeDestinationId,
        aliasLabel: null,
      });
      addToast("Part types merged", "success");
      setMergeSourceId("");
      setMergeDestinationId("");
      await loadAuthenticatedData();
    } catch (caught) {
      if (!handleApiFailure(caught)) {
        addToast(errorMessage(caught), "error");
      }
    } finally {
      setPendingAction(null);
    }
  }

  const labelOptions =
    labelSearch.query.trim() || labelSearch.results.length > 0
      ? labelSearch.results
      : scanResult?.mode === "label"
        ? scanResult.suggestions
        : catalogSuggestions;

  const mergeOptions = mergeSearch.results.length > 0 ? mergeSearch.results : catalogSuggestions;
  const assignIssues = getAssignFormIssues(assignForm);
  const eventIssues = getEventFormIssues(eventForm);
  const cameraBlockedReason =
    pendingAction !== null
      ? "Finish the current action before scanning another item."
      : hasInProgressScanWork(scanResult, assignForm, labelSearch.query, eventForm)
        ? "Finish or clear the current scan form before scanning another item."
        : null;
  const partDbHealth = getPartDbHealthPill(partDbStatus);
  const partDbSync = isAdmin ? getPartDbSyncPill(partDbSyncStatus) : null;

  usePolling(
    () => void loadAuthenticatedData(),
    30_000,
    authState.status === "authenticated",
  );

  useEffect(() => {
    if (sessionTimer.isExpiringSoon) {
      addToast(
        `Session expires in ~${sessionTimer.minutesRemaining ?? 0} minutes.`,
        "error",
      );
    }
  }, [sessionTimer.isExpiringSoon]); // eslint-disable-line react-hooks/exhaustive-deps

  if (authState.status !== "authenticated") {
    return (
      <div className="shell">
        <header className="hero">
          <div>
            <p className="eyebrow">Smart DB</p>
            <h1>Sign In With Makerspace SSO</h1>
            <p className="lede">
              Smart DB authenticates through your Makerspace identity provider
              and keeps inventory credentials out of the browser.
            </p>
          </div>
          <div className="status-card">
            <div className="pill warn">Authentication Required</div>
            <p>
              You will be redirected to Zitadel and returned here with a secure
              session.
            </p>
          </div>
        </header>

        {authState.error ? <p className="banner error">{authState.error}</p> : null}
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />

        <section className="panel">
          <PanelTitle
            title="Makerspace Login"
            copy="Use your Makerspace SSO account. Smart DB uses a server-side session cookie instead of storing bearer tokens in the browser."
          />
          <div className="stack">
            <a
              className="button-link"
              href={typeof window === "undefined" ? loginUrl("http://localhost") : loginUrl(window.location.href)}
            >
              Continue With SSO
            </a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="header-bar">
        <strong className="header-brand">Smart DB</strong>
        <div className="header-status">
          <div className={`pill ${partDbHealth.tone}`}>{partDbHealth.label}</div>
          {partDbSync ? <div className={`pill ${partDbSync.tone}`}>{partDbSync.label}</div> : null}
          {authState.session.expiresAt ? (
            <small>Token/session expires at {authState.session.expiresAt}</small>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={pendingAction === "logout"}
        >
          {pendingAction === "logout" ? "Signing out..." : "Logout"}
        </button>
      </header>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {!isOnline && <p className="banner error">You appear to be offline.</p>}

      <section className="metrics">
        <Metric label="Part types" value={dashboard?.partTypeCount ?? 0} />
        <Metric label="Instances" value={dashboard?.instanceCount ?? 0} />
        <Metric label="Bulk bins" value={dashboard?.bulkStockCount ?? 0} />
        <Metric label="Provisional" value={dashboard?.provisionalCount ?? 0} />
        <Metric label="Unassigned QRs" value={dashboard?.unassignedQrCount ?? 0} />
      </section>

      <main className="layout">
        {activeTab === "scan" && (
          <section id="panel-scan" role="tabpanel" aria-labelledby="tab-scan">
            <ScanTab
              scanCode={scanCode}
              onScanCodeChange={setScanCode}
              scanMode={scanMode}
              onScanModeChange={setScanMode}
              incrementAmount={incrementAmount}
              onIncrementAmountChange={setIncrementAmount}
              scanInputRef={scanInputRef}
              scanResultRef={scanResultRef}
              scanResult={scanResult}
              pendingAction={pendingAction}
              onScan={handleScan}
              onCameraScan={(code) => void handleCameraScan(code)}
              onScanNext={handleScanNext}
              onRegisterUnknown={handleRegisterUnknown}
              cameraLookupCode={cameraLookupCode}
              cameraBlockedReason={cameraBlockedReason}
              labelSearch={labelSearch}
              labelOptions={labelOptions}
              fullPartTypeCatalog={catalogSuggestions}
              assignForm={assignForm}
              assignIssues={assignIssues}
              onAssignFormChange={setAssignForm}
              knownLocations={knownLocations}
              onLabelSearch={(query) => void performSearch("label", query)}
              onAssign={handleAssign}
              sessionUsername={authState.session.username}
              lastAssignment={lastAssignment}
              onAssignSame={() => void handleAssignSame()}
              eventForm={eventForm}
              eventIssues={eventIssues}
              onEventFormChange={setEventForm}
              onRecordEvent={handleRecordEvent}
            />
          </section>
        )}
        {activeTab === "inventory" && (
          <InventoryTab
            rows={inventorySummary}
            isLoading={inventoryLoading}
            onRefresh={async () => {
              setInventoryLoading(true);
              try {
                const next = await api.getInventorySummary();
                setInventorySummary(next);
              } catch (caught) {
                if (!handleApiFailure(caught)) {
                  addToast(errorMessage(caught), "error");
                }
              } finally {
                setInventoryLoading(false);
              }
            }}
          />
        )}

        {activeTab === "activity" && (
          <section id="panel-activity" role="tabpanel" aria-labelledby="tab-activity">
            <ActivityTab
              dashboard={dashboard}
              partDbStatus={partDbStatus}
              scanHistory={scanHistory}
            />
          </section>
        )}
        {isAdmin && activeTab === "admin" && (
          <section id="panel-admin" role="tabpanel" aria-labelledby="tab-admin">
            <AdminTab
              sessionUsername={authState.session.username}
              pendingAction={pendingAction}
              batchForm={batchForm}
              onBatchFormChange={setBatchForm}
              onRegisterBatch={handleRegisterBatch}
              latestBatch={latestBatch}
              isDownloadingLabels={downloadingBatchId === latestBatch?.id}
              onDownloadLabels={() => void handleDownloadLatestBatchLabels()}
              partDbSyncStatus={partDbSyncStatus}
              partDbSyncFailures={partDbSyncFailures}
              onDrainSync={() => void handleDrainPartDbSync()}
              onBackfillSync={() => void handleBackfillPartDbSync()}
              onRetrySync={(id) => void handleRetryPartDbSync(id)}
              provisionalPartTypes={provisionalPartTypes}
              mergeSourceId={mergeSourceId}
              onMergeSourceIdChange={setMergeSourceId}
              mergeDestinationId={mergeDestinationId}
              onMergeDestinationIdChange={setMergeDestinationId}
              mergeSearch={mergeSearch}
              mergeOptions={mergeOptions}
              onMergeSearch={(query) => void performSearch("merge", query)}
              onMerge={() => void handleMergePartTypes()}
              onApprovePartType={(id) => void handleApprovePartType(id)}
            />
          </section>
        )}
      </main>
      <TabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabs={isAdmin ? ["scan", "activity", "admin"] : ["scan", "activity"]}
      />
    </div>
  );
}

function getPartDbHealthPill(
  status: PartDbConnectionStatus | null,
): { tone: "ok" | "warn" | "info"; label: string } {
  if (status === null) {
    return { tone: "info", label: "Checking Part-DB" };
  }

  if (status.connected) {
    return { tone: "ok", label: "Part-DB linked" };
  }

  return { tone: "warn", label: "Part-DB degraded" };
}

function getPartDbSyncPill(
  status: PartDbSyncStatusResponse | null,
): { tone: "ok" | "warn" | "info"; label: string } | null {
  if (status === null) {
    return { tone: "info", label: "Checking sync" };
  }

  if (!status.enabled) {
    return { tone: "info", label: "Sync disabled" };
  }

  if (status.deadTotal > 0) {
    return { tone: "warn", label: "Sync dead letters" };
  }

  if (status.failedLast24h > 0) {
    return { tone: "warn", label: "Sync needs retry" };
  }

  if (status.pending > 0 || status.inFlight > 0) {
    return { tone: "info", label: `Syncing ${status.pending + status.inFlight}` };
  }

  return { tone: "ok", label: "Sync idle" };
}

function consumeAuthError(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  const authError = url.searchParams.get("authError");
  if (!authError) {
    return null;
  }

  url.searchParams.delete("authError");
  window.history.replaceState({}, "", url.toString());
  return authError;
}

function buildDefaultEventFormForEntity(
  entity: Extract<ScanResponse, { mode: "interact" }>["entity"],
): EventFormState {
  return {
    ...defaultEventForm,
    targetType: entity.targetType,
    targetId: entity.id,
    location: entity.location,
    quantity: entity.targetType === "bulk" && entity.quantity !== null ? String(entity.quantity) : "",
    quantityIsInteger: entity.partType.unit.isInteger,
  };
}

function hasInProgressScanWork(
  scanResult: ScanResponse | null,
  assignForm: AssignFormState,
  labelSearchQuery: string,
  eventForm: EventFormState,
): boolean {
  if (scanResult?.mode === "label") {
    const baselineAssignForm: AssignFormState = {
      ...defaultAssignForm,
      qrCode: scanResult.qrCode.code,
    };
    return (
      labelSearchQuery.trim().length > 0 ||
      JSON.stringify(assignForm) !== JSON.stringify(baselineAssignForm)
    );
  }

  if (scanResult?.mode === "interact") {
    return (
      JSON.stringify(eventForm) !==
      JSON.stringify(buildDefaultEventFormForEntity(scanResult.entity))
    );
  }

  return false;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
