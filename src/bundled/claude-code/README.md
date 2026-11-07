# Claude

Create agents that run Claude on your computer and answer you in Buzz. Each agent works in its own **Workspace** folder and can run commands and edit files on its own.

## Getting started

1. Go to **Settings** → **Agent setup** → **Harness defaults** → **Claude** to install Claude, then either **Sign in** with your Claude account (Pro, Max, Team or Enterprise), or paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Buzz keeps the key in the OS credential store (Keychain on macOS), never in a file or back in the app, and native code gives it to Claude processes when Claude runs with the key. Security reviews always use the key, because they run in their own Claude folder, apart from the account sign-in.
2. Choose **New agent** → **Create a new agent**, and pick **Claude** as the **Harness**.
3. Mention your agent in a conversation to give it work.
