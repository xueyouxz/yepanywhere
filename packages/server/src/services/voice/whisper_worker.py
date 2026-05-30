#!/usr/bin/env python3
"""
Warm faster-whisper subprocess worker for YA local speech recognition.

Loads the model once, then reads JSON requests from stdin and writes
JSON responses to stdout. The Node.js LocalWhisperBackend keeps this
process alive between utterances to avoid per-utterance model load.

Request line:  {"audio_b64":"<base64>","mime_type":"audio/webm;codecs=opus","prompt":"..."}
Response line: {"text":"..."} or {"error":"..."}
Startup line:  {"status":"ready"} (written once after model loads)
"""
import sys
import json
import base64
import tempfile
import os


def suffix_for_mime(mime: str) -> str:
    if "ogg" in mime:
        return ".ogg"
    if "mp4" in mime or "m4a" in mime:
        return ".mp4"
    if "wav" in mime:
        return ".wav"
    if "mp3" in mime:
        return ".mp3"
    return ".webm"


def main() -> None:
    model_name = sys.argv[1] if len(sys.argv) > 1 else "distil-large-v3"
    device = sys.argv[2] if len(sys.argv) > 2 else "cpu"
    compute_type = sys.argv[3] if len(sys.argv) > 3 else "int8"

    sys.stderr.write(
        f"[whisper_worker] Loading {model_name} on {device}/{compute_type}...\n"
    )
    sys.stderr.flush()

    try:
        from faster_whisper import WhisperModel  # type: ignore[import]
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as exc:
        sys.stdout.write(json.dumps({"error": f"Model load failed: {exc}"}) + "\n")
        sys.stdout.flush()
        sys.exit(1)

    sys.stderr.write("[whisper_worker] Model ready\n")
    sys.stderr.flush()
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps({"error": f"JSON error: {exc}"}) + "\n")
            sys.stdout.flush()
            continue

        try:
            audio_bytes = base64.b64decode(req["audio_b64"])
            prompt: str = req.get("prompt") or ""
            suffix = suffix_for_mime(req.get("mime_type", ""))

            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
                fh.write(audio_bytes)
                tmpfile = fh.name

            try:
                segments, _ = model.transcribe(
                    tmpfile,
                    initial_prompt=prompt or None,
                    beam_size=5,
                    vad_filter=True,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
                sys.stdout.write(json.dumps({"text": text}) + "\n")
            finally:
                os.unlink(tmpfile)

        except Exception as exc:
            sys.stdout.write(json.dumps({"error": str(exc)}) + "\n")

        sys.stdout.flush()


if __name__ == "__main__":
    main()
