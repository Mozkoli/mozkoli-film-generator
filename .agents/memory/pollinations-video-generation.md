---
name: Pollinations video generation
description: Credit-impact behavior and response shape of Pollinations' video API.
---

Pollinations video generation consumes Pollen. The synchronous `GET /video/{prompt}` endpoint returns MP4 bytes rather than a stable direct player URL; the browser can create a blob URL after the response completes.

**Why:** A live generation test can spend the user's credits, so code verification should not trigger generation automatically.

**How to apply:** Keep clip generation behind an explicit user action. Test the server and player with mocked MP4 responses unless the user specifically asks for a live generated clip.
