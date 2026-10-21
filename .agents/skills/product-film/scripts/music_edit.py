"""Cut a track into a film's music: spans of the track back to back, short crossfades at the joins, a fade at the end.

    python3 music_edit.py track.wav film-music.wav 1.05-26.904 38.154-45.8

Each span is source seconds FROM-TO. Choose spans that start and end on beats (beats.py), so joins are musical, and
line the film's cuts up with the same grid. A cutdown's music is the same command on the film's music with the
cutdown's segments. Needs numpy.
"""
import sys
import wave

import numpy as np

src, dst, *spans = sys.argv[1:]
with wave.open(src) as w:
    sr, ch = w.getframerate(), w.getnchannels()
    x = np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, ch).astype(np.float64)
n = int(0.03 * sr)
out = None
for span in spans:
    a, b = (float(v) for v in span.split("-"))
    part = x[int(a * sr):int(b * sr)].copy()
    if out is None:
        out = part
        continue
    r = np.linspace(0, 1, n)[:, None]
    out[-n:] = out[-n:] * (1 - r) + part[:n] * r
    out = np.concatenate([out, part[n:]])
k = int(0.4 * sr)
out[-k:] *= np.linspace(1, 0, k)[:, None]
with wave.open(dst, "wb") as w:
    w.setnchannels(ch)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(np.clip(out, -32768, 32767).astype("<i2").tobytes())
print(dst, round(len(out) / sr, 3), "s")
