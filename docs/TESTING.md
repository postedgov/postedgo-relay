# Testing the release

Run from a fresh, private extracted directory. Do not copy another installation's `.relay/` folder.

## Automated checks

From `skills/relay-setup/companion`: `npm test` and `npm run check` (Node.js 22.13+). From the plugin root: `python3 skills/relay-reply/scripts/test_reply.py` (Windows: use the installed Python launcher if needed). Run `node --test skills/relay-setup/scripts/install.test.mjs` from the plugin root to check installation and preservation of existing data. No provider credentials are required for these checks; subprocess fixtures are isolated. Platform-specific skips are reported, not counted as successful execution on that OS.

Run `node --test scripts/plugin.test.mjs` from the plugin root. This checks manifests, every release hash and skill resource link, then copies each skill alone to an opaque location, installs/starts/checks/stops the setup companion and executes the isolated reply helper tests. This does not register the plugin in Grok Bot.

Verify the listed release hashes using `SHA256SUMS` with your platform's SHA-256 utility. The list includes every distributed file other than itself. The public-repository CI workflow runs checks on macOS, Windows and Linux, but a configured workflow is not evidence that it has run.

## Local companion smoke test

1. Start the launcher on the target OS. Confirm an empty Team room and no saved Grok key. Available agent buttons should match installed CLIs; the initial lead must be available, preferring Codex.
2. Confirm the room is on 127.0.0.1. An API request without the local token must fail. A foreign Origin/Host must fail.
3. Confirm typing a project folder path works. Mac has a native picker; other systems can paste a path. Verify opening a known folder and the browser on each real OS.
4. Connect your own chosen Bot using [SETUP.md](../skills/relay-setup/references/SETUP.md). Send a short Discussion test and verify its actual answer in the same room. Confirm a peer reply is visible to the next selected agent. Do not mark the check complete from a dispatch HTTP200 alone.
5. Stop waiting on a test request, confirm the owned listener/tunnel closes, then confirm no late callback changes the task. Check cloud work separately before repeating it.
6. Stop/reopen the app while idle. Confirm your test reply and key persist only in this installation. A separate new installation must remain empty and use a different token.

## Plugin host acceptance

Load the plugin in the target host through its documented local/private mechanism or approved marketplace listing. Confirm both relay-setup and relay-reply appear and their relative resources resolve. Ask the installed plugin to “Set up Relay with my agents.” With an approved local tool, verify it transfers the clean release, runs skills/relay-setup/scripts/install.mjs on the real user device, detects their agents, connects the selected Bot and opens a working room. With cloud-only tools, verify it offers a real download and waits for the local launch rather than installing on the cloud computer. Invoke reply with a valid test event, then a truncated one, and confirm one real callback versus a clear failure without invented credentials.

Before checking “tested locally and in-app” on a marketplace form, record the host/version, OS, installed plugin version, real routine result and callback verification. Existing live tests of the underlying bridge do not establish that the newly packaged plugin was installed by the marketplace loader.

Current release acceptance evidence and unverified platforms are supplied separately by the publisher. Do not submit a marketplace certification based solely on these instructions.
