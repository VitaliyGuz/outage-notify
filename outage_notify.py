#!/usr/bin/env python3
"""Telegram alert ahead of a scheduled power outage (Poltavaoblenergo GPV queue).

Meant to run once a minute (launchd, com.vitalii.outage-notify.plist):

    outage_notify.py run       check the schedule, send an alert if one is due
    outage_notify.py show      print the schedule for the configured queue
    outage_notify.py json      the same schedule as JSON
    outage_notify.py chat-id   list chats that wrote to the bot (to fill TELEGRAM_CHAT_ID)
    outage_notify.py test      send a test message

Settings live in config.env next to this file.
"""
import gzip
import json
import math
import re
import sys
import urllib.parse
import urllib.request
import zlib
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.env"
STATE = HERE / "state.json"
LOG = HERE / "notify.log"

SOURCE = "https://www.poe.pl.ua/customs/dynamicgpv-info.php"
KYIV = ZoneInfo("Europe/Kyiv")
REFRESH = timedelta(minutes=10)
RETRY = timedelta(minutes=2)
FAIL_ALERT_AFTER = timedelta(hours=1)

MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня",
          "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"]
DATE_RE = re.compile(r"(\d{1,2}) (%s) (\d{4}) року" % "|".join(MONTHS))

# Half-hour cell states, as the source colours them: on / off / switching time after an outage,
# when the power is as a rule back already; it counts as on.
ON, OFF, MAYBE = "1", "2", "3"
CELLS = 48


def load_config():
    cfg = {"QUEUE": "3.1", "LEAD_MINUTES": "15"}
    for line in CONFIG.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.lstrip().startswith("#"):
            cfg[key.strip()] = value.strip()
    return cfg


def require(cfg, *keys):
    missing = [k for k in keys if not cfg.get(k)]
    if missing:
        sys.exit(f"{CONFIG}: fill in {', '.join(missing)}")


def log(message):
    with LOG.open("a") as f:
        f.write(f"{datetime.now(KYIV):%Y-%m-%d %H:%M:%S} {message}\n")


def fetch():
    # Compressed, the page is a dozen times smaller; urllib neither asks for that nor unpacks it itself.
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "outage-notify (personal schedule alert)",
                                                  "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            try:
                body = gzip.decompress(body)
            except (EOFError, zlib.error) as e:
                # Reported like any other failed download, so the cached schedule stays in use.
                raise OSError(f"damaged gzip answer: {e}") from e
    return body.decode("utf-8", errors="replace")


def parse_schedule(html, queue):
    """Map ISO date -> 48 half-hour states for the queue, one entry per day the source publishes."""
    days = {}
    for block in html.split('class="gpvinfodetail"')[1:]:
        block = re.sub(r"<style.*?</style>", "", block, flags=re.S)
        day = DATE_RE.search(block)
        table = re.search(r"<table.*?</table>", block, re.S)
        if not day or not table:
            continue
        row = re.search(r'<tr[^>]*>\s*<t[dh] class="gpv-q[^"]*"[^>]*>\s*%s\s*<.*?</tr>' % re.escape(queue),
                        table.group(0), re.S)
        if not row:
            continue
        cells = "".join(re.findall(r'<td class="gpv-c gpv-s([123])', row.group(0)))
        if len(cells) != CELLS:
            raise ValueError(f"queue {queue}: expected {CELLS} half-hour cells, got {len(cells)}")
        d = date(int(day.group(3)), MONTHS.index(day.group(2)) + 1, int(day.group(1)))
        days[d.isoformat()] = cells
    if not days:
        raise ValueError(f"queue {queue} not found in the schedule (layout changed?)")
    return days


def outages(cells):
    """Runs of OFF half-hours as (start, end, late) cell indexes; late closes the switching half-hours
    right after a run, while the power may still be on its way back."""
    runs, i = [], 0
    while i < len(cells):
        if cells[i] != OFF:
            i += 1
            continue
        j = i
        while j < len(cells) and cells[j] == OFF:
            j += 1
        late = j
        while late < len(cells) and cells[late] == MAYBE:
            late += 1
        runs.append((i, j, late))
        i = j
    return runs


def hhmm(cell):
    return "24:00" if cell == CELLS else f"{cell // 2:02d}:{cell % 2 * 30:02d}"


def due(days, queue, now, lead):
    """Alerts whose outage starts within the lead time: (key, text)."""
    for iso, cells in sorted(days.items()):
        d = date.fromisoformat(iso)
        previous = days.get((d - timedelta(days=1)).isoformat())
        for start, end, late in outages(cells):
            # An outage running over midnight is the previous day's, already announced.
            if start == 0 and previous and previous[-1] == OFF:
                continue
            starts_at = datetime(d.year, d.month, d.day, start // 2, start % 2 * 30, tzinfo=KYIV)
            if not starts_at - lead <= now < starts_at:
                continue
            minutes = math.ceil((starts_at - now).total_seconds() / 60)
            text = f"⚡ Очередь {queue}: через {minutes} мин отключение света, {hhmm(start)}–{hhmm(end)}."
            if late > end:
                text += f" Включение может задержаться до {hhmm(late)}."
            yield f"{iso}T{hhmm(start)}", text


def telegram(cfg, method, **params):
    req = urllib.request.Request(f"https://api.telegram.org/bot{cfg['TELEGRAM_BOT_TOKEN']}/{method}",
                                 data=urllib.parse.urlencode(params).encode())
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["result"]


def send(cfg, text):
    telegram(cfg, "sendMessage", chat_id=cfg["TELEGRAM_CHAT_ID"], text=text)


def refresh(state, queue, now):
    """Re-read the schedule when the cached copy is stale; a failure keeps the cache and is retried sooner."""
    today_known = now.date().isoformat() in state["days"]
    checked = state.get("checked_at")
    wait = REFRESH if today_known and not state.get("failing_since") else RETRY
    if checked and now - datetime.fromisoformat(checked) < wait:
        return
    state["checked_at"] = now.isoformat()
    try:
        fresh = parse_schedule(fetch(), queue)
    except (OSError, ValueError) as e:
        if not state.get("failing_since"):
            state["failing_since"] = now.isoformat()
            log(f"schedule unavailable: {e}")
        return
    if state.pop("failing_since", None):
        state.pop("fail_alerted", None)
        log("schedule available again")
    for iso, cells in fresh.items():
        if state["days"].get(iso) not in (None, cells):
            log(f"schedule changed for {iso}: {cells}")
        state["days"][iso] = cells


def run(cfg, now=None, deliver=send):
    require(cfg, "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")
    now = now or datetime.now(KYIV)
    state = {"days": {}, "notified": []}
    if STATE.exists():
        state.update(json.loads(STATE.read_text()))
    try:
        refresh(state, cfg["QUEUE"], now)
        failing = state.get("failing_since")
        if failing and not state.get("fail_alerted") and now - datetime.fromisoformat(failing) >= FAIL_ALERT_AFTER:
            deliver(cfg, f"❗ Не удаётся получить график отключений (очередь {cfg['QUEUE']}) "
                         f"с {datetime.fromisoformat(failing):%H:%M}. Уведомления могут не прийти.")
            state["fail_alerted"] = True
        for key, text in due(state["days"], cfg["QUEUE"], now, timedelta(minutes=int(cfg["LEAD_MINUTES"]))):
            if key in state["notified"]:
                continue
            deliver(cfg, text)
            state["notified"].append(key)
            log(f"sent {key}: {text}")
    except OSError as e:
        # The alert stays unmarked, so the next run retries it while it is still ahead of the outage.
        log(f"telegram send failed: {e}")
    finally:
        keep_from = (now.date() - timedelta(days=1)).isoformat()
        state["days"] = {iso: c for iso, c in state["days"].items() if iso >= keep_from}
        state["notified"] = [k for k in state["notified"] if k >= keep_from]
        STATE.write_text(json.dumps(state, indent=1))


def show(cfg):
    for iso, cells in sorted(parse_schedule(fetch(), cfg["QUEUE"]).items()):
        print(f"{iso}  queue {cfg['QUEUE']}  {cells}")
        for start, end, late in outages(cells):
            tail = f"  (may last until {hhmm(late)})" if late > end else ""
            print(f"  {hhmm(start)}-{hhmm(end)}  off{tail}")


def as_json(cfg):
    status = {ON: "on", OFF: "off", MAYBE: "maybe"}
    days = []
    for iso, cells in sorted(parse_schedule(fetch(), cfg["QUEUE"]).items()):
        days.append({
            "date": iso,
            "outages": [{"from": hhmm(start), "to": hhmm(end), "may_last_until": hhmm(late) if late > end else None}
                        for start, end, late in outages(cells)],
            "slots": [{"from": hhmm(i), "to": hhmm(i + 1), "status": status[c]} for i, c in enumerate(cells)],
        })
    print(json.dumps({"queue": cfg["QUEUE"], "source": SOURCE, "days": days}, ensure_ascii=False, indent=2))


def chat_id(cfg):
    require(cfg, "TELEGRAM_BOT_TOKEN")
    chats = {}
    for update in telegram(cfg, "getUpdates"):
        chat = (update.get("message") or update.get("channel_post") or {}).get("chat")
        if chat:
            chats[chat["id"]] = chat.get("title") or chat.get("username") or chat.get("first_name", "")
    if not chats:
        sys.exit("No chats yet: send /start to the bot in Telegram, then run this again.")
    for cid, name in chats.items():
        print(f"{cid}  {name}")


def test(cfg):
    require(cfg, "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")
    send(cfg, f"✅ Уведомления об отключениях настроены: очередь {cfg['QUEUE']}, "
              f"за {cfg['LEAD_MINUTES']} мин до отключения.")
    print("sent")


COMMANDS = {"run": run, "show": show, "json": as_json, "chat-id": chat_id, "test": test}

if __name__ == "__main__":
    command = COMMANDS.get(sys.argv[1] if len(sys.argv) == 2 else "")
    if not command:
        sys.exit(__doc__)
    command(load_config())
