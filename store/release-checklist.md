# Release checklist

1. Update `package.json` and both manifests to the same unused version.
2. Review provider protocols, permissions, `store/privacy-disclosures.md`, and the live privacy policy.
3. Run `npm ci && npm run check && npm run package`.
4. Run Firefox lint: `npx web-ext lint --source-dir dist/firefox --warnings-as-errors`.
5. Test a clean Chrome and Firefox install: per-site grant/denial, both capture modes, screenshots, navigation persistence, organize/fallback, edit/accept/skip, GitHub sandbox publish, finish/reopen/delete, and credential removal.
6. Upload current screenshots from `store-assets/` and copy the appropriate listing text.
7. Upload `release/product-pass-<version>-chrome.zip` to Chrome Web Store.
8. Upload `release/product-pass-<version>-firefox.zip` plus `release/product-pass-<version>-source.zip` to AMO.
9. Confirm store privacy forms exactly match `store/privacy-disclosures.md`.
10. Tag `v<version>` only after the commit is final; verify GitHub release checksums.
11. After approval, replace temporary install links on the Pages site with store listing URLs.
