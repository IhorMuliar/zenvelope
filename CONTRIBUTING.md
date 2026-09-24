# Contributing

Open an issue before a large change, so we agree on the shape first.
Keep the app static and non-custodial: no backend that touches keys, no float.
Never use the drainer lure word banned in `web/src/copy/en.test.ts`. Use open, receive, unwrap.
Before a PR, run `cargo test -p zenvelope-core`, `node scripts/smoke-core.mjs` (after
`./scripts/build-core.sh`), and in `web/`: `npm test` and `npm run e2e` (builds, then Playwright).
`docs/DECISIONS.md` is the source of truth for product and stack decisions; if a
change contradicts it, update that file in the same PR.
By contributing you agree your work is released under the MIT license.
