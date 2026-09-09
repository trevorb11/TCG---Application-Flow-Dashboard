---
name: Underwriting Gmail delivery confirmation
description: Covers a deployment-only Gmail connector discovery failure that can masquerade as a successful underwriting submission.
---

The Gmail authorization can report healthy at the workspace level while the deployed connector lookup returns no account item. Treat these as separate states; a healthy OAuth status does not prove the deployment can discover the connection.

**Why:** An underwriting email with application and statement attachments failed because deployment connector settings were absent. The Gmail helper returned `false`, but its caller ignored that result, logged success, and stamped the underwriting submission timestamp.

**How to apply:** Require a confirmed Gmail send result before recording or displaying email success. Leave failed sends pending for retry, and verify a resend using the provider's returned message ID rather than a wrapper log.