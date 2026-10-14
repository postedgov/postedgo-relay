---
name: relay-setup
description: Install and set up Relay from Grok Bot on the user's own computer, connect their chosen Bot with Codex, Kimi or Hermes, and open one shared chat room. Use when the user says set up Relay, install Relay, connect my agents, or change the Bot in my Relay room.
---
# Set up Relay from this Bot

This is the plugin's user entry point. After installing the plugin, the user can say “Set up Relay with my agents.” Carry out the steps your host supports, rather than only returning the setup guide. Read [SETUP.md](references/SETUP.md) for the exact routine contract. All resources needed for installation are bundled inside this skill folder; the separately installed relay-reply skill handles replies.

## Establish the target computer

Ask which supported agents the user wants if not stated; they do not need all four. Retain this Bot's identity unless the user chooses a different Bot. Supported connections are Codex app-server, Kimi ACP, Hermes ACP and one Grok Bot routine. Other services remain tools of those agents.

Inspect the host's available tools and their documented execution target. Grok Bot's cloud computer is separate from the user's device. Use a host-provided local-computer execution tool only when available and authorized under that user's existing policy. Do not change the policy or treat a plugin installation as permission to access the device. A shell with the same username or a successful localhost request is not proof of local execution.

When approved local execution is available, use it for every companion check/install/launch step below. A cloud shell may prepare the package but must not run the companion and call it a local installation. If local execution is unavailable, provide the exact verified release download and the appropriate launcher instructions; wait for the user to run them. Do not invent a download URL. An unpublished local candidate cannot be fetched by another user until the publisher supplies it.

## Install the companion

1. Resolve this skill's directory from the host's actual installed skill location. It contains `SKILL.md`, `SHA256SUMS`, [scripts/install.mjs](scripts/install.mjs), and `companion/`. Resolve every relative path from this directory, regardless of the shell's working directory. No parent plugin directory or sibling skill is required. Do not assume Cursor's local paths apply to Grok Bot.
2. If those files are only on the cloud computer, transfer this complete skill folder through the host's supported download/file-transfer mechanism, or use the marketplace listing's verified public source and pinned revision on the local device. Never copy the Bot's home directory, sessions or secrets. If neither route is available, explain that concrete missing step instead of claiming installation succeeded.
3. Check Node.js 22.13+, Git and the user's chosen native agent CLIs on the target device. Guide installation from their official sources if missing, respecting host approvals. Agent sign-ins stay in their native apps. For Grok replies, install the official OS/CPU cloudflared executable on PATH, or place it in the installed app's private bin directory after step 4 as described in SETUP.md. Windows also needs its existing PowerShell policy to allow the bundled helper; never bypass or weaken policy.
4. From the extracted relay-setup skill folder on the local device, run `node scripts/install.mjs`. It verifies companion files against the release hash list and copies them to a private `~/.postedgo-relay` directory, excluding credentials and chat data. An optional path argument selects another private destination. It refuses existing destinations; never delete an existing installation to make it succeed. Reuse that installation's launcher after checking it belongs to this user.
5. Run the returned `launcher` with Node on the local device. Keep its authenticated browser link private. The local app creates its own data and access token and opens the room. Confirm the visible Team room and detected agents. Use a distinct `RELAY_PORT` and data directory only if another Relay installation is intentionally running; never stop an unrelated service to take its port.

## Connect this Bot

Explain that selected room text goes to this chosen Bot and the reply returns through a temporary Cloudflare endpoint. Follow the host's approval rules for creating the webhook key and saving it privately. Create one dedicated webhook-only **Relay room replies** routine, with no schedule, using SETUP.md's exact contract; inspect and reuse a routine already dedicated to this installation. Preserve other routines, identity, accounts and approval settings.

Open this routine's own credential panel, using its direct Webhook key link if needed. Have the user enter its URL and key into local Relay's **Connect Grok** dialog, or use an authorized private transfer if the host provides one. Never print the key in conversation, include it in a shell command argument, or save it to the plugin directory. Each user supplies their own credential; never distribute or reuse the publisher's key.

Select **Enable automatic Grok replies**, save, then use **Test in this room**. Confirm a real final answer from this Bot appears in that same local room. An accepted dispatch, saved key, or claimed callback is insufficient. Do not automatically replay uncertain dispatches.

Open the room for the user and explain only the essentials: type normally for the selected lead, @mention an agent to bring it in, and choose Work mode for local file changes. Report any incomplete step or actual host/platform limitation. Never claim marketplace installation or local setup was verified from a cloud-only test.
