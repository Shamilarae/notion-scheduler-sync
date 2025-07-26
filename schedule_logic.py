from notion_client import Client
from notion_client.errors import APIResponseError
from datetime import datetime
from config import NOTION_TOKEN, DATABASE_ID_TASKS, DATABASE_ID_SCHEDULE

notion = Client(auth=NOTION_TOKEN)

def get_tasks():
    response = notion.databases.query(
        **{
            "database_id": DATABASE_ID_TASKS,
            "filter": {
                "and": [
                    {"property": "Status", "select": {"equals": "To Do"}},
                    {"property": "Auto-Schedule", "checkbox": {"equals": True}}
                ]
            }
        }
    )
    return response["results"]

def get_schedule():
    response = notion.databases.query(
        **{
            "database_id": DATABASE_ID_SCHEDULE,
            "filter": {
                "and": [
                    {"property": "Start Time", "date": {"on_or_after": datetime.now().isoformat()}},
                    {"property": "Linked Task", "relation": {"is_empty": True}}
                ]
            },
            "sorts": [{"property": "Start Time", "direction": "ascending"}]
        }
    )
    return response["results"]

def categorize_task(task):
    props = task["properties"]
    priority = props.get("Priority", {}).get("select", {}).get("name", "")
    fixed_time = props.get("Fixed Time", {}).get("date")
    return fixed_time, priority

def assign_task(task_id, block_id):
    notion.pages.update(
        page_id=block_id,
        properties={
            "Linked Task": {
                "relation": [{"id": task_id}]
            },
            "Auto-Filled?": {
                "checkbox": True
            }
        }
    )

def schedule_day():
    try:
        tasks = get_tasks()
        blocks = get_schedule()

        fixed_tasks = []
        routines = []
        high = []
        medium = []
        low = []

        for task in tasks:
            fixed_time, priority = categorize_task(task)
            if fixed_time:
                fixed_tasks.append((fixed_time['start'], task))
            elif priority == "Routine":
                routines.append(task)
            elif priority == "High":
                high.append(task)
            elif priority == "Medium":
                medium.append(task)
            elif priority == "Low":
                low.append(task)

        for time_str, task in fixed_tasks:
            time_obj = datetime.fromisoformat(time_str)
            for block in blocks:
                block_time = datetime.fromisoformat(block["properties"]["Start Time"]["date"]["start"])
                if abs((time_obj - block_time).total_seconds()) < 60:
                    assign_task(task["id"], block["id"])
                    blocks.remove(block)
                    break

        for task in routines:
            if not blocks:
                break
            assign_task(task["id"], blocks.pop(0)["id"])

        for group in [high, medium, low]:
            for task in group:
                if not blocks:
                    break
                assign_task(task["id"], blocks.pop(0)["id"])

        print("✅ Schedule updated successfully.")

    except APIResponseError as error:
        print("❌ Notion API Error:")
        print(error)
