# Chrome Web Store listing

## Name
Product Pass

## Summary
Capture visual website feedback, organize it into issue drafts, and publish approved issues to GitHub.

## Category
Developer Tools

## Language
English

## Detailed description
Product Pass keeps visual QA evidence attached to the issue it belongs to.

Capture an element, draw a freehand boundary, or record up to one minute of no-audio WebM video with timestamped notes. Product Pass saves screenshots and recordings locally. Continue across pages inside one review session.

When the pass is complete, organize related notes into editable issue drafts using a local deterministic workflow, an OpenAI-compatible API, or an experimental ChatGPT/Codex subscription connection. Review the title, Markdown body, source evidence, and local image/video previews. Nothing is published until you accept a draft and confirm GitHub publication.

Features:
- Chrome side panel workflow
- Per-site optional permissions
- Element and freehand annotations
- Multi-page persistent sessions
- Local image/video gallery with timestamp playback, download, and deletion
- Default-off experimental GitHub media attachment upload
- Editable issue drafts
- GitHub OAuth Device Flow or fine-grained PAT
- No Product Pass backend, advertising, or analytics

Media remains local and is never uploaded to AI providers. A draft can explicitly opt into direct GitHub media upload before final confirmation; this experimental feature uses GitHub's undocumented attachment endpoint.

## URLs
- Homepage: https://moejay.github.io/product-pass/
- Privacy: https://moejay.github.io/product-pass/privacy.html
- Support: https://moejay.github.io/product-pass/support.html

## Single purpose
Product Pass captures website-review evidence and turns approved review notes into GitHub issues.

## Permission justifications
- `storage`: Persist sessions, drafts, settings, credentials, and authentication lifecycle state locally.
- `tabs` and `activeTab`: Read the active tab URL/title, coordinate annotations across navigation, and capture its visible area after you invoke Product Pass.
- `scripting`: Inject the annotation tool only after the user grants access to a site.
- `sidePanel`: Host the Product Pass review workspace.
- `alarms`: Resume and expire OAuth/Device Flow polling safely when the MV3 worker is suspended.
- Optional `http://*/*` and `https://*/*`: Let users enable annotations one site at a time. Product Pass does not request blanket site access at installation.

## Privacy declarations
See `store/privacy-disclosures.md`. All declarations must match the live privacy policy.
