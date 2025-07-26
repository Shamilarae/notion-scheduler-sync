from flask import Flask, request
import os
from dotenv import load_dotenv
from schedule_logic import schedule_day  # now coming from the new file

# Load environment variables
load_dotenv()

app = Flask(__name__)

@app.route("/webhook", methods=["GET"])
def webhook():
    key = request.args.get("key")
    expected_key = os.getenv("API_KEY")

    print("Received key:", key)
    print("Expected key:", expected_key)

    if key != expected_key:
        return "Forbidden", 403

    schedule_day()
    return "Success", 200

if __name__ == "__main__":
    app.run(port=5000)
