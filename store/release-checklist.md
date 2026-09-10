# Release checklist

1. Update `package.json` and both manifests to the same unused version.
2. Review provider protocols, permissions, `store/privacy-disclosures.md`, and the live privacy policy.
3. Run `npm ci && npm run check && npm run package && npm run lint:firefox`.
4. Test a clean Chrome and Firefox install: per-site grant/denial, both annotation modes, screenshots, recording chooser/limits/timestamp/playback/download/delete, navigation persistence, organize/fallback, edit/accept/skip, local-only and opt-in-media GitHub sandbox publish, partial upload failure, finish/reopen/delete, and credential removal.
5. Upload current screenshots from `store-assets/` and copy the appropriate listing text when those have changed.
6. Confirm store privacy forms exactly match `store/privacy-disclosures.md`.
7. Confirm the `CHROME_SERVICE_ACCOUNT_JSON`, `AMO_JWT_ISSUER`, and `AMO_JWT_SECRET` GitHub secrets are current. The Chrome service account needs no Google Cloud IAM role; enable the Chrome Web Store API and add its email under the Chrome Web Store Developer Dashboard **Account** section.
8. Tag `v<version>` only after the commit is final. The tag must exactly match `package.json`; CI packages once, creates the GitHub release, and submits the same artifacts to Chrome Web Store and AMO.
9. Verify the GitHub release checksums and all three release workflow jobs. A successful store job means the update was submitted; monitor each dashboard for review and public availability. On a partial failure, rerun only failed jobs. If Chrome reports an unknown outcome, inspect its dashboard before rerunning.
10. After approval, verify the Pages site store links.
