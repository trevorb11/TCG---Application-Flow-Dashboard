---
name: Dev vs prod databases are separate
description: Production data access paths differ; the NEON_DATABASE_URL connection is the dialer DB, not the primary application DB.
---

Use the production-aware `executeSql` read path for verification and the deployed app's authenticated admin data API for production mutations. Do not use `NEON_DATABASE_URL` for primary application records; in this project it connects to the separate dialer database.

**Why:** A record verified through the production read path was absent when queried through `NEON_DATABASE_URL`; the deployed app's authenticated admin API found and mutated it successfully.

**How to apply:**
- For verification, explicitly select the production environment in the production-aware SQL callback.
- Production SQL through that callback is read-only; use the deployed app's authenticated admin mutation endpoint for narrowly scoped writes.
- Guard every production mutation with stable identifiers and expected values, and return the affected row.
- Treat `NEON_DATABASE_URL` as the separate dialer store unless current code proves otherwise.
