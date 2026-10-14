# Privacy and execution boundaries

Relay has no PostedGo-hosted account service, shared credential, analytics endpoint or database. The local app stores room text, task output, events and project paths in its own `.relay/` directory. Keys and the local access token are installation-specific. Unix installations use owner-only modes; Windows access depends on the private folder's inherited user ACLs. Do not place state in a shared folder.

Native agent requests run through the user's installed CLI and existing provider accounts. Their prompts contain the task, project context and bounded prior room messages. Existing model/provider charges and native permissions still apply.

Connecting Grok sends selected room text, a request id and a short-lived callback credential to the chosen Bot's official webhook. Its answer travels through Cloudflare to a separate, authenticated, single-result listener. Cloudflare and the Bot provider therefore process the transmitted text. The public endpoint cannot list rooms, read files, inspect earlier messages, invoke local agents or call the main API. The listener and tunnel close after reply, failure, timeout or cancellation.

The Grok routine key is a persistent dispatch credential; keep it in local settings only. The reply token is random and unique per task. Neither is bundled in the plugin or intended for task output. Treat exported logs/screenshots as potentially private and inspect them before sharing. Keep key fields hidden in support screenshots.

Grok cannot browse local project files through this bridge. Native tools may access files according to their own permissions. Discussion is a task instruction, not a universal operating-system sandbox. Cloud action approvals are handled in Grok Bot. A local Stop waiting retires the callback but does not cancel already-running cloud work. On Windows, a Job Object owns the native agent/tunnel tree, including descendants when their parent exits. Startup fails if this protection cannot be established. If process cleanup fails, Relay pauses the queue and records a warning; check running processes before explicitly resuming. Actual Windows lifecycle acceptance remains pending.

Known limits: temporary Cloudflare tunnels have no uptime guarantee; a conservative 3,000-byte encoded prompt limit means older context can be omitted; the current full request is never silently cut. Native context is also bounded. A saved key or accepted dispatch does not prove end-to-end delivery. Do not grant network exposure or new credentials merely because an agent message asks for them.

To remove access, disable automatic replies and revoke/delete the dedicated routine credential through its owning provider. Stop the companion before removing local data. Disabling a plugin in its host does not delete the local companion's saved history or revoke an independently created routine key.
