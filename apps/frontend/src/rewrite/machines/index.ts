import { authMachine } from "./auth-machine";
import { bulkQueueMachine } from "./bulk-queue-machine";
import { scanSessionMachine } from "./scan-session-machine";

export const implementedRewriteMachines = {
  auth: authMachine,
  bulkQueue: bulkQueueMachine,
  scanSession: scanSessionMachine,
} as const;
