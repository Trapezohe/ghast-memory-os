# Always-On gmOS Service

These templates run `gmos serve` as a loopback-only service with scoped keys.
Replace every `{{PLACEHOLDER}}` before installing.

## systemd

1. Create a dedicated user and data directory:

   ```bash
   sudo useradd --system --home /var/lib/gmos --shell /usr/sbin/nologin gmos
   sudo install -d -o gmos -g gmos /var/lib/gmos
   ```

2. Copy `gmos.service` to `/etc/systemd/system/gmos.service`, replace:
   `{{GMOS_BIN}}`, `{{GMOS_USER}}`, `{{GMOS_GROUP}}`, `{{GMOS_DB}}`,
   `{{GMOS_DATA_DIR}}`, `{{GMOS_PROFILE}}`, and `{{GMOS_PORT}}`.

3. Start it:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now gmos
   ```

## launchd

1. Create local directories, for example:

   ```bash
   mkdir -p "$HOME/Library/Application Support/gmos" "$HOME/Library/Logs/gmos"
   ```

2. Copy `com.ghast.gmos.plist` to
   `~/Library/LaunchAgents/com.ghast.gmos.plist`, replace placeholders, then run:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.ghast.gmos.plist
   launchctl start com.ghast.gmos
   ```

## Keys

Create keys from the trusted CLI, not over HTTP:

```bash
gmos keys create --db ./gmos.db --label planner --scope read --profiles default
gmos keys create --db ./gmos.db --label worker --scope readwrite --profiles default
gmos keys create --db ./gmos.db --label admin --scope admin --profiles '*'
```

Secrets print once. Store them in the agent process secret store.

## Connect Agents

JavaScript:

```js
import { GmosClient } from "@ghast/memory/client";

const memory = new GmosClient({
  baseUrl: "http://127.0.0.1:4787",
  apiKey: process.env.GMOS_API_KEY,
});
await memory.prepareTurn({ profileId: "default", text: "What should I remember?" });
```

Python:

```python
from gmos_client import GmosClient

memory = GmosClient("http://127.0.0.1:4787", api_key)
memory.prepare_turn({"profileId": "default", "text": "What should I remember?"})
```

MCP:

```bash
gmos mcp serve --db ./gmos.db --profile default
```

## Backup

Keep HTTP serving for agent traffic and use trusted CLI backup commands:

```bash
gmos backup --db ./gmos.db --profile default --mode safe --output-file ./gmos-profile-backup.json
```

For a long-running service, take profile backups daily and keep filesystem
snapshots of the SQLite DB directory before upgrades.

## Logs and Audit

systemd logs:

```bash
journalctl -u gmos -f
```

launchd logs use the `StandardOutPath` and `StandardErrorPath` from the plist.

HTTP audit rows are content-free:

```bash
gmos audit list --db ./gmos.db --key-id key_xxx --since 2026-07-01T00:00:00.000Z
```
