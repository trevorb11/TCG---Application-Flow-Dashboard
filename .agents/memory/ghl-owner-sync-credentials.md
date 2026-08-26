---
name: GHL owner-sync credentials
description: Credential inconsistency affecting automatic GoHighLevel owner lookup and CLC rep synchronization.
---

Automatic GHL owner lookup must use a verified, working credential; do not assume the app's default GHL API credential and its separately configured private-token credential are interchangeable.

**Why:** The primary credential used by the owner-sync service returned an invalid-token response, while the alternate private-token credential successfully retrieved the same GHL contact and assigned user. A webhook can therefore succeed while the follow-on CLC rep assignment silently fails.

**How to apply:** When changing or debugging GHL ownership sync, verify contact and user lookups with the exact credential the service uses. Keep the production credential path canonical, log authentication failures distinctly from unassigned contacts, and preserve source/via attribution independently of the assigned rep fields.