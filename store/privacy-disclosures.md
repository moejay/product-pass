# Store privacy disclosures

Use this as the source of truth when completing store forms. Recheck the live forms before every submission.

## Data handled
- Authentication information: user-supplied API keys, GitHub PATs, GitHub App tokens, and Codex OAuth tokens.
- Website activity: active page URL and title on sites the user enables.
- Website content: selected element label/selector, annotation note, geometry, cropped screenshot, and issue source evidence.
- User-generated content: review notes and issue drafts.

## Local-only data
Sessions, drafts, settings, credentials, geometry, and cropped screenshots are stored locally. Screenshots are never transmitted by Product Pass.

## User-directed network transfers
- Configured AI provider: note text, page title, sanitized URL, annotation type, and element label, only after an organization confirmation.
- OpenAI authentication/Codex service: authentication data and organization request when that experimental provider is selected.
- GitHub: authentication data and the edited issue title/body only after explicit publication confirmation.

## Practices
- No sale of data.
- No advertising, analytics, tracking, or profiling.
- No use unrelated to Product Pass’s single purpose.
- No transfer to DOTDEV infrastructure; Product Pass has no publisher-operated application backend.
- Credentials are not exposed to page/content scripts.
- Local data is deleted when the user deletes a session, clears credentials, clears extension data, or uninstalls according to browser behavior.

## Chrome form guidance
Declare collection/handling of authentication information, website content, website activity, and user-generated content. Declare that data is used for the extension’s core functionality and user-directed third-party transfers. Do not claim data is anonymous.

## Firefox manifest
The manifest currently declares required `authenticationInfo`, `websiteActivity`, and `websiteContent`. Keep this synchronized with AMO’s current taxonomy and form.
