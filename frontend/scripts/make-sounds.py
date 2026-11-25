"""Writes the two sounds of the guided capture for the app (assets/sounds), the same tones the site plays with the
browser's Web Audio (components/capture/feedback.ts): "plin" (a movement worked) and a low buzz (it did not).
Synthesised here: no recording, no outside file.   python3 scripts/make-sounds.py"""
import math
import struct
import wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / "assets" / "sounds"


def tone(samples, freq, start, length, shape, volume):
    for i in range(int(length * RATE)):
        t = i / RATE
        attack = min(1.0, t / 0.01)
        decay = math.exp(-5.0 * t / length)
        phase = 2 * math.pi * freq * t
        wave_ = math.sin(phase) if shape == "sine" else 2 / math.pi * math.asin(math.sin(phase))
        k = int(start * RATE) + i
        samples[k] += volume * attack * decay * wave_


def write(name, parts, total):
    samples = [0.0] * int(total * RATE)
    for p in parts:
        tone(samples, *p)
    with wave.open(str(OUT / name), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32000)) for s in samples))


OUT.mkdir(parents=True, exist_ok=True)
write("plin.wav", [(1047, 0, 0.18, "sine", 0.25), (1568, 0.09, 0.3, "sine", 0.22)], 0.45)
write("buzz.wav", [(196, 0, 0.28, "triangle", 0.3)], 0.32)
print("ok:", sorted(p.name for p in OUT.iterdir()))
