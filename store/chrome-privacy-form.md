# Chrome Web Store privacy form — paste-ready

## Single purpose description
Product Pass lets users capture visual website-review evidence, organize related notes into editable issue drafts, and publish only explicitly approved drafts to a configured GitHub repository.

## Permission justifications

### storage
Stores review sessions, annotations, issue drafts, enabled sites, settings, credentials, and bounded authentication state in extension storage. Cropped screenshots and bounded no-audio WebM recordings are stored locally in extension IndexedDB. This persistence is required for reviews to survive navigation and browser restarts.

### tabs and activeTab
Reads the active tab’s URL and title so annotations stay attached to the correct page across navigation. After the user invokes Product Pass, `activeTab` permits capture of the visible selected area for the local screenshot attached to an annotation. Product Pass does not inspect tabs for analytics, advertising, or unrelated browsing tracking.

### scripting
Injects the packaged annotation overlay into the active HTTP(S) page only after the user grants that site access. The script enables element selection, freehand boundaries, and restoration of saved overlays. Product Pass does not download or execute remote scripts.

### sidePanel
Displays the Product Pass review workspace in Chrome’s side panel so users can capture notes while viewing the page, inspect local image/video evidence, edit drafts, approve issues, and initiate GitHub publication.

### alarms
Schedules bounded polling and expiry for user-initiated GitHub and Codex device authorization flows. Alarms let authentication safely continue when Chrome suspends the Manifest V3 service worker and are removed when the flow completes, expires, or is canceled.

## Remote code
Select: **No, I am not using remote code.**

All executable JavaScript is packaged inside the extension. Requests to AI, OpenAI authentication, and GitHub return data, not executable code. Product Pass does not use `eval`, remote scripts, remote WebAssembly, or external module imports.

## Data-use checkboxes
Select:
- **Personally identifiable information** — opaque provider identity/authentication tokens can contain provider account identifiers.
- **Authentication information** — API keys, PATs, and OAuth/device-flow tokens selected by the user.
- **Web history** — URL and title of pages on which the user explicitly enables and creates review annotations.
- **User activity** — element selection and freehand pointer geometry used only to create requested annotations.
- **Website content** — selected element context, notes, page evidence, local cropped screenshots, and user-selected no-audio screen recordings. Media is sent to GitHub only after explicit per-draft opt-in and publish confirmation; never to AI.

Do not select health information, financial and payment information, personal communications, or location unless the product is changed to intentionally collect those categories.

## Certifications
Select all three certifications. Transfers to the user-selected AI provider and GitHub are disclosed, user-initiated, and limited to Product Pass’s core functionality.

## Privacy policy URL
https://moejay.github.io/product-pass/privacy.html
