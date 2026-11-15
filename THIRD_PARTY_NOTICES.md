# Third-party notices

Roamies is licensed under [AGPL-3.0](LICENSE). It builds on the components below, each under its own license.

| Component | How it's used | License |
| --------- | ------------- | ------- |
| [Tauri](https://tauri.app) 2 (`tauri`, `tauri-build`) and plugins `tauri-plugin-single-instance`, `tauri-plugin-updater` | desktop shell, see `showcase/tauri/src-tauri/Cargo.toml` | MIT OR Apache-2.0 |
| [Node.js](https://nodejs.org) v24.22.2 | bundled runtime for the sidecar (version in `showcase/tauri/sidecar/fetch-node.sh`) | MIT |
| [@kenkaiiii/gg-agent](https://github.com/KenKaiii/gg-framework), gg-ai, gg-core 5.95.0 | agent framework in the sidecar | AGPL-3.0-only |
| [zod](https://zod.dev) 4.6.7 | schema validation in the sidecar | MIT |
| [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 0.3.318 | Claude sign-in support in the sidecar | Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." (not open source) |
| Claude Code | downloaded at sign-in with Claude, not bundled | Anthropic's terms |
| [Doto](https://github.com/oliverlalan/Doto) and [Martian Mono](https://github.com/evilmartians/mono) fonts | text in the app | SIL Open Font License 1.1, texts in `showcase/onboarding/fonts/` |
| [Natural Earth](https://www.naturalearthdata.com) 1:110m countries | country outlines for map cards (`showcase/roamies/world.js`) and their names (`showcase/tauri/sidecar/countries.mjs`) | Public domain |
| [Whisper](https://github.com/openai/whisper) small, ggml q5_1 model from [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Windows and Linux speech model, downloaded at setup, not bundled | MIT |
| [whisper-rs](https://github.com/tazz4843/whisper-rs) 0.16.0 | runs the speech model in the Windows and Linux voice helper | Unlicense |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | speech recognition in the voice helper, via whisper-rs | MIT |

## Full dependency list

These are the main components. To see every dependency, including indirect ones:

```bash
cd showcase/tauri/sidecar && npm ls --all
cd showcase/tauri/src-tauri && cargo tree
cd showcase/tauri/src-tauri/voice-win && cargo tree
```
