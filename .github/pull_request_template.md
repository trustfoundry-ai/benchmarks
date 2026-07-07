## Summary

<!-- One-paragraph description. Link the driving issue if there is one. -->

## Checklist

- [ ] `pnpm test` passes locally
- [ ] `pnpm verify:results` passes locally (if you touched `results/`, scoring logic, or any dataset)
- [ ] Artifact schema versions bumped if any of the four schemas changed shape
- [ ] `CHANGELOG.md` entry added for contract-affecting changes
- [ ] Documentation updated (`README.md`, suite docs, `docs/adapter-contracts.md`)

## Scope

- [ ] This PR does not add internal infrastructure names (data-plane / index / query-service / RDBMS / message-bus / internal hostnames) to any file, config, comment, or doc
- [ ] Vendor product names, where present, appear only in adapters or configs that are specifically evaluating that vendor (adapter file name / adapter id / User-Agent). No competitive framing or comparative language against another vendor in comments or docs.
- [ ] Vendor adapters use a role alias (e.g. `benchmarks@trustfoundry.ai`) in outbound request headers — no personal contact info.
- [ ] Dataset field names remain generic; no vendor-specific identifiers introduced
- [ ] If this promotes work from an internal overlay, the promotion checklist was followed
