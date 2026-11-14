"""
Speed check: where is the time going?

    python3 speed_check.py                      # test the default model
    python3 speed_check.py MODEL_NAME            # test a different model
    python3 speed_check.py MODEL_NAME lecture.pdf

Runs small Gemini calls with retries OFF and a 30-second limit, so a slow or
hanging model fails fast instead of waiting forever.
"""
import os
import sys
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GEMINI_OUTLINE_MODEL", "gemini-3.8-flash")
PDF = sys.argv[2] if len(sys.argv) > 2 else None

client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options=types.HttpOptions(
        timeout=30_000,  # milliseconds
        retry_options=types.HttpRetryOptions(attempts=1),
    ),
)


def timed(name, **kwargs):
    t0 = time.time()
    try:
        r = client.models.generate_content(model=MODEL, **kwargs)
        print(f"{name}: {time.time() - t0:.1f}s  ->  {r.text[:80]!r}")
    except Exception as e:
        print(f"{name}: FAILED after {time.time() - t0:.1f}s  ->  {type(e).__name__}: {str(e)[:200]}")


print(f"Model: {MODEL}\n")
print("Models your key can use (Flash ones):")
try:
    names = [m.name.removeprefix("models/") for m in client.models.list()]
    print("  " + ", ".join(n for n in names if "flash" in n) + "\n")
except Exception as e:
    print(f"  couldn't list models: {e}\n")

timed("1. tiny text call", contents="Say hi in three words.")
timed("2. same, thinking LOW", contents="Say hi in three words.",
      config={"thinking_config": {"thinking_level": "LOW"}})

if PDF:
    with open(PDF, "rb") as f:
        pdf = types.Part.from_bytes(data=f.read(), mime_type="application/pdf")
    timed("3. read the PDF, one-line answer", contents=[pdf, "How many slides is this? Answer with a number only."],
          config={"thinking_config": {"thinking_level": "LOW"}})
