# Vendored engine contracts

The four TypeScript files listed in `manifest.json` are copied from
[No1dry/FeishuBrief](https://github.com/No1dry/FeishuBrief), engine release
`v3-20260927` (`23b582f45eb4d74365183194a92c280a9cf44913`).

Their upstream copyright and MIT license are preserved in [LICENSE](LICENSE).
Use `npm run engine:sync` / `npm run engine:check` in the sibling-project
development workspace. The committed files are sufficient for standalone runtime
and tests; neither production nor CI downloads or executes the sibling engine.
