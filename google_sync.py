from flask import Flask, request, jsonify
from notion_client import Client
from googleapiclient.discovery import build
from google.oauth2 import service_account
from datetime import datetime, timezone
from dateutil import parser as dtparser
import os
import logging

# ───────────────────────────────────────────────
# 🔧 LOGGING CONFIG
# ───────────────────────────────────────────────

logging.basicConfig(level=logging.DEBUG, format='[%(levelname)s] %(message)s')

# ───────────────────────────────────────────────
# 🔐 CONFIGURATION
# ───────────────────────────────────────────────

SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
SERVICE_ACCOUNT_FILE = 'credentials.json'
NOTION_TOKEN = os.environ.get("NOTION_TOKEN")
DATABASE_ID_SCHEDULE = os.environ.get("DATABASE_ID_SCHEDULE")

# 🔗 Fixed mapping of calendar names to Notion Contexts
CALENDAR_CONTEXT_MAP = {
    "Personal": "Personal",
    "Work": "Work",
    "Riley's Calendar": "Family",
    "Side Project": "Creative",
    "Appointments": "Health",
    "Travel": "Travel",
    "School": "Education"
}

# ───────────────────────────────────────────────
# 🌱 INITIALIZATION
# ───────────────────────────────────────────────

app = Flask(__name__)
notion = Client(auth=NOTION_TOKEN)
credentials = service_account.Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE, scopes=SCOPES)
calendar_service = build('calendar', 'v3', credentials=credentials, cache_discovery=False)

# ───────────────────────────────────────────────
# 🔁 SYNC FUNCTION
# ───────────────────────────────────────────────

def sync_calendar_to_notion():
    try:
        logging.debug("Sync started")
        now = datetime.now(timezone.utc).isoformat()
        calendars = calendar_service.calendarList().list().execute().get('items', [])

        added = 0
        updated = 0

        for calendar in calendars:
            cal_id = calendar['id']
            cal_name = calendar.get('summary', 'Unnamed Calendar')
            context = CALENDAR_CONTEXT_MAP.get(cal_name, cal_name)

            events_result = calendar_service.events().list(
                calendarId=cal_id,
                timeMin=now,
                maxResults=20,
                singleEvents=True,
                orderBy='startTime'
            ).execute()

            events = events_result.get('items', [])
            logging.debug(f"{len(events)} events found in calendar: {cal_name}")

            for event in events:
                gcal_id = event.get('id')
                if not gcal_id:
                    continue

                title = event.get('summary', 'No Title')
                start = event['start'].get('dateTime') or event['start'].get('date')
                end = event['end'].get('dateTime') or event['end'].get('date')

                logging.debug(f"Event: {title} | Start: {start} | GCal ID: {gcal_id}")

                try:
                    start_dt = dtparser.parse(start)
                    end_dt = dtparser.parse(end)
                    duration_minutes = int((end_dt - start_dt).total_seconds() / 60)
                except:
                    duration_minutes = None

                existing = notion.databases.query(
                    database_id=DATABASE_ID_SCHEDULE,
                    filter={
                        "property": "GCal ID",
                        "rich_text": {
                            "equals": gcal_id
                        }
                    }
                )

                properties = {
                    "Name": {"title": [{"text": {"content": title}}]},
                    "Start Time": {"date": {"start": start}},
                    "End Time": {"date": {"start": end}},
                    "Calendar Source": {"rich_text": [{"text": {"content": cal_name}}]},
                    "Context": {"rich_text": [{"text": {"content": context}}]},
                    "GCal ID": {"rich_text": [{"text": {"content": gcal_id}}]}
                }

                if duration_minutes is not None:
                    properties["Duration (mins)"] = {"number": duration_minutes}

                if any(not page.get("archived", False) for page in existing["results"]):
                    notion.pages.update(
                        page_id=existing["results"][0]["id"],
                        properties=properties
                    )
                    updated += 1
                else:
                    notion.pages.create(
                        parent={"database_id": DATABASE_ID_SCHEDULE},
                        properties=properties
                    )
                    added += 1

        logging.info(f"Added {added} | Updated {updated}")
        return {"status": "success", "added": added, "updated": updated}

    except Exception as e:
        logging.error(str(e))
        return {"status": "error", "message": str(e)}

# ───────────────────────────────────────────────
# 🌐 FLASK ROUTES
# ───────────────────────────────────────────────

@app.route("/")
def home():
    return "Google Calendar to Notion sync is live!", 200

@app.route("/sync", methods=["POST"])
def sync():
    result = sync_calendar_to_notion()
    code = 200 if result["status"] == "success" else 500
    return jsonify(result), code

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
