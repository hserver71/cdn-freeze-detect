# Telegram Watcher

Lightweight companion service that logs in as a **user account** (via MTProto/Telethon) and forwards interesting messages to the main backend so the existing bot can alert other people.

> ⚠️ This logs in with your personal Telegram session. Keep the session file and `.env` secret. Anyone with the session string can impersonate you.

## Setup

1. **Create a Telegram developer application**
   - Visit https://my.telegram.org, sign in, go to **API development tools**, create an app.
   - Note the `api_id` and `api_hash`.

2. **Install dependencies**

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Configure environment**

   Create `.env` (or export variables) with:

   ```env
   TELEGRAM_API_ID=123456
   TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
   TELEGRAM_PHONE_NUMBER=+15551234567
   TELEGRAM_SESSION_PATH=.session/myaccount.session
   BACKEND_NOTIFY_URL=https://node-monitor.cdn-loadbalancer.com/api/quality/external-alert
   BACKEND_NOTIFY_TOKEN=choose-a-shared-secret
   BACKEND_CONTACT_SYNC_URL=https://node-monitor.cdn-loadbalancer.com/api/contacts/sync
   BACKEND_CONTACT_LIST_URL=https://node-monitor.cdn-loadbalancer.com/api/contacts
   BACKEND_ACCOUNT_KEY=personal-account
   BACKEND_ACCOUNT_ID=1
   IGNORE_CHAT_IDS=8322323654
   BACKFILL_ON_START=true
   BACKFILL_MESSAGE_LIMIT=500
   BACKFILL_DAYS=0
   WATCH_CHATS=all
   WATCHER_STATE_PATH=.state/forwarded.json
   ```

   - `TELEGRAM_SESSION_PATH` is where we store the Telethon session (folder will be created automatically).
   - `WATCH_CHATS` can be `all` or a comma-separated list of chat IDs/usernames. Use `all` to forward everything.
- `BACKEND_NOTIFY_URL` points to the endpoint that mirrors messages.
- `BACKEND_CONTACT_SYNC_URL` (optional) defaults to `BACKEND_NOTIFY_URL` with `/contacts/sync`; it keeps the backend’s contact list in sync.
- `BACKEND_CONTACT_LIST_URL` (optional) defaults to the same host with `/api/contacts`; it lets the watcher download the list of important recipients.
- `BACKEND_ACCOUNT_KEY` identifies which backend account should receive these messages (must match the account defined in the Node backend).
- `BACKEND_ACCOUNT_ID` is optional; supplying it skips a lookup by key.
- `IGNORE_CHAT_IDS` lets you skip forwarding messages from specific chat IDs (comma-separated, useful to avoid loops with your bot).
- `BACKFILL_ON_START` enables a historical backfill run each time the watcher starts (use `--backfill` CLI flag for one-off runs).
- `BACKFILL_MESSAGE_LIMIT` caps how many past messages are sent per chat (set ≤0 for no cap).
- `BACKFILL_DAYS` optionally restricts the backfill window to the most recent N days (0 disables the cutoff).
- `WATCHER_STATE_PATH` stores the most recent forwarded message ids (used in cron mode to avoid duplicates).
- Set the same value in the backend as `EXTERNAL_ALERT_TOKEN` so it can authenticate the watcher.

4. **Run the watcher**

   ```bash
   python bot_watcher.py
   ```

   - On the first run Telethon asks for the SMS code (and 2FA password if enabled). It then writes the session file.
   - After that the watcher reconnects automatically and streams messages.

5. **Daemonizing (optional)**
   - Use PM2 (`pm2 start --name telegram-watcher python -- bot_watcher.py`) or systemd.
- Add `--backfill` if you want a one-time historical sync before live updates.

6. **Cron mode (optional)**
   - To run short-lived checks every few minutes, invoke the watcher with `--cron` (or set `CRON_MODE=true`):

     ```bash
   */3 * * * * cd /home/cdn-freeze-detect/telegram-watcher && /usr/bin/python3 bot_watcher.py --cron --backfill >> /home/cdn-freeze-detect/telegram-watcher/cron.log 2>&1
     ```

   - Cron mode refreshes the contact list, scans unread messages from contacts marked as important in the backend, forwards any new entries once, updates the state file, and exits.

## How it works

- Pulls the full contact list on startup (and every few hours) and POSTs it to `/contacts/sync`.
- On startup (or when `--backfill`/`BACKFILL_ON_START` is enabled) it replays historical messages for important contacts, keeping track of the last forwarded message per chat to avoid duplicates.
- In daemon mode it subscribes to `events.NewMessage`, filters by chat list, builds a compact payload, and POSTs to `/quality/external-alert`.
- In cron mode it performs a single scan for unread messages from important contacts and only forwards previously unseen messages (tracked via the state file).
- The backend stores contacts (surfacing them in the UI) and uses the roles/importance flags to determine who receives mirrored alerts.

See `bot_watcher.py` for inline comments and extension points (media handling, rate limiting, etc.).

