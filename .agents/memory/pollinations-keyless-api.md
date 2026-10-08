---
name: Pollinations keyless text API
description: Provider migration and availability caveat for apps that must use Pollinations text generation without credentials.
---

As of 2026-10-08, Pollinations' current `gen.pollinations.ai` text API returned HTTP 401 without an API key. Its legacy text model list still advertised `openai-fast` as anonymous, but requests to `text.pollinations.ai` with that model returned HTTP 500 (`ENOSPC`). The legacy route may therefore satisfy a no-key constraint when healthy, but is not guaranteed to be available.

**Why:** The user requested Pollinations generation without an API key, and the documented new API and observed legacy route behaved differently.

**How to apply:** Verify the anonymous legacy route at build time and distinguish upstream failures from app errors. Do not claim generation works until a live generation request succeeds. Only migrate to the authenticated API after the user chooses that option; request credentials through the secure secrets flow, never in chat.
