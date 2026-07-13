"""
Local Whisper API (OpenAI-compatible) for Windows + NVIDIA GPU.

POST /v1/audio/transcriptions
GET  /health
"""

from __future__ import annotations

import io
import os
import shutil
import site
import sys
import tempfile
import time
import traceback
import wave
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np


def _add_nvidia_dll_dirs() -> list[str]:
    """Windows: put pip-installed CUDA DLLs (cublas64_12.dll etc.) on PATH."""
    if os.name != "nt":
        return []

    candidates: list[str] = []
    site_dirs: list[str] = []
    try:
        site_dirs.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        us = site.getusersitepackages()
        if us:
            site_dirs.append(us)
    except Exception:
        pass
    # venv site-packages
    sp = Path(sys.prefix) / "Lib" / "site-packages"
    if sp.is_dir():
        site_dirs.append(str(sp))

    subpaths = [
        Path("nvidia") / "cublas" / "bin",
        Path("nvidia") / "cuda_runtime" / "bin",
        Path("nvidia") / "cudnn" / "bin",
        Path("nvidia") / "cuda_nvrtc" / "bin",
        Path("nvidia") / "cufft" / "bin",
    ]

    for base in site_dirs:
        for sub in subpaths:
            d = Path(base) / sub
            if d.is_dir():
                candidates.append(str(d.resolve()))

    # de-dupe preserve order
    seen = set()
    dirs: list[str] = []
    for d in candidates:
        if d not in seen:
            seen.add(d)
            dirs.append(d)

    for d in dirs:
        try:
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(d)
        except Exception:
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

    return dirs


_NVIDIA_DIRS = _add_nvidia_dll_dirs()

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel

# ---------- config ----------
MODEL_SIZE = os.getenv("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")  # cuda | cpu
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
HOST = os.getenv("WHISPER_HOST", "0.0.0.0")
PORT = int(os.getenv("WHISPER_PORT", "9000"))
CORS_ORIGINS = os.getenv("WHISPER_CORS", "*").split(",")
TARGET_SR = 16000

model: WhisperModel | None = None
active_device: str = DEVICE
active_compute: str = COMPUTE_TYPE
load_error: str | None = None
loaded_at: float | None = None


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _create_model(device: str, compute_type: str) -> WhisperModel:
    return WhisperModel(MODEL_SIZE, device=device, compute_type=compute_type)


def _warmup(m: WhisperModel) -> None:
    """Force a real encode so missing cublas shows up at startup, not mid-request."""
    audio = np.zeros(TARGET_SR, dtype=np.float32)
    segments, _info = m.transcribe(
        audio,
        language="en",
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    # consume generator (this triggers encode)
    for _ in segments:
        pass


def load_model() -> None:
    global model, load_error, loaded_at, active_device, active_compute

    if _NVIDIA_DIRS:
        print(f"[whisper] NVIDIA DLL dirs: {_NVIDIA_DIRS}")
    else:
        print("[whisper] No pip NVIDIA DLL dirs found (ok if system CUDA is installed)")

    prefer = (DEVICE or "cuda").lower()
    print(f"[whisper] loading model={MODEL_SIZE} prefer_device={prefer} compute={COMPUTE_TYPE}")
    t0 = time.time()

    errors: list[str] = []

    attempts: list[tuple[str, str]] = []
    if prefer == "cuda":
        attempts.append(("cuda", COMPUTE_TYPE or "float16"))
        # float16 sometimes needs full cublas; try int8_float16 too
        if (COMPUTE_TYPE or "") != "int8_float16":
            attempts.append(("cuda", "int8_float16"))
    attempts.append(("cpu", "int8"))

    # unique attempts
    seen = set()
    uniq: list[tuple[str, str]] = []
    for a in attempts:
        if a not in seen:
            seen.add(a)
            uniq.append(a)

    last_err: Exception | None = None
    for device, ctype in uniq:
        try:
            print(f"[whisper] try device={device} compute={ctype} ...")
            m = _create_model(device, ctype)
            _warmup(m)
            model = m
            active_device = device
            active_compute = ctype
            loaded_at = time.time()
            load_error = None if device == prefer else f"fallback to {device}/{ctype}"
            print(
                f"[whisper] ready in {loaded_at - t0:.1f}s "
                f"(device={active_device}, compute={active_compute})"
            )
            print(f"[whisper] ffmpeg on PATH: {has_ffmpeg()}")
            return
        except Exception as e:
            last_err = e
            errors.append(f"{device}/{ctype}: {e}")
            print(f"[whisper] failed {device}/{ctype}: {e}")

    model = None
    load_error = " | ".join(errors) if errors else str(last_err)
    raise RuntimeError(load_error)


def reload_cpu_fallback(reason: str) -> None:
    global model, active_device, active_compute, load_error, loaded_at
    print(f"[whisper] switching to CPU due to: {reason}")
    model = _create_model("cpu", "int8")
    _warmup(model)
    active_device = "cpu"
    active_compute = "int8"
    loaded_at = time.time()
    load_error = f"CUDA runtime error, using CPU: {reason}"
    print("[whisper] CPU model ready")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_model()
    yield


app = FastAPI(title="Local Whisper (RTX)", version="1.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


def wav_bytes_to_float32(raw: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(raw), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        frames = wf.readframes(n_frames)

    if sampwidth == 2:
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sampwidth == 1:
        audio = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported WAV sample width: {sampwidth}")

    if n_channels > 1:
        audio = audio.reshape(-1, n_channels).mean(axis=1)

    if framerate != TARGET_SR and len(audio) > 0:
        duration = len(audio) / float(framerate)
        new_len = max(1, int(duration * TARGET_SR))
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=new_len, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)

    return np.ascontiguousarray(audio, dtype=np.float32)


def load_audio_array(raw: bytes, filename: str) -> np.ndarray:
    name = (filename or "").lower()
    if name.endswith(".wav") or raw[:4] == b"RIFF":
        return wav_bytes_to_float32(raw)

    suffix = Path(filename or "audio.webm").suffix or ".webm"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        from faster_whisper.audio import decode_audio

        audio = decode_audio(tmp_path, sampling_rate=TARGET_SR)
        return np.ascontiguousarray(audio, dtype=np.float32)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def audio_stats(audio: np.ndarray) -> dict:
    if audio.size == 0:
        return {"samples": 0, "seconds": 0.0, "rms": 0.0, "peak": 0.0}
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio))))
    return {
        "samples": int(audio.size),
        "seconds": round(audio.size / TARGET_SR, 3),
        "rms": round(rms, 5),
        "peak": round(peak, 5),
    }


def maybe_normalize(audio: np.ndarray, target_peak: float = 0.7) -> np.ndarray:
    """Boost quiet captures a bit (tab audio often low)."""
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak < 1e-4:
        return audio
    if peak < 0.15:
        gain = min(target_peak / peak, 12.0)
        return np.clip(audio * gain, -1.0, 1.0).astype(np.float32)
    return audio


def run_transcribe(audio: np.ndarray, language: str | None, temperature: float, prompt: str | None):
    assert model is not None
    # Short live chunks: VAD often wipes everything — keep off unless long
    use_vad = audio.size >= TARGET_SR * 6.0
    segments, info = model.transcribe(
        audio,
        language=language or None,
        task="transcribe",
        beam_size=1,
        best_of=1,
        temperature=temperature,
        vad_filter=use_vad,
        condition_on_previous_text=False,
        initial_prompt=prompt or None,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.4,
    )
    parts = []
    segs = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        parts.append(text)
        segs.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
    return " ".join(parts).strip(), segs, info


@app.get("/health")
def health():
    gpu = None
    try:
        import ctranslate2

        gpu = {"cuda_device_count": ctranslate2.get_cuda_device_count()}
    except Exception:
        pass

    return {
        "ok": model is not None,
        "model": MODEL_SIZE,
        "device": active_device,
        "compute_type": active_compute,
        "requested_device": DEVICE,
        "load_error": load_error,
        "loaded_at": loaded_at,
        "gpu": gpu,
        "ffmpeg": has_ffmpeg(),
        "nvidia_dll_dirs": _NVIDIA_DIRS,
        "prefer_wav": True,
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str | None = Form(None, alias="model"),
    language: str | None = Form("en"),
    response_format: str | None = Form("json"),
    temperature: float | None = Form(0.0),
    prompt: str | None = Form(None),
):
    if model is None:
        raise HTTPException(503, f"Model not loaded: {load_error}")

    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty audio file")

    filename = file.filename or "audio.wav"
    print(
        f"[whisper] recv file={filename!r} bytes={len(raw)} "
        f"content_type={file.content_type!r} lang={language!r}"
    )

    try:
        audio = load_audio_array(raw, filename)
        stats = audio_stats(audio)
        print(f"[whisper] audio stats: {stats}")

        if stats["samples"] < TARGET_SR * 0.15:
            return {"text": "", "language": language or "en", "elapsed_sec": 0.0, "stats": stats}

        if stats["rms"] < 0.0005:
            print("[whisper] warning: near-silent audio (rms very low)")
            return {
                "text": "",
                "language": language or "en",
                "elapsed_sec": 0.0,
                "stats": stats,
                "warning": "silent_audio",
            }

        audio = maybe_normalize(audio)
        temp = 0.0 if temperature is None else float(temperature)

        t0 = time.time()
        try:
            full, segs, info = run_transcribe(audio, language, temp, prompt)
        except Exception as e:
            msg = str(e)
            if active_device == "cuda" and (
                "cublas" in msg.lower()
                or "cudnn" in msg.lower()
                or "cuda" in msg.lower()
                or "dll" in msg.lower()
            ):
                reload_cpu_fallback(msg)
                full, segs, info = run_transcribe(audio, language, temp, prompt)
            else:
                raise

        elapsed = round(time.time() - t0, 3)
        print(f"[whisper] ok text_len={len(full)} elapsed={elapsed}s device={active_device}")

        if response_format == "text":
            return PlainTextResponse(full)

        if response_format == "verbose_json":
            return {
                "task": "transcribe",
                "language": info.language,
                "duration": info.duration,
                "text": full,
                "segments": segs,
                "elapsed_sec": elapsed,
                "stats": stats,
                "device": active_device,
            }

        return {
            "text": full,
            "language": getattr(info, "language", language),
            "elapsed_sec": elapsed,
            "stats": stats,
            "device": active_device,
        }
    except HTTPException:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[whisper] ERROR:\n{tb}")
        detail = f"{type(e).__name__}: {e}"
        return JSONResponse(status_code=500, content={"error": detail, "detail": detail})


@app.get("/")
def root():
    return {
        "service": "local-whisper",
        "docs": "/docs",
        "health": "/health",
        "transcribe": "POST /v1/audio/transcriptions",
        "device": active_device,
        "ffmpeg": has_ffmpeg(),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
