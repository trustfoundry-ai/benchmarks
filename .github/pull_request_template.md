## Summary

<!-- One-paragraph description. Link the driving issue if there is one. -->

## Checklist

- [ ] `pnpm test` passes locally
- [ ] `pnpm verify:results` passes locally (if you touched `results/`, scoring logic, or any dataset)
- [ ] Artifact schema versions bumped if any of the four schemas changed shape
- [ ] `CHANGELOG.md` entry added for contract-affecting changes
- [ ] Documentation updated (`README.md`, suite docs, `docs/adapter-contracts.md`)

## Scope

- [ ] This PR does not add third-party vendor product names or internal infrastructure names to any file, config, comment, or doc
- [ ] Dataset field names remain generic; no vendor-specific identifiers introduced
- [ ] If this promotes work from an internal overlay, the promotion checklist was followed
