# Marketplace review: Relay by PostedGo 0.1.1

Publisher: Jon Son / PostedGo. License: MIT. Target listing: Grok Bot.

## What is installed

This is a skills-based plugin using the Agent Plugins root manifest and Cursor marketplace manifest. There is no hosted MCP endpoint and no publisher account to authenticate. Installing the plugin supplies `relay-setup` and `relay-reply`; it does not start a background service or grant local computer access.

Each skill is self-contained. The setup folder includes its installer, local companion source, launchers, reference and file hashes. The reply folder includes the Python callback helper. The local companion is a separate browser room and requires the user's computer to remain running. No room interface is injected into Grok Bot.

## User path to test

1. Load the full plugin through the Grok Bot marketplace's supported review or installation mechanism. Confirm both skills are registered and their bundled resources are readable. A text-only private skill is not equivalent.
2. Ask a chosen Bot: **Set up Relay with my agents.** With approved local execution, it should install on the actual user device. With cloud-only tools, it must transfer/provide the complete clean skill or published source for local installation and wait for that step.
3. Use Node.js 22.13+ and Git. Install/sign in to any desired native agents. For automatic Grok replies, install the official cloudflared executable. Python 3 is needed on the Bot's cloud computer for the reply helper.
4. Follow [setup](../skills/relay-setup/references/SETUP.md). Approve one dedicated webhook-only routine on your chosen Bot, then enter its own URL/key privately into the local Connect Grok dialog. Never use publisher credentials.
5. Send **Test in this room** and verify an actual final reply in that same room. HTTP acceptance is insufficient. Confirm @mentions, lead selection, cancellation and restart behavior from [TESTING.md](TESTING.md).
6. Verify malformed or truncated events do not invent credentials or issue a callback, and uncertain deliveries are not retried automatically.

## Reproducible local checks

From the repository root:

```
node --test scripts/plugin.test.mjs
node --test skills/relay-setup/scripts/install.test.mjs
python3 skills/relay-reply/scripts/test_reply.py
```

From `skills/relay-setup/companion`:

```
npm test
npm run check
```

On Windows use `python` for the Python command. The included CI runs on Windows, macOS and Ubuntu. The plugin test isolates each skill from its parent/sibling directories, verifies all release hashes, installs and launches an empty app, checks local authentication, stops only that test copy, and exercises callback validation without using real credentials or network callbacks.

## Evidence boundaries

The 0.1.1 package and isolated skill workflow pass locally on macOS. The preceding 0.1.0 companion also passed a Bot-driven installation on the real Mac using approved machine tools. The existing webhook adapter has previously returned live Grok Bot replies. These are separate from marketplace loader acceptance: the private test host could only save text skills and could not register the bundled plugin.

Check the repository's CI results for native runner checks. CI does not verify provider sign-ins, GUI behavior, a new user's actual Grok routine, or Grok Bot plugin loading. Do not certify the marketplace form's in-app-tested checkbox until the full plugin has been installed and the room round trip observed through the supported review/install path.

No credentials, room history, private reports, machine-specific binaries or development Git history are included. The plugin is independent of the agent vendors. See [PRIVACY.md](PRIVACY.md) for data and permission boundaries.
