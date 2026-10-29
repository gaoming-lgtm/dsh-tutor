"""常驻离线语音识别进程（faster-whisper，CPU）。

stdin 每行: {"id":"...","path":"...wav","language":"zh"}
stdout 每行: {"id":"...","text":"..."} 或 {"id":"...","error":"..."}
首次运行会从镜像下载模型（small 约 460MB）。
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
_OUT = sys.stdout


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), file=_OUT, flush=True)


def main():
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    os.makedirs(model_dir, exist_ok=True)
    sys.stderr.write("loading model...\n")
    sys.stderr.flush()

    from faster_whisper import WhisperModel

    name = os.environ.get("WHISPER_MODEL", "small")
    local = os.path.join(model_dir, "faster-whisper-small")
    target = local if os.path.exists(os.path.join(local, "model.bin")) else name
    threads = min(8, os.cpu_count() or 4)
    model = WhisperModel(target, device="cpu", compute_type="int8", cpu_threads=threads, download_root=model_dir)
    emit({"ready": True, "model": target})

    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "error": f"bad request: {e}"})
            continue
        rid = str(req.get("id") or "x")
        path = req.get("path") or ""
        lang = req.get("language") or "zh"
        try:
            segments, _info = model.transcribe(path, language=lang, vad_filter=True, beam_size=1)
            text = "".join(seg.text for seg in segments).strip()
            emit({"id": rid, "text": text})
        except Exception as e:
            emit({"id": rid, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
