import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  AuthSession,
  BulkLevel,
  DashboardSummary,
  InstanceStatus,
  PartDbConnectionStatus,
  PartType,
  RegisterQrBatchRequest,
  ScanResponse,
} from "@smart-db/contracts";
import {
  ApiClientError,
  api,
  loginUrl,
} from "./api";
import { PanelTitle } from "./components/PanelTitle";
import { Metric } from "./components/Metric";
import { ScanTab, type LastAssignment } from "./tabs/ScanTab";
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
  buildAssignRequest,
  buildEventRequest,
  errorMessage,
  type AssignFormState,
  type EventFormState,
} from "./SmartApp.helpers";

type PendingAction = "login" | "logout" | "batch" | "scan" | "assign" | "event" | "merge" | null;

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
  count: 500,
};

const defaultAssignForm: AssignFormState = {
  qrCode: "",
  entityKind: "instance",
  location: "Buffer Room A",
  notes: "",
  partTypeMode: "new",
  existingPartTypeId: "",
  canonicalName: "",
  category: "",
  countable: true,
  initialStatus: "available",
  initialLevel: "good",
};

const defaultEventForm: EventFormState = {
  targetType: "instance",
  targetId: "",
  event: "moved",
  location: "Unknown",
  nextStatus: "available",
  nextLevel: "good",
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
  const [catalogSuggestions, setCatalogSuggestions] = useState<PartType[]>([]);
  const [provisionalPartTypes, setProvisionalPartTypes] = useState<PartType[]>([]);
  const [labelSearch, setLabelSearch] = useState<SearchState>(defaultSearchState);
  const [mergeSearch, setMergeSearch] = useState<SearchState>(defaultSearchState);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [batchForm, setBatchForm] = useState(defaultBatchForm);
  const [assignForm, setAssignForm] = useState(defaultAssignForm);
  const [eventForm, setEventForm] = useState(defaultEventForm);
  const [scanCode, setScanCode] = useState("");
  const [scanHistory, setScanHistory] = useState<ScanHistoryEntry[]>([]);
  const [lastAssignment, setLastAssignment] = useState<LastAssignment | null>(null);
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeDestinationId, setMergeDestinationId] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [activeTab, setActiveTab] = useState<TabId>("scan");
  const { toasts, addToast, dismissToast } = useToasts();
  const isOnline = useOnlineStatus();
  const sessionTimer = useSessionTimer(
    authState.status === "authenticated" ? authState.session.expiresAt : null,
  );

  const scanInputRef = useRef<HTMLInputElement>(null);
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
      await loadAuthenticatedData();
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
    setCatalogSuggestions([]);
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
    setMergeSourceId("");
    setMergeDestinationId("");
    setPendingAction(null);
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

  async function loadAuthenticatedData(): Promise<void> {
    const [dashboardResult, partDbResult, provisionalResult, partTypesResult] =
      await Promise.allSettled([
        api.getDashboard(),
        api.getPartDbStatus(),
        api.getProvisionalPartTypes(),
        api.searchPartTypes(""),
      ]);

    for (const result of [dashboardResult, partDbResult, provisionalResult, partTypesResult]) {
      if (result.status === "rejected" && handleApiFailure(result.reason)) {
        return;
      }
    }

    if (dashboardResult.status === "fulfilled") {
      setDashboard(dashboardResult.value);
    } else {
      addToast(errorMessage(dashboardResult.reason), "error");
    }

    if (partDbResult.status === "fulfilled") {
      setPartDbStatus(partDbResult.value);
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

  async function performScan(code: string, silent = false): Promise<void> {
    scanAbortRef.current?.abort();
    scanRequestRef.current += 1;
    const requestId = scanRequestRef.current;
    const controller = new AbortController();
    scanAbortRef.current = controller;

    if (!silent) {
      setPendingAction("scan");
    }

    try {
      const response = await api.scan(code, controller.signal);
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
        setEventForm({
          ...defaultEventForm,
          targetType: response.entity.targetType,
          targetId: response.entity.id,
          location: response.entity.location,
          nextStatus:
            response.entity.targetType === "instance"
              ? (response.entity.state as InstanceStatus)
              : defaultEventForm.nextStatus,
          nextLevel:
            response.entity.targetType === "bulk"
              ? (response.entity.state as BulkLevel)
              : defaultEventForm.nextLevel,
        });
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
        `Registered ${response.created} QR codes in ${response.batch.id}. ${response.skipped} were already present.`,
        "success",
      );
      setBatchForm((current) => ({
        ...current,
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

  async function handleScan(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await performScan(scanCode);
  }

  async function handleAssign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPendingAction("assign");


    try {
      const request = buildAssignRequest(assignForm);
      const response = await api.assignQr(request);
      addToast(`Assigned ${request.qrCode} to inventory.`, "success");
      setLastAssignment({
        partTypeName: response.partType.canonicalName,
        partTypeId: response.partType.id,
        location: response.location,
      });
      setAssignForm(defaultAssignForm);
      setScanCode(request.qrCode);
      await performScan(request.qrCode, true);
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
      addToast(`Assigned ${request.qrCode} to inventory.`, "success");
      setLastAssignment({
        partTypeName: response.partType.canonicalName,
        partTypeId: response.partType.id,
        location: response.location,
      });
      setAssignForm(defaultAssignForm);
      setScanCode(request.qrCode);
      await performScan(request.qrCode, true);
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
      addToast(`Logged ${response.event} for ${request.targetType} ${request.targetId}.`, "success");
      if (scanResult?.mode === "interact") {
        await performScan(scanResult.qrCode.code, true);
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
      addToast("Approved provisional part type.", "success");
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
      addToast("Select both a provisional source and a canonical destination.", "error");
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
      });
      addToast("Merged provisional part type into canonical record.", "success");
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
          <div className={`pill ${partDbStatus?.connected ? "ok" : "warn"}`}>
            {partDbStatus?.connected ? "Part-DB linked" : "Part-DB degraded"}
          </div>
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
          <ScanTab
            scanCode={scanCode}
            onScanCodeChange={setScanCode}
            scanInputRef={scanInputRef}
            scanResult={scanResult}
            pendingAction={pendingAction}
            onScan={handleScan}
            onCameraScan={(code) => void performScan(code)}
            labelSearch={labelSearch}
            labelOptions={labelOptions}
            assignForm={assignForm}
            onAssignFormChange={setAssignForm}
            onLabelSearch={(query) => void performSearch("label", query)}
            onAssign={handleAssign}
            sessionUsername={authState.session.username}
            lastAssignment={lastAssignment}
            onAssignSame={() => void handleAssignSame()}
            eventForm={eventForm}
            onEventFormChange={setEventForm}
            onRecordEvent={handleRecordEvent}
          />
        )}
        {activeTab === "activity" && (
          <ActivityTab
            dashboard={dashboard}
            partDbStatus={partDbStatus}
            scanHistory={scanHistory}
          />
        )}
        {activeTab === "admin" && (
          <AdminTab
            sessionUsername={authState.session.username}
            pendingAction={pendingAction}
            batchForm={batchForm}
            onBatchFormChange={setBatchForm}
            onRegisterBatch={handleRegisterBatch}
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
        )}
      </main>
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
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
