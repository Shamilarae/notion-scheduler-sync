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

SCOPES = ['https://www.googleapis.com/auth/calendar']
SERVICE_ACCOUNT_FILE = 'credentials.json'
NOTION_TOKEN = os.environ.get("NOTION_TOKEN")
DATABASE_ID_SCHEDULE = os.environ.get("DATABASE_ID_SCHEDULE")

CONTEXT_TYPE_TO_CALENDAR_ID = {
    ("Personal", "Events"): "shamilarae@gmail.com",
    ("Personal", "Admin"): "ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com",
    ("Personal", "Appointment"): "0nul0g0lvc35c0jto1u5k5o87s@group.calendar.google.com",
    ("Family", "Events"): "family13053487624784455294@group.calendar.google.com",
    ("Work", "Travel"): "oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com",
    ("Work", "Admin"): "25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com",
    ("Work", "Deep Work"): "09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com",
    ("Work", "Meeting"): "80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com",
    ("Work", "Routine"): "a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com"
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
# 🔁 SYNC FUNCTION: Google → Notion
# ───────────────────────────────────────────────

def sync_calendar_to_notion():
    try:
        logging.debug("Sync started")
        now = datetime.now(timezone.utc).isoformat()

        added = 0
        updated = 0

        for (context, type_value), cal_id in CONTEXT_TYPE_TO_CALENDAR_ID.items():
            events_result = calendar_service.events().list(
                calendarId=cal_id,
                timeMin=now,
                maxResults=20,
                singleEvents=True,
                orderBy='startTime'
            ).execute()

            events = events_result.get('items', [])
            logging.debug(f"{len(events)} events found in calendar: {cal_id}")

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
                    "GCal ID": {"rich_text": [{"text": {"content": gcal_id}}]},
                    "Context": {"select": {"name": context}},
                    "Type": {"select": {"name": type_value}}
                }

                if duration_minutes is not None:
                    properties["Duration"] = {"number": duration_minutes}

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
# 🔁 PUSH FUNCTION: Notion → Google
# ───────────────────────────────────────────────

def push_notion_to_calendar():
    try:
        logging.debug("Push started")
        new_pages = notion.databases.query(
            database_id=DATABASE_ID_SCHEDULE,
            filter={
                "property": "GCal ID",
                "rich_text": {
                    "is_empty": True
                }
            }
        )["results"]

        pushed = 0

        for page in new_pages:
            props = page.get("properties", {})

            try:
                title = props["Name"]["title"][0]["text"]["content"]
                start = props["Start Time"]["date"]["start"]
                end = props["End Time"]["date"].get("start") if props["End Time"].get("date") else None
                context = props["Context"]["select"]["name"]
                type_value = props["Type"]["select"]["name"]
            except (KeyError, IndexError, TypeError) as e:
                logging.warning(f"Skipping invalid Notion page due to missing field: {e}")
                continue

            calendar_id = CONTEXT_TYPE_TO_CALENDAR_ID.get((context, type_value))
            if not calendar_id:
                logging.warning(f"No calendar ID found for context '{context}' and type '{type_value}'")
                continue

            event = {
                'summary': title,
                'start': {'dateTime': start},
                'end': {'dateTime': end if end else start},
            }

            created = calendar_service.events().insert(calendarId=calendar_id, body=event).execute()
            gcal_id = created["id"]

            notion.pages.update(
                page_id=page["id"],
                properties={
                    "GCal ID": {"rich_text": [{"text": {"content": gcal_id}}]}
                }
            )
            pushed += 1

        logging.info(f"Pushed {pushed} events to Google Calendar")
        return {"status": "success", "pushed": pushed}

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

@app.route("/push", methods=["POST"])
def push():
    result = push_notion_to_calendar()
    code = 200 if result["status"] == "success" else 500
    return jsonify(result), code

@app.route("/sync_and_push", methods=["POST"])
def sync_and_push():
    sync_result = sync_calendar_to_notion()
    push_result = push_notion_to_calendar()
    code = 200 if sync_result["status"] == "success" and push_result["status"] == "success" else 500
    return jsonify({
        "sync": sync_result,
        "push": push_result
    }), code

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
