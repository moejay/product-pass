# Firefox AMO submission — paste-ready

## Distribution
Choose **On this site** / listed public distribution and **Firefox desktop**. Product Pass relies on a sidebar and is not presented as an Android add-on.

## Add-on identity
- Name: Product Pass
- Permanent extension ID: `product-pass@moejay.dev`
- License: MIT
- Homepage: https://moejay.github.io/product-pass/
- Support: https://moejay.github.io/product-pass/support.html
- Privacy: https://moejay.github.io/product-pass/privacy.html
- Support email: product-pass@moejay.dev

## Summary
Capture visual website feedback, review local evidence, and publish approved GitHub issues.

## Data categories
The manifest declares these required categories:
- **Authentication information** — user-configured API keys, GitHub credentials, and optional Codex OAuth tokens.
- **Website activity** — page URL/title on sites where the user explicitly enables Product Pass and creates annotations.
- **Website content** — selected element context, review/timestamp notes, source evidence, captured local screenshots, and user-selected no-audio screen recordings.

Product Pass has no publisher-operated application backend, analytics, advertising, sale of data, or unrelated data use. Media stays local unless a draft explicitly enables experimental GitHub upload and the user confirms publication. AI/GitHub transfers are user-initiated and described in the privacy policy.

## Source code
Upload `product-pass-<version>-source.zip` when AMO requests source for the generated JavaScript bundles.

Build instructions:

```text
Requirements: Node.js 20 or newer and npm.

1. Extract the source archive.
2. Run: npm ci
3. Run: npm run build
4. The Firefox extension is generated in dist/firefox.

The build uses the dependency versions locked in package-lock.json. esbuild bundles checked-in TypeScript into unminified JavaScript. No network access or secrets are required at runtime to build the extension.
```

## Reviewer notes
```text
Core functionality requires no account or network request.

1. Open Product Pass from the toolbar/sidebar.
2. On a regular HTTPS page, create a session.
3. Click “Enable on this site” and approve that site's optional permission.
4. Select “Element rectangle,” click an element, and enter optional text.
5. The annotation and cropped screenshot appear locally in the sidebar. Record a short screen clip, add a timestamp note, stop, and verify local playback.
6. Click “Organize notes.” Without AI credentials, deterministic local grouping is used.
7. Review/edit the generated issue draft. GitHub publishing remains unavailable unless the reviewer supplies their own repository and credential.
8. Media remains local unless the default-off experimental GitHub upload option is enabled and publication is confirmed.
9. “Finish” preserves and closes the session. “Delete session” removes its local notes, screenshots, recordings, and drafts.

No remotely hosted code is loaded or executed. AI and GitHub responses are treated only as data. The optional experimental Codex connection is user-initiated, uses device authorization without cookies or a client secret, and is documented in the privacy policy and README.
```

## Assets
- Icon: `store-assets/store-icon-128.png`
- Screenshots: `store-assets/screenshot-capture.png`, `store-assets/screenshot-review.png`
- Full description: `store/firefox-listing.md`
