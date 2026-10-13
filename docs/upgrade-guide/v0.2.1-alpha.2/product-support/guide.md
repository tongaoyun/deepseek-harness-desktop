---
kind: upgrade-guide
description: "Product desktop support configuration and feedback HTTP requirements change, and desktop execution audit endpoints are removed."
---

# Product Device and Feedback Support

English | [中文](guide.zh.md)

## Change

Product desktop assemblies require a `support` object in `product.json`. Employee authentication starts device capability reports and presence heartbeats. Feedback submissions require a UUID `Idempotency-Key`; administrator feedback updates require `expectedUpdatedAt`. Device overview responses include server pagination and separate presence and capability timestamps. Desktop execution audit endpoints are removed. Official Session history remains local.

## Migration

1. Upgrade the product server first and apply its database migrations. Existing feedback and device reports remain available; historical internal knowledge-operation audit data is retained.
2. Add `"support": { "heartbeatIntervalMs": 300000, "reportIntervalMs": 86400000 }` to the product assembly's `product.json`. The heartbeat range is 60,000–3,600,000 milliseconds; full reports must be no more frequent than heartbeats and no less frequent than daily. See [the desktop package](../../../../packages/deepseek-harness-product/desktop/README.md#device-and-feedback).
3. Update feedback callers to retain a UUID per unchanged submission and provide the last read `updatedAt` as `expectedUpdatedAt` when revising administrator state. On HTTP 409, read the current feedback and review it before retrying with the new timestamp.
4. Remove external `/api/v1/audit-events` and `/api/v1/admin/audit-events` callers. Update device overview callers for `page`, `size`, `matchedDevices`, `totalPages` and `capabilitiesReportedAt`.
5. Rebuild the product assembly, authenticate, and confirm the console lists its device. Submit feedback from the desktop settings menu and confirm its receipt appears in the console. The official assembly requires no product configuration.
