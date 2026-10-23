# Third-party notices

The project code is licensed under MIT. This does not relicense third-party dependencies or assets.

## JetBrains Mono

The bundled WOFF2 fonts under apps/web/app/assets/fonts are JetBrains Mono.
Copyright 2020 The JetBrains Mono Project Authors.
They are distributed under the SIL Open Font License 1.1; the full text is retained in that directory as OFL.txt.
Upstream: https://github.com/JetBrains/JetBrainsMono

## Anthropic sandbox-runtime

Adapters depends on @anthropic-ai/sandbox-runtime 0.0.78, licensed under Apache-2.0. The dependency serves the macOS sandbox path only; Windows process tools run on the host after per-call approval and have no OS sandbox. A copy of the upstream Apache-2.0 license is retained as packages/adapters/native/srt-win/LICENSE-APACHE-2.0. The project no longer ships derived Windows patches, candidate build scripts or a source manifest for that upstream package.
Upstream: https://github.com/anthropic-experimental/sandbox-runtime

## npm dependencies

Each dependency retains its own license and notices. package-lock.json records the selected dependency tree; obtain complete dependency license texts from the installed packages when redistributing a built application. Project MIT permission does not override those terms or external model/service terms.
