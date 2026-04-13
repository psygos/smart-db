# Architecture

## Goal

Smart DB is the operational layer for makerspace inventory. It optimizes for fast intake and low-friction lifecycle updates while preserving a clean data model that can sync into Part-DB and authenticate people through Zitadel.

## Core Domain

### `PartType`

- Canonical record for a thing
- Owns name, category, aliases, notes, image, and `countable`
- Can be provisional until an admin merges or confirms it

### `PhysicalInstance`

- One labeled, discrete item
- Linked to exactly one QR code
- Tracks status and location
- Count is derived by counting available instances

### `BulkStock`

- One labeled bin, tray, or box for non-countable stock
- Linked to exactly one QR code
- Tracks location and coarse level (`full`, `good`, `low`, `empty`)

### `QRCode`

- Pre-registered sticker identity
- Exists before assignment
- Tracks batch, status, and assigned target

### `StockEvent`

- Append-only lifecycle log
- Represents labeling, movement, checkout, return, consumption, and bulk level changes
- Middleware updates the current state on the target record and stores the event for auditability

## Why the Middleware Exists

Part-DB is good at catalog and stock concepts, but it should not be the phone-first interaction surface for rapid backlog labeling. Smart DB middleware exists to:

- keep QR batch issuance explicit
- maintain event history
- own provisional naming and merge flows
- terminate Zitadel login and hold server-side sessions
- expose a narrow API for mobile intake
- isolate Part-DB integration behind a dedicated adapter

## Part-DB Integration Strategy

Smart DB does not guess undocumented write payloads. Instead it implements a connection seam that is ready for real integration once a target Part-DB instance is available.

Current middleware integration:

- validates a dedicated service token against `/api/tokens/current`
- fetches `/api/docs.json`
- discovers upstream resource paths for parts, part lots, and storage locations

Planned sync mapping:

- `PartType` maps to Part-DB `Part`
- `BulkStock` maps to Part-DB `PartLot` plus storage location
- `PhysicalInstance` stays native to Smart DB, with aggregate availability sync back into Part-DB

This keeps Smart DB honest: it owns per-instance reality, while Part-DB remains compatible with its existing aggregate inventory model.

## Identity Strategy

- Zitadel is the only human identity provider.
- Smart DB uses Authorization Code + PKCE through middleware routes and stores opaque session ids in secure cookies.
- The browser no longer stores Part-DB or Zitadel bearer tokens.
- Part-DB is accessed only through a middleware-side service token for status and future sync operations.

## Repository Layout

- `apps/frontend`
  - vanilla TypeScript/HTML/CSS app aimed at phone use in the lab
  - handles scan, assign, event logging, and provisional merge
- `apps/middleware`
  - Fastify API
  - SQLite persistence using Node's built-in `node:sqlite`
  - Part-DB adapter and connection discovery
- `packages/contracts`
  - shared TypeScript contracts and enums

## Persistence Choice

SQLite is the right first move here:

- single-file local persistence
- no infra dependency
- enough structure to keep the domain honest
- easy later move to Postgres once concurrency or deployment needs demand it

## First Working Slice

1. Register QR batches
2. Scan a registered QR
3. Assign it to an instance or bulk bin
4. Create or reuse a part type
5. Log lifecycle events on later scans
6. Merge provisional part types into canonicals
