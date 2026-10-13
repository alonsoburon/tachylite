# Contributing

Thanks for helping. This project is only useful if it stays legally clean, so these rules are firm.

## Hard rules

1. **Do not submit code, CSS, icons, fonts, translations or text copied or closely transliterated
   from Obsidian's proprietary application** (including its minified bundles), or from any
   decompiler output of it. Pull requests containing such material will be closed.
2. **Facts are fine, expression is not.** Public documentation, the `obsidian` typings, file
   formats, config key names, CSS variable and class names, and observable behavior can all be
   used. Write the implementation yourself.
3. **Disclose how you learned a behavior** in the PR if it came from analyzing the app, so it can be
   reviewed. Prefer docs, typings and black-box observation (inputs and outputs) over reading source.
4. **No circumvention.** No DRM/licence bypass, and nothing that accesses Obsidian's paid services.
5. Third-party code must be compatibly licensed and noted in the PR.

## Development

```
cargo test --workspace && cargo clippy --workspace --all-targets
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```

Compatibility bugs are the most valuable contributions: a vault that behaves differently, or a
community plugin that fails to load. Include the plugin id/version and a minimal vault if you can.
