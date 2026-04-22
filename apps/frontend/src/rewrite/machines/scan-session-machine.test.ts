import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { scanSessionMachine } from "./scan-session-machine";
import type { RewriteFailure } from "../errors";

const lookupFailure: RewriteFailure = {
  kind: "transport",
  operation: "scan.lookup",
  reason: "network",
  message: "Network unavailable.",
  retryability: "safe",
  details: {
    endpoint: "/api/scan",
  },
};

describe("scanSessionMachine", () => {
  it("moves from lookup to unknown and then into labeling for ad-hoc intake", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({
      type: "LOOKUP.REQUESTED",
      code: "EXT-001",
      source: "camera",
    });
    expect(actor.getSnapshot().value).toBe("lookingUp");

    actor.send({ type: "LOOKUP.UNKNOWN", code: "EXT-001" });
    expect(actor.getSnapshot().value).toBe("unknown");

    actor.send({ type: "UNKNOWN.PROMOTED_TO_INTAKE" });
    expect(actor.getSnapshot().value).toEqual({ labeling: "editing" });
    expect(actor.getSnapshot().context.lookup).toEqual({
      mode: "label",
      qrCode: "EXT-001",
    });
  });

  it("keeps assignment success inside the machine as an explicit transition", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({
      type: "LOOKUP.REQUESTED",
      code: "QR-1001",
      source: "manual",
    });
    actor.send({ type: "LOOKUP.LABEL", qrCode: "QR-1001" });
    actor.send({ type: "ASSIGN.PARSE_REQUESTED" });
    actor.send({ type: "ASSIGN.SUBMIT_REQUESTED" });
    actor.send({
      type: "ASSIGN.SUCCEEDED",
      targetType: "instance",
      qrCode: "QR-1001",
      targetId: "instance-1",
      lastAssignment: {
        partTypeId: "part-1",
        partTypeName: "Arduino Uno R3",
        location: "Shelf A",
      },
    });

    expect(actor.getSnapshot().value).toEqual({ interacting: "instanceReady" });
    expect(actor.getSnapshot().context.lastAssignment?.partTypeName).toBe("Arduino Uno R3");
  });

  it("models bulk split as a distinct subflow instead of overloading generic event submission", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({
      type: "LOOKUP.REQUESTED",
      code: "EXT-002",
      source: "camera",
    });
    actor.send({
      type: "LOOKUP.BULK",
      qrCode: "EXT-002",
      targetId: "bulk-1",
    });
    expect(actor.getSnapshot().value).toEqual({ interacting: "bulkReady" });

    actor.send({ type: "SPLIT.PARSE_REQUESTED" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "bulkSplitParsing" });

    actor.send({ type: "SPLIT.SUBMIT_REQUESTED" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "bulkSplitSubmitting" });

    actor.send({
      type: "SPLIT.SUCCEEDED",
      qrCode: "EXT-002",
      targetId: "bulk-1",
    });
    expect(actor.getSnapshot().value).toEqual({ interacting: "bulkReady" });
  });

  it("captures lookup failures explicitly and allows the next scan to reset the session", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({
      type: "LOOKUP.REQUESTED",
      code: "QR-404",
      source: "manual",
    });
    actor.send({
      type: "LOOKUP.FAILED",
      failure: lookupFailure,
    });
    expect(actor.getSnapshot().value).toEqual({ failure: "lookup" });

    actor.send({
      type: "LOOKUP.REQUESTED",
      code: "QR-2001",
      source: "manual",
    });
    expect(actor.getSnapshot().value).toBe("lookingUp");
    expect(actor.getSnapshot().context.failure).toBeNull();
  });

  it("tracks edit transitions for an instance interact session", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({ type: "LOOKUP.REQUESTED", code: "QR-5000", source: "manual" });
    actor.send({ type: "LOOKUP.INSTANCE", qrCode: "QR-5000", targetId: "instance-5000" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "instanceReady" });

    actor.send({ type: "EDIT.OPEN", editKind: "reassign" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "instanceEditing" });

    actor.send({ type: "EDIT.SUBMIT_REQUESTED" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "instanceEditSubmitting" });

    actor.send({ type: "EDIT.SUCCEEDED", editKind: "reassign" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "instanceReady" });
  });

  it("routes an edit failure to the failure.edit substate without losing the active lookup", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({ type: "LOOKUP.REQUESTED", code: "QR-5001", source: "manual" });
    actor.send({ type: "LOOKUP.BULK", qrCode: "QR-5001", targetId: "bulk-5001" });
    actor.send({ type: "EDIT.OPEN", editKind: "editShared" });
    actor.send({ type: "EDIT.SUBMIT_REQUESTED" });
    actor.send({
      type: "EDIT.FAILED",
      failure: {
        kind: "conflict",
        operation: "correction.editPartTypeDefinition",
        code: "shared_type_conflict",
        message: "A matching part type exists.",
        retryability: "after-user-action",
        details: {},
      },
    });

    expect(actor.getSnapshot().value).toEqual({ failure: "edit" });
    expect(actor.getSnapshot().context.lookup).toEqual({
      mode: "bulk",
      qrCode: "QR-5001",
      targetId: "bulk-5001",
    });
  });

  it("closes an open edit panel and returns to the ready state", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({ type: "LOOKUP.REQUESTED", code: "QR-5002", source: "manual" });
    actor.send({ type: "LOOKUP.INSTANCE", qrCode: "QR-5002", targetId: "instance-5002" });
    actor.send({ type: "EDIT.OPEN", editKind: "reassign" });
    actor.send({ type: "EDIT.CLOSE" });
    expect(actor.getSnapshot().value).toEqual({ interacting: "instanceReady" });
  });

  it("retains the failure origin for assignment failures so recovery can be specific", () => {
    const actor = createActor(scanSessionMachine).start();

    actor.send({
      type: "LOOKUP.REQUESTED",
      code: "QR-3001",
      source: "manual",
    });
    actor.send({ type: "LOOKUP.LABEL", qrCode: "QR-3001" });
    actor.send({ type: "ASSIGN.PARSE_REQUESTED" });
    actor.send({ type: "ASSIGN.SUBMIT_REQUESTED" });
    actor.send({
      type: "ASSIGN.FAILED",
      failure: {
        kind: "conflict",
        operation: "scan.assign",
        code: "already_assigned",
        message: "QR is already assigned.",
        retryability: "after-user-action",
        details: {
          targetId: "instance-7",
        },
      },
    });

    expect(actor.getSnapshot().value).toEqual({ failure: "assign" });
    expect(actor.getSnapshot().context.lookup).toEqual({
      mode: "label",
      qrCode: "QR-3001",
    });
  });
});
