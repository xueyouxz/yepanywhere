#!/usr/bin/env python3
"""
Warm Transformers Parakeet subprocess worker for YA local speech recognition.

Loads the model once, then reads JSON requests from stdin and writes
JSON responses to stdout. The Node.js LocalParakeetBackend keeps this
process alive between utterances to avoid per-utterance model load.

Request line:  {"audio_b64":"<base64>","mime_type":"audio/webm;codecs=opus"}
Response line: {"text":"..."} or {"error":"..."}
Startup line:  {"status":"ready"} (written once after model loads)
"""
import base64
import json
import os
import sys
import tempfile
from typing import Any


def suffix_for_mime(mime: str) -> str:
    if "ogg" in mime:
        return ".ogg"
    if "mp4" in mime or "m4a" in mime:
        return ".mp4"
    if "wav" in mime:
        return ".wav"
    if "mp3" in mime:
        return ".mp3"
    if "flac" in mime:
        return ".flac"
    return ".webm"


def resolve_pipeline_device(device_arg: str, torch: Any) -> int:
    normalized = device_arg.strip().lower()
    if normalized in ("", "auto"):
        return 0 if torch.cuda.is_available() else -1
    if normalized == "cpu":
        return -1
    if normalized == "cuda":
        return 0
    if normalized.startswith("cuda:"):
        return int(normalized.split(":", 1)[1])
    return int(normalized)


def transcript_text(output: Any) -> str:
    if isinstance(output, dict):
        return str(output.get("text") or "").strip()
    if isinstance(output, list):
        return " ".join(transcript_text(item) for item in output).strip()
    return str(output or "").strip()


def summarize_model_load_error(model_name: str, exc: Exception) -> str:
    message = str(exc)
    lower = message.lower()
    if "no space left on device" in lower or "os error 28" in lower:
        return (
            f"Model load failed for {model_name}: no space left on device while "
            "downloading or reconstructing Hugging Face model files. Free the "
            "cache/tmp filesystem used by the server, or set HF_HUB_CACHE, "
            "HF_XET_CACHE, and TMPDIR to a filesystem with enough space before "
            "starting YA."
        )
    if (
        "gated repo" in lower
        or "gated model" in lower
        or "401" in lower
        or "403" in lower
        or "access to model" in lower
    ):
        return (
            f"Model load failed for {model_name}: Hugging Face authentication "
            "or model access is required. Run `pixi run --frozen -e stt hf auth "
            "login`, accept the model terms on Hugging Face if prompted, then "
            "restart YA."
        )
    compact = " ".join(message.split())
    if len(compact) > 700:
        compact = compact[:700].rstrip() + "..."
    return f"Model load failed for {model_name}: {compact}"


def main() -> None:
    model_name = sys.argv[1] if len(sys.argv) > 1 else "nvidia/parakeet-tdt-0.6b-v3"
    device_arg = sys.argv[2] if len(sys.argv) > 2 else "auto"

    sys.stderr.write(
        f"[parakeet_worker] Loading {model_name} on device={device_arg}...\n"
    )
    sys.stderr.flush()

    try:
        import torch  # type: ignore[import]
        from transformers import pipeline  # type: ignore[import]

        device = resolve_pipeline_device(device_arg, torch)
        torch_dtype = torch.bfloat16 if device >= 0 else torch.float32
        pipe = pipeline(
            "automatic-speech-recognition",
            model=model_name,
            device=device,
            dtype=torch_dtype,
        )
    except Exception as exc:
        sys.stdout.write(
            json.dumps({"error": summarize_model_load_error(model_name, exc)}) + "\n"
        )
        sys.stdout.flush()
        sys.exit(1)

    sys.stderr.write("[parakeet_worker] Model ready\n")
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
            suffix = suffix_for_mime(req.get("mime_type", ""))

            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
                fh.write(audio_bytes)
                tmpfile = fh.name

            try:
                output = pipe(tmpfile)
                sys.stdout.write(json.dumps({"text": transcript_text(output)}) + "\n")
            finally:
                os.unlink(tmpfile)

        except Exception as exc:
            sys.stdout.write(json.dumps({"error": str(exc)}) + "\n")

        sys.stdout.flush()


if __name__ == "__main__":
    main()
