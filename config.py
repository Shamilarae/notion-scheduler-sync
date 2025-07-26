import os
from dotenv import load_dotenv

# Load variables from the .env file into your environment
load_dotenv()

# These will now be available to all your scripts
NOTION_TOKEN = os.getenv("NOTION_TOKEN")
DATABASE_ID_TASKS = os.getenv("DATABASE_ID_TASKS")
DATABASE_ID_SCHEDULE = os.getenv("DATABASE_ID_SCHEDULE")

# Optional: Add this to test if it loaded correctly
if __name__ == "__main__":
    print("NOTION_TOKEN:", NOTION_TOKEN[:6] + "...")
    print("TASK DB ID:", DATABASE_ID_TASKS)
    print("SCHEDULE DB ID:", DATABASE_ID_SCHEDULE)
