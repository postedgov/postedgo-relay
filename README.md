# Relay by PostedGo

One room for your own agents. Talk with Grok Bot, Codex, Kimi and Hermes using the accounts you already have. One lead answers ordinary messages; @mentions bring in others.

This plugin includes two agent skills and a local companion app. The app keeps chat history on your computer and connects your chosen Grok Bot through its own webhook routine. Each installation starts empty and creates its own credentials. There is no shared PostedGo account or hosted room service.

## Start in Grok Bot

After the marketplace listing is approved, add **Relay by PostedGo** from **Connect apps**. Tell your chosen Bot: **“Set up Relay with my agents.”** The relay-setup skill drives local installation, routine setup and a real reply check. Where Grok Bot offers approved local execution, it can run the included installer on your computer. Otherwise it provides the release for you to download and launch. Installing the plugin alone does not grant local access.

Each marketplace skill includes its own resources: setup includes the full installer and companion; reply includes the callback helper. No skill depends on a parent folder or another skill’s files. The local installer verifies release file hashes and copies only the companion to a private folder; it preserves existing installations and never copies publisher credentials. This 0.1.1 candidate is prepared for marketplace review. Actual marketplace installation remains an acceptance check; a successful manual companion test does not certify it.

## Direct installation before marketplace availability

1. Extract the complete release to a private, permanent folder on your computer.
2. Install Node.js 22.13+ and Git. For automatic Grok replies, install the official cloudflared executable. Install and sign in to whichever supported agent CLIs you want to use.
3. Open the launcher inside **skills/relay-setup/companion**: **Launch Relay.command** on Mac, **Launch Relay.cmd** on Windows, or run **sh launch-relay.sh** on Linux.
4. Open **Connect Grok** in the room and follow [SETUP.md](skills/relay-setup/references/SETUP.md) to connect your own chosen Bot. Save its key privately and send a connection check.
5. Use **@grok**, **@codex**, **@kimi**, **@hermes**, or **@team**. Select a different default recipient beside the message box. Only installed/connected agents can reply automatically.

Grok Bot normally runs in the cloud. Installing this plugin there does not install the companion on your personal computer. The **relay-setup** skill guides that local step; **relay-reply** returns a Bot's answer through a single temporary callback. The companion can also be used before a marketplace listing exists.

## Included

- Portable `plugin.json` and Cursor `.cursor-plugin/plugin.json` manifests.
- Setup and reply skills, with a Python standard-library callback helper.
- Hash-checked local installer, app source, launchers, and behavioral tests.
- Square SVG logo, MIT license, setup, privacy and test instructions.
- `SHA256SUMS` for the exact release files. No prebuilt provider binaries or account credentials.

## Compatibility

| Component | Support and current verification |
| --- | --- |
| Mac companion | Browser room and native/webhook bridges tested on macOS. |
| Windows companion | Windows launcher, native executable discovery, folder opening and Job Object process containment implemented; real Windows run still required before claiming platform certification. `.cmd`/`.bat` agent shims are not executed: use native `.exe`/`.com` CLI binaries. Existing PowerShell policy must allow the bundled helper; Relay does not bypass it. |
| Linux companion | Shell launcher, PATH discovery, process groups and `xdg-open` integration implemented; real Linux desktop run still required. |
| Grok Bot | One webhook-enabled chosen Bot; native approvals remain in Grok Bot. Existing bridge has been tested live. Marketplace loading of this new plugin is a separate pending check. |
| Codex / Kimi / Hermes | Their installed CLI must support app-server / ACP as appropriate on that OS. Desktop app installation alone may not provide a usable CLI. Provider availability and plans vary. |
| Other services | Available through the tools of your connected agents. This release does not add arbitrary providers as separate room participants. |

The first available automatic agent becomes lead, preferring Codex when installed. With no native agents, Grok can be connected alone; before connection it supports manual handoff only. Discussion is the default. Work mode allows local project edits under the agent's existing permissions.

Marketplace reviewers: use [the review guide](docs/REVIEW.md) for the installation path, reproducible checks and acceptance limits.

Read [privacy and boundaries](docs/PRIVACY.md) before connecting private projects, and [testing instructions](docs/TESTING.md) before distributing a build. Native Windows/Linux verification and marketplace review must not be represented as completed by the local checks alone.

## Development and removal

Run `npm test` inside `skills/relay-setup/companion/` and `python3 skills/relay-reply/scripts/test_reply.py` from the plugin root. No Node dependency install is needed. The clean source includes a three-OS GitHub Actions workflow for public-repository verification. Run `node --test scripts/plugin.test.mjs` to verify both skill bundles in isolation.

To stop Relay, run `node src/launch.mjs --stop` inside the returned installation folder (normally `~/.postedgo-relay`), or inside companion if launched directly. Uninstall the skills/plugin in the host app. Disable or delete the dedicated routine through Grok Bot if you no longer want to use it. That installation's `.relay/` (or your selected RELAY_DATA_DIR) contains chat history and keys; back it up privately or delete it yourself when you want to remove all data. Never publish it.

MIT licensed. Copyright 2026 Jon Son / PostedGo. Independent project; no affiliation with the agent vendors is implied.
