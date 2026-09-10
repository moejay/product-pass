# Product Pass

A local-first Chrome and Firefox extension for capturing review annotations, organizing them into editable issue drafts, and publishing accepted drafts to GitHub.

[![Get Product Pass for Firefox](https://moejay.github.io/product-pass/firefox-addons-badge.svg)](https://addons.mozilla.org/firefox/addon/product-pass/)

## MVP features

- One active review session shared across tabs and page navigation; multiple saved sessions that can be finished, reopened, or permanently deleted.
- Element-boundary and freehand annotations with optional text and a locally stored cropped screenshot when browser capture is available; bounded no-audio WebM screen recordings with timestamped notes.
- Saved overlays re-applied on an exact URL after reload and SPA navigation, with a default-on visibility toggle and clickable numbered markers that open the matching sidebar note.
- Codex subscription organization by default, with OpenAI-compatible API override and deterministic local grouping when AI is unavailable.
- Collapsible capture and review/publish workflows with editable issue title/body, live plain-text Markdown preview, local image/video evidence playback, source-note evidence, and accept/skip decisions.
- Direct GitHub REST issue creation only after accepting a draft and confirming publish, defaulting to Product Pass OAuth Device Flow with repository autocomplete and a fine-grained PAT override.
- Shared TypeScript source with browser-specific Manifest V3 builds.

Voice annotations, audio recording, a backend, and generic provider frameworks are intentionally excluded. Images and videos stay local unless a draft explicitly opts into experimental GitHub attachment upload. ChatGPT Plus/Pro Codex subscription support is an **experimental sideload-only compatibility feature**; see the risk and protocol pin below.

## Build and test

Requires Node.js 20+ and npm.

```sh
npm install
npm run check
```

Build output:

- `dist/chrome`
- `dist/firefox`

Create store and source archives with checksums:

```sh
npm run package
```

Release output is written to `release/`. Public product, privacy, support, terms, and security pages live at [moejay.github.io/product-pass](https://moejay.github.io/product-pass/).

For development, rerun `npm run build` after source changes and reload the extension.

## Load in Chrome

1. Build the extension.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `dist/chrome`.
5. Pin Product Pass if desired, then click its toolbar action to open the side panel.

Chrome 116+ is supported (the minimum version that supports opening the side panel from the toolbar action).

## Load in Firefox

1. Build the extension.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `dist/firefox/manifest.json`.
5. Click the Product Pass toolbar action. Standard Firefox also exposes it through **View → Sidebar** or the sidebar selector.

### Zen Browser

Zen may hide Firefox's standard extension-sidebar picker. Pin Product Pass from the Extensions menu, then click its toolbar icon; Product Pass calls Firefox's `sidebarAction.open()` directly. If Zen rejects that API, the same action falls back to opening the sidebar UI in a normal extension tab.

Temporary add-ons are removed when Firefox closes. For persistent local installation, sign/package the Firefox output through Mozilla's normal extension workflow. Firefox 140+ desktop is supported. This baseline covers Manifest V3 optional host permissions and Firefox's built-in data-consent declaration.

## Use

1. Create a review session in the sidebar.
2. On a regular HTTP(S) page, choose **Enable on this site**. This requests access only for that origin.
3. Start an element or freehand capture, finish it on the page, and enter optional context in the page prompt. Canceling the prompt discards that capture. Product Pass attempts to capture and crop the visible selected boundary locally.
4. Capture more notes across tabs/pages, or choose **Record screen**, select a surface, and add timestamped notes while recording. Recordings stop at 60 seconds or 100 MiB. Metadata persists in `storage.local`; media blobs remain in IndexedDB.
5. Choose **Organize notes**. With no AI key, notes are grouped locally by hostname. With AI configured, review the disclosure before sending.
6. Edit drafts and explicitly mark those to publish as **Accepted**.
7. Connect GitHub OAuth (public repositories by default, or explicitly request the broader private-repository scope), choose a repository, and publish each accepted issue only after the per-issue confirmation. Each draft has a default-off option to upload its source media. A fine-grained PAT remains available as an override.

Recommended PAT scope: access only to the chosen repository, with **Metadata: read** and **Issues: read/write**.

## GitHub OAuth Device Flow setup

Product Pass bundles the public OAuth client ID `Ov23lifwCRsz0PsjTzhA` for **Product Pass by DOTDEV** and never uses or stores a client secret. In Setup, choose either **Public repositories only** (`public_repo`, the default) or **Public and private repositories** (`repo`, a substantially broader OAuth scope), then choose **Connect**. Open GitHub's verification URL, enter the displayed code, authorize, and select an accessible repository from autocomplete. Product Pass honors GitHub's polling interval, `slow_down`, cancellation, and code expiry across MV3 worker suspension.

A fine-grained PAT remains available in Settings for users who prefer repository-scoped credentials. OAuth and PAT tokens persist in extension `storage.local`, which is not hardware-backed. Disconnecting removes local OAuth credentials and pending state; revoke provider-side access under GitHub **Settings → Applications → Authorized OAuth Apps**.

Upgrading from the former Product Pass GitHub App removes its obsolete local token, pending flow, and alarm. It cannot revoke provider-side access: remove the old authorization under **Authorized GitHub Apps** and uninstall it under **Installed GitHub Apps** in GitHub Settings.

### Experimental GitHub media uploads

Media upload is default-off per draft and uses `POST https://uploads.github.com/user-attachments/assets`, the endpoint used by GitHub CLI v2.99.0. It is not a documented public REST/GraphQL contract and may change, reject browser CORS, or vary by account plan. Product Pass accepts only its JPEG screenshots (10 MiB maximum) and WebM recordings (100 MiB client maximum), then inserts GitHub's returned asset URLs into the issue.

Successful asset URLs are saved on the draft and reused after later failures. Upload stops at the first failure and does not create the issue. GitHub provides no attachment delete or idempotency API: a network or malformed-response failure may leave an unreconcilable orphaned upload. Local previews work independently of upload.

## Experimental Codex subscription setup and protocol pin

OpenAI has [publicly encouraged using ChatGPT accounts in third-party tools](https://x.com/thsottiaux/status/2058071172361998482). Product Pass is nevertheless an independent, experimental integration and is not endorsed or supported by OpenAI. It reuses the public Codex CLI OAuth client identifier and ChatGPT Codex backend behavior; OpenAI may restrict or change either without notice.

The implementation is pinned to official `openai/codex` commit [`ad8ee16a5f4c7445253b57a10cb1f8489c8c3e6a`](https://github.com/openai/codex/tree/ad8ee16a5f4c7445253b57a10cb1f8489c8c3e6a), inspected 2026-09-03:

- `codex-rs/login/src/device_code_auth.rs`: JSON `POST /api/accounts/deviceauth/usercode` with public client ID; fixed verification URL `/codex/device`; JSON polling at `/api/accounts/deviceauth/token`; 403/404 pending; 15-minute bound; returned authorization code and PKCE verifier/challenge; callback `/deviceauth/callback`.
- `codex-rs/login/src/server.rs`: form authorization-code exchange at `/oauth/token`.
- `codex-rs/login/src/auth/manager.rs` and `token_data.rs`: JSON refresh grant, rotation, JWT `exp`, and `https://api.openai.com/auth.chatgpt_account_id` routing claim.
- `codex-rs/model-provider-info/src/lib.rs`, `codex-rs/codex-api/src/endpoint/responses.rs`, and `sse/responses.rs`: `https://chatgpt.com/backend-api/codex/responses`, `stream:true`, SSE deltas, and terminal completion.

To use it, select **EXPERIMENTAL — ChatGPT Plus/Pro Codex subscription**, save settings, grant runtime access only to `auth.openai.com` and `chatgpt.com`, then choose **Connect experimental Codex**. Open the exact verification page and enter the displayed code. An organization administrator may need to enable Codex device login.

The separate Codex model setting defaults best-effort to `gpt-5.4`, which appears in the pinned source's current SDK examples but is not dynamically discovered or guaranteed for an account. Enter a model available to the signed-in account if the backend rejects it. Product Pass does not fake a model catalog.

The request is background-only, streaming SSE, and locally validates strict JSON plus complete one-time assignment of every note. It retries one 401 only after serialized refresh-token rotation. It never reads ChatGPT cookies, uses a client secret, or sends tokens through a backend. The device flow and Codex endpoint can still fail because browser CORS/distribution compatibility is not an OpenAI-supported contract.

## Settings and privacy

- Sessions, vector geometry, note text, draft text, enabled origins, and non-secret settings use browser `storage.local`.
- Settings, AI keys, GitHub PATs, GitHub OAuth tokens, and experimental Codex access/refresh/ID tokens persist in extension `storage.local`; they are not returned to content scripts or shown after saving. Legacy `storage.session` credentials are migrated automatically.
- Pending GitHub and Codex device flows store bounded device authorization metadata, public user code/verification URL, next poll, and expiry in `storage.local` so MV3 worker suspension does not lose polling. Metadata is deleted on completion, cancellation, or expiry. No client secret/private key is used or stored.
- The extension has no backend or telemetry.
- Site access is optional and requested per origin. Custom AI endpoint access is requested when settings are saved. Device flows request only the exact GitHub origins or `https://auth.openai.com/*` and `https://chatgpt.com/*` at runtime from extension contexts; tokens never enter content scripts, page DOM, issue text, AI prompts, URLs, or logs.
- AI requests occur only after **Organize** confirmation. They contain note IDs/text (including timestamp text), annotation type, compact context label, page title, and sanitized URL. URL credentials, query, and fragment are removed. No screenshot/video blobs, full DOM, selectors, cookies, browsing history, or GitHub credential are sent.
- Every generated issue body receives a structured **Source evidence** section with page title, sanitized URL, annotation type, element/context label, CSS selector for selected elements, and recording timestamps where applicable.
- Cropped JPEG screenshots and bounded WebM recordings are stored in extension IndexedDB and previewed locally. Per-draft media upload is off by default. When explicitly enabled and confirmed, Product Pass uploads source media directly to GitHub and appends returned URLs to the issue body.
- Prefer public-only OAuth or a least-privilege fine-grained PAT; private-repository OAuth uses GitHub's broader `repo` scope. Extension `storage.local` is not hardware-backed secret storage; credentials remain available until disconnected/cleared and are not protected from a compromised browser profile/device.
- A custom AI endpoint sees the selected note data. Verify that provider's privacy and retention terms before configuring it.

## Architecture

- `src/sidebar`: sole extension UI and permission prompts.
- `src/background`: authoritative state mutations, session credential access, AI requests, and GitHub requests.
- `src/content`: idempotent Shadow DOM overlay, element/freehand capture, and exact-URL annotation rendering.
- `src/shared`: models, RPC messages, browser alias, and tested pure validation/grouping helpers.
- `build.mjs`: bundles the same code with esbuild and copies separate Chrome/Firefox manifests.
- `docs`: GitHub Pages landing, privacy, support, terms, and security pages.
- `store`: listing copy, privacy disclosures, reviewer notes, and release checklist.
- `scripts/package.mjs`: creates Chrome, Firefox, and Firefox-review source archives plus SHA-256 checksums.

The background stores the complete small MVP state as one serialized `storage.local` value and serializes mutations to avoid lost updates. Content scripts never receive credentials. AI output can only create local drafts; it has no publishing capability. Unknown GitHub outcomes are reconciled by a stable hidden marker before another create request.

## Known limitations

- Top-level HTTP(S) pages only. Browser pages, extension stores, PDFs, local files, and cross-origin iframe contents are unsupported. Browser host permissions apply to all ports on an enabled hostname, while Product Pass still tracks enabled page origins by their exact port.
- Only one globally active session and one capture at a time. No sync/collaboration or incognito support.
- Exact URL identity includes query and fragment for local overlay matching, while displayed/transmitted URLs omit both. Dynamic routes can therefore create separate local page identities.
- Element selectors can become orphaned after DOM changes. Freehand vectors use document coordinates and can drift after responsive reflow or layout changes.
- Screenshot capture covers only the currently visible viewport and may be unavailable on restricted pages, inactive tabs, or when browser capture permission fails. Screen recording always shows the browser surface chooser, records no audio, and is canceled if the sidebar closes.
- IndexedDB/storage quota varies. Recordings are bounded to 60 seconds and 100 MiB, but repeated recordings can still exhaust local quota.
- Manual note reassignment, issue merge/split, labels, assignees, and bulk publication are not included. Codex streaming has a 90-second request bound but no separate in-progress cancel button.
- Experimental Codex compatibility is pinned, not dynamically versioned. A future Codex protocol/client/backend change requires source review and a new explicit pin before release.
- GitHub repository discovery is bounded to the first 100 repositories; larger accounts require manual `owner/repository` entry or future pagination.
- GitHub OAuth sign-out deletes the local token but does not revoke it provider-side; revoke access in GitHub Settings when needed.
- Markdown preview is intentionally basic and does not implement GitHub-flavored rendering.
- GitHub has no issue-create idempotency key. Marker reconciliation checks the latest 100 issues and reduces, but cannot eliminate, duplicate risk.
- A release still requires clean-profile browser checks plus live AI-provider and sandbox GitHub publication checks.
