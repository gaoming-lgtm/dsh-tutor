"""Persistent Edge TTS worker.

Reads one JSON request per line from stdin:
  {"id": "...", "text": "...", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%"}
Writes a JSON reply per line:
  {"id": "...", "path": "...", "bytes": 12345}
  {"id": "...", "error": "..."}

Microsoft moved Edge Read Aloud synthesis to api.msedgeservices.com in Oct 2026;
the legacy speech.platform.bing.com host now returns 403 outside a few regions.
The new host takes the client token as Ocp-Apim-Subscription-Key.
"""
import asyncio
import json
import os
import sys

# setup.ps1 把 edge-tts 装在本目录旁的 vendor/ 里（嵌入式 Python 不会读 PYTHONPATH），
# 所以这里手动把它加进 sys.path。
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)

import edge_tts
import edge_tts.constants as C
import edge_tts.communicate as M

TRUSTED = C.TRUSTED_CLIENT_TOKEN
M.WSS_URL = (
    "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
    f"?Ocp-Apim-Subscription-Key={TRUSTED}"
)

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "data", "tts")


async def synth(req):
    rid = str(req["id"])
    text = str(req["text"])[:1200]
    voice = req.get("voice") or "zh-CN-XiaoxiaoNeural"
    rate = req.get("rate") or "+0%"
    pitch = req.get("pitch") or "+0Hz"
    path = os.path.join(OUT_DIR, f"{rid}.mp3")

    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    total = 0
    with open(path, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
                total += len(chunk["data"])
    if total < 500:
        raise RuntimeError(f"too little audio ({total} bytes)")
    return {"id": rid, "path": path, "bytes": total}


async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"ready": True}), flush=True)
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({"id": None, "error": f"bad request: {e}"}), flush=True)
            continue
        try:
            res = await synth(req)
        except Exception as e:
            res = {"id": req.get("id"), "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(res), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
