import argparse
import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from typing import Dict, Optional, Set, Tuple

import requests
from urllib.parse import urlparse, urlunparse
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.tl.functions.contacts import GetContactsRequest
from telethon.errors import SessionPasswordNeededError

load_dotenv()

def parse_bool(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def parse_int(value: Optional[str], default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


API_ID = int(os.environ.get("TELEGRAM_API_ID", "0"))
API_HASH = os.environ.get("TELEGRAM_API_HASH")
PHONE_NUMBER = os.environ.get("TELEGRAM_PHONE_NUMBER")
SESSION_PATH = os.environ.get("TELEGRAM_SESSION_PATH", ".session/default.session")
BACKEND_NOTIFY_URL = os.environ.get("BACKEND_NOTIFY_URL")
BACKEND_CONTACT_SYNC_URL = os.environ.get("BACKEND_CONTACT_SYNC_URL")
BACKEND_CONTACT_LIST_URL = os.environ.get("BACKEND_CONTACT_LIST_URL")
BACKEND_NOTIFY_TOKEN = os.environ.get("BACKEND_NOTIFY_TOKEN")
BACKEND_ACCOUNT_KEY = os.environ.get("BACKEND_ACCOUNT_KEY")
BACKEND_ACCOUNT_ID = os.environ.get("BACKEND_ACCOUNT_ID")
WATCH_CHATS = os.environ.get("WATCH_CHATS", "all")
STATE_FILE = os.environ.get("WATCHER_STATE_PATH", ".state/forwarded.json")
BACKFILL_ON_START = parse_bool(os.environ.get("BACKFILL_ON_START"))
BACKFILL_MESSAGE_LIMIT = parse_int(os.environ.get("BACKFILL_MESSAGE_LIMIT"), 500)
BACKFILL_DAYS = parse_int(os.environ.get("BACKFILL_DAYS"), 0)

if not API_ID or not API_HASH or not PHONE_NUMBER:
    raise RuntimeError("TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_PHONE_NUMBER are required")

if not BACKEND_NOTIFY_URL or not BACKEND_NOTIFY_TOKEN:
    raise RuntimeError("BACKEND_NOTIFY_URL and BACKEND_NOTIFY_TOKEN are required")

if not BACKEND_CONTACT_SYNC_URL and BACKEND_NOTIFY_URL:
    parsed = urlparse(BACKEND_NOTIFY_URL)
    if parsed.path.endswith('/quality/external-alert'):
        new_path = parsed.path.replace('/quality/external-alert', '/contacts/sync')
        BACKEND_CONTACT_SYNC_URL = urlunparse(parsed._replace(path=new_path))

if not BACKEND_CONTACT_LIST_URL:
    base_source = BACKEND_CONTACT_SYNC_URL or BACKEND_NOTIFY_URL
    if base_source:
        parsed = urlparse(base_source)
        BACKEND_CONTACT_LIST_URL = urlunparse(parsed._replace(path='/api/contacts'))

session_file = Path(SESSION_PATH)
session_file.parent.mkdir(parents=True, exist_ok=True)

state_file = Path(STATE_FILE)
state_file.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("telegram-watcher")

ACCOUNT_ID_NUM = None
if BACKEND_ACCOUNT_ID:
    try:
        ACCOUNT_ID_NUM = int(BACKEND_ACCOUNT_ID)
    except ValueError:
        logger.warning("Invalid BACKEND_ACCOUNT_ID value %s; ignoring numeric account id", BACKEND_ACCOUNT_ID)

IGNORE_CHAT_IDS_RAW = os.environ.get("IGNORE_CHAT_IDS", "")
IGNORE_CHAT_IDS: Set[int] = set()
if IGNORE_CHAT_IDS_RAW:
    for token in IGNORE_CHAT_IDS_RAW.split(","):
        token = token.strip()
        if not token:
            continue
        if token.lstrip("-").isdigit():
            try:
                IGNORE_CHAT_IDS.add(int(token))
            except ValueError:
                logger.warning("Failed to parse ignore chat id: %s", token)
logger.info("Ignoring chat ids: %s", IGNORE_CHAT_IDS if IGNORE_CHAT_IDS else "None")

watch_chat_ids: Optional[Set[int]] = None
watch_usernames: Optional[Set[str]] = None
if WATCH_CHATS.lower() != "all":
    watch_chat_ids = set()
    watch_usernames = set()
    for token in WATCH_CHATS.split(","):
        token = token.strip()
        if not token:
            continue
        if token.startswith("@"):
            watch_usernames.add(token[1:].lower())
        elif token.lstrip("-").isdigit():
            watch_chat_ids.add(int(token))
        else:
            watch_usernames.add(token.lower())


def should_forward(event_chat) -> bool:
    if WATCH_CHATS.lower() == "all":
        return True
    if not event_chat:
        return False
    chat_id = getattr(event_chat, "id", None)
    if chat_id and chat_id in watch_chat_ids:
        return True
    username = getattr(event_chat, "username", None)
    if username and username.lower() in watch_usernames:
        return True
    title = getattr(event_chat, "title", None)
    if title and title.lower() in watch_usernames:
        return True
    return False


def load_state() -> Dict[str, int]:
    if not state_file.exists():
        return {}
    try:
        with state_file.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
            return {str(k): int(v) for k, v in data.items()}
    except Exception as exc:
        logger.warning("Failed to load watcher state: %s", exc)
        return {}


def save_state(state: Dict[str, int]) -> None:
    try:
        with state_file.open("w", encoding="utf-8") as handle:
            json.dump(state, handle)
    except Exception as exc:
        logger.warning("Failed to persist watcher state: %s", exc)


def fetch_important_contacts() -> Tuple[Set[int], Set[str]]:
    important_ids: Set[int] = set()
    important_usernames: Set[str] = set()

    if not BACKEND_CONTACT_LIST_URL:
        return important_ids, important_usernames

    try:
        headers = {"Authorization": f"Bearer {BACKEND_NOTIFY_TOKEN}"} if BACKEND_NOTIFY_TOKEN else {}
        params = {"important": "1"}
        if ACCOUNT_ID_NUM is not None:
            params["accountId"] = ACCOUNT_ID_NUM
        elif BACKEND_ACCOUNT_KEY:
            params["accountKey"] = BACKEND_ACCOUNT_KEY
        response = requests.get(BACKEND_CONTACT_LIST_URL, params=params, headers=headers, timeout=5)
        response.raise_for_status()
        data = response.json()
        contacts = data.get("contacts", [])
        for entry in contacts:
            chat_id = entry.get("telegramChatId") or entry.get("telegram_chat_id")
            username = entry.get("telegramUsername") or entry.get("telegram_username")

            if chat_id:
                try:
                    important_ids.add(int(chat_id))
                except (TypeError, ValueError):
                    logger.debug("Skipping non-numeric chat id: %s", chat_id)
            if username:
                important_usernames.add(username.lower())
    except Exception as exc:
        logger.warning("Failed to fetch important contacts: %s", exc)

    return important_ids, important_usernames


def get_state_key(entity) -> str:
    entity_type = entity.__class__.__name__
    entity_id = getattr(entity, "id", None)
    return f"{entity_type}:{entity_id}"


def extract_message_text(message) -> str:
    text = (message.raw_text or "").strip()
    if text:
        return text
    if getattr(message, "message", None):
        text = message.message.strip()
        if text:
            return text
    if getattr(message, "media", None):
        return "[Media message]"
    return "[No text content]"


def send_to_backend(payload: dict) -> bool:
    try:
        if BACKEND_ACCOUNT_KEY:
            payload.setdefault("account_key", BACKEND_ACCOUNT_KEY)
        if ACCOUNT_ID_NUM is not None:
            payload.setdefault("account_id", ACCOUNT_ID_NUM)
        headers = {"Authorization": f"Bearer {BACKEND_NOTIFY_TOKEN}", "Content-Type": "application/json"}
        response = requests.post(BACKEND_NOTIFY_URL, json=payload, headers=headers, timeout=15)
        response.raise_for_status()
        return True
    except Exception as exc:
        logger.warning("Failed to notify backend: %s", exc)
    return False


def sync_contacts_to_backend(contacts_payload):
    if not BACKEND_CONTACT_SYNC_URL or not contacts_payload:
        return
    try:
        headers = {"Authorization": f"Bearer {BACKEND_NOTIFY_TOKEN}", "Content-Type": "application/json"}
        response = requests.post(
            BACKEND_CONTACT_SYNC_URL,
            json={
                "contacts": contacts_payload,
                "accountKey": BACKEND_ACCOUNT_KEY,
                "accountId": ACCOUNT_ID_NUM,
            },
            headers=headers,
            timeout=10,
        )
        response.raise_for_status()
    except Exception as exc:
        logger.warning("Failed to sync contacts: %s", exc)


async def sync_contacts(client):
    if not BACKEND_CONTACT_SYNC_URL:
        logger.info("Contact sync disabled (BACKEND_CONTACT_SYNC_URL not set)")
        return
    try:
        result = await client(GetContactsRequest(hash=0))
        users = result.users
        payload = []
        for user in users:
            name_parts = [part for part in [user.first_name, user.last_name] if part]
            display_name = " ".join(name_parts).strip()
            if not display_name:
                display_name = user.username or (user.phone and f"+{user.phone}") or str(user.id)
            payload.append({
                "name": display_name,
                "firstName": user.first_name,
                "lastName": user.last_name,
                "telegramUsername": user.username,
                "telegramChatId": user.id,
                "telegramPhone": user.phone,
            })
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sync_contacts_to_backend, payload)
        logger.info("Synced %d contacts with backend", len(payload))
    except Exception as exc:
        logger.warning("Failed to gather contacts: %s", exc)


async def periodic_contact_sync(client, interval_seconds=6 * 60 * 60):
    while True:
        await asyncio.sleep(interval_seconds)
        await sync_contacts(client)


async def process_unread_important_messages(client) -> int:
    important_ids, important_usernames = fetch_important_contacts()
    if not important_ids and not important_usernames:
        logger.info("No important contacts configured for unread check.")
        return 0

    state = load_state()
    notifications_sent = 0

    async for dialog in client.iter_dialogs():
        if dialog.unread_count <= 0:
            continue

        entity = dialog.entity
        chat_id = getattr(entity, "id", None)
        username = getattr(entity, "username", None)
        matches_contact = False

        if chat_id is not None and chat_id in IGNORE_CHAT_IDS:
            continue

        if chat_id is not None and chat_id in important_ids:
            matches_contact = True
        elif username and username.lower() in important_usernames:
            matches_contact = True

        if not matches_contact:
            continue

        if not should_forward(entity):
            continue

        state_key = get_state_key(entity)
        last_forwarded = state.get(state_key, 0)
        message_limit = max(dialog.unread_count, 1)
        messages = await client.get_messages(entity, limit=message_limit)

        # Process oldest unread first to preserve chronology
        for message in reversed(messages):
            if message.id <= last_forwarded:
                continue

            message_text = extract_message_text(message)
            payload = {
                "chat_id": chat_id,
                "chat_title": dialog.name or getattr(entity, "title", None),
                "chat_username": username,
                "sender_id": getattr(message, "sender_id", chat_id),
                "sender_username": username,
                "sender_name": dialog.name or getattr(entity, "first_name", "") or getattr(entity, "title", ""),
                "message": message_text,
                "message_id": message.id,
                "date": message.date.isoformat() if getattr(message, "date", None) else None,
                "unread_count": dialog.unread_count,
                "cron_mode": True,
            }

            logger.info(
                "Cron mode forwarding unread message from chat %s (%s)",
                chat_id,
                payload["chat_title"],
            )
            if send_to_backend(payload):
                last_forwarded = max(last_forwarded, message.id)
                notifications_sent += 1
            else:
                logger.debug("Skipping state update because backend send failed for %s", state_key)

        if last_forwarded > state.get(state_key, 0):
            state[state_key] = last_forwarded

    if notifications_sent > 0:
        save_state(state)

    return notifications_sent


async def backfill_history(client) -> int:
    important_ids, important_usernames = fetch_important_contacts()
    if not important_ids and not important_usernames:
        logger.info("No important contacts configured for history backfill.")
        return 0

    state = load_state()
    total_forwarded = 0
    chats_considered = 0
    updated_keys = 0
    limit = BACKFILL_MESSAGE_LIMIT if BACKFILL_MESSAGE_LIMIT > 0 else None
    cutoff = None
    if BACKFILL_DAYS > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS)

    logger.info(
        "Starting history backfill (limit=%s, cutoff=%s)",
        limit if limit is not None else "unbounded",
        cutoff.isoformat() if cutoff else "none",
    )

    async for dialog in client.iter_dialogs():
        entity = dialog.entity
        chat_id = getattr(entity, "id", None)
        username = getattr(entity, "username", None)

        if chat_id is not None and chat_id in IGNORE_CHAT_IDS:
            continue

        matches_contact = False
        if chat_id is not None and chat_id in important_ids:
            matches_contact = True
        elif username and username.lower() in important_usernames:
            matches_contact = True

        if not matches_contact:
            continue

        chats_considered += 1
        state_key = get_state_key(entity)
        last_forwarded = state.get(state_key, 0)
        messages_to_forward = []

        async for message in client.iter_messages(entity, limit=limit):
            if message is None:
                continue
            msg_id = getattr(message, "id", None)
            if msg_id is None:
                continue
            if msg_id <= last_forwarded:
                break
            if cutoff and getattr(message, "date", None):
                try:
                    message_date = (
                        message.date if message.date.tzinfo else message.date.replace(tzinfo=timezone.utc)
                    )
                except AttributeError:
                    message_date = None
                if message_date and message_date < cutoff:
                    break
            messages_to_forward.append(message)

        if not messages_to_forward:
            continue

        logger.info(
            "Backfilling %d messages for chat %s (%s)",
            len(messages_to_forward),
            chat_id,
            dialog.name or getattr(entity, "title", None),
        )

        for message in reversed(messages_to_forward):
            msg_id = getattr(message, "id", None)
            try:
                sender = await message.get_sender()
            except Exception as exc:
                logger.debug("Failed to resolve sender for message %s: %s", msg_id, exc)
                sender = None
            payload = {
                "chat_id": chat_id,
                "chat_title": dialog.name or getattr(entity, "title", None),
                "chat_username": username,
                "sender_id": getattr(sender, "id", None) if sender else getattr(message, "sender_id", chat_id),
                "sender_username": getattr(sender, "username", None) if sender else None,
                "sender_name": getattr(sender, "first_name", None) or getattr(sender, "title", None) or dialog.name,
                "message": extract_message_text(message),
                "message_id": msg_id,
                "date": message.date.isoformat() if getattr(message, "date", None) else None,
                "has_media": bool(getattr(message, "media", None)),
                "history": True,
            }

            if send_to_backend(payload):
                last_forwarded = max(last_forwarded, msg_id)
                total_forwarded += 1
            else:
                logger.debug("Failed to send historical message %s for %s", msg_id, state_key)

        if last_forwarded > state.get(state_key, 0):
            state[state_key] = last_forwarded
            updated_keys += 1

    if updated_keys > 0:
        save_state(state)

    logger.info(
        "History backfill completed. Messages sent: %d across %d chats (state updates: %d)",
        total_forwarded,
        chats_considered,
        updated_keys,
    )
    return total_forwarded


async def main(cron_mode: bool = False, backfill: bool = False) -> int:
    client = TelegramClient(str(session_file), API_ID, API_HASH)

    await client.connect()
    authorized = await client.is_user_authorized()
    if not authorized:
        if cron_mode:
            logger.error(
                "Telegram session not authorized. Run the watcher without --cron to complete the login flow."
            )
            await client.disconnect()
            return 2

        logger.info("Requesting Telegram login code...")
        await client.send_code_request(PHONE_NUMBER)
        try:
            code = input("Enter the code you received: ").strip()
            await client.sign_in(PHONE_NUMBER, code)
        except SessionPasswordNeededError:
            password = input("Two-factor password: ").strip()
            await client.sign_in(password=password)

    if cron_mode:
        # Optional: keep contact list in sync before processing unread messages
        await sync_contacts(client)
        if backfill or BACKFILL_ON_START:
            try:
                await backfill_history(client)
            except Exception as exc:
                logger.warning("History backfill failed in cron mode: %s", exc)
        notifications = await process_unread_important_messages(client)
        logger.info("Cron mode completed. Notifications sent: %d", notifications)
        await client.disconnect()
        return 0

    @client.on(events.NewMessage(incoming=True))
    async def handler(event):  # pylint: disable=unused-variable
        sender = await event.get_sender()
        chat = await event.get_chat()

        if event.is_private and sender.is_self:
            return  # ignore own messages

        chat_id = getattr(chat, "id", None)
        if chat_id is not None and chat_id in IGNORE_CHAT_IDS:
            return

        if not should_forward(chat):
            return

        message_text = event.raw_text or ""
        if not message_text and not event.message.media:
            return

        payload = {
            "chat_id": getattr(chat, "id", None),
            "chat_title": getattr(chat, "title", None),
            "chat_username": getattr(chat, "username", None),
            "sender_id": getattr(sender, "id", None),
            "sender_username": getattr(sender, "username", None),
            "sender_name": getattr(sender, "first_name", ""),
            "message": message_text,
            "message_id": event.id,
            "date": event.date.isoformat(),
            "has_media": event.message.media is not None,
        }

        logger.info("Forwarding message from chat %s (%s)", payload["chat_id"], payload["chat_title"])
        send_to_backend(payload)

    await sync_contacts(client)
    if backfill or BACKFILL_ON_START:
        try:
            await backfill_history(client)
        except Exception as exc:
            logger.warning("History backfill failed: %s", exc)
    asyncio.create_task(periodic_contact_sync(client))

    logger.info("Watcher is running. Listening for new messages...")
    await client.run_until_disconnected()
    return 0


def parse_args():
    parser = argparse.ArgumentParser(description="Telegram watcher for forwarding alerts.")
    parser.add_argument(
        "--cron",
        action="store_true",
        help="Run a single-pass check intended for cron execution.",
    )
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="Send historical messages for important contacts before processing new events.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    cron_env = os.environ.get("CRON_MODE", "")
    cron_mode = args.cron or cron_env.lower() in {"1", "true", "yes", "on"}
    backfill_requested = args.backfill or BACKFILL_ON_START
    try:
        exit_code = asyncio.run(main(cron_mode=cron_mode, backfill=backfill_requested))
    except KeyboardInterrupt:
        logger.info("Watcher stopped by user")
        exit_code = 0
    sys.exit(exit_code or 0)

