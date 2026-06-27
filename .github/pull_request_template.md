## Summary

## Verification

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run scan:public`

## Public-Safety Check

- [ ] No raw transcripts, private PAI memory, local paths, credentials, tokens, `.env` files, or local SQLite databases.
- [ ] Fixtures are synthetic or explicitly redacted.
- [ ] Generated reports are from synthetic or approved redacted fixtures.
