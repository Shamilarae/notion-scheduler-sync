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
            props = page["properties"]
            title_prop = props.get("Name", {}).get("title", [])
            if not title_prop:
                logging.warning(f"Skipping page with missing title: {page['id']}")
                continue
            title = title_prop[0]["text"]["content"]

            try:
                start = props["Start Time"]["date"]["start"]
                end = props["End Time"]["date"].get("start") if props["End Time"]["date"] else None
                context = props["Context"]["select"]["name"]
                type_value = props["Type"]["select"]["name"]
            except Exception as e:
                logging.warning(f"Skipping page due to missing fields: {page['id']} | {e}")
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
