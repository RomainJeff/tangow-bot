"""Find a track's beat grid and section energy, to cut a film on it.

    python3 beats.py track.wav [--min-bpm 80] [--max-bpm 170]

Prints the tempo, the first beat, the downbeat offset and the mean level of every bar. Convert the track to WAV first
(ffmpeg -i track.mp3 -ac 2 -ar 48000 track.wav). Needs numpy. Tempo autocorrelation can land on half or double time:
check the bar list against the music's phrasing (energy repeating every 2 or 4 bars).
"""
import argparse
import wave

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("wav")
ap.add_argument("--min-bpm", type=float, default=80)
ap.add_argument("--max-bpm", type=float, default=170)
a = ap.parse_args()

w = wave.open(a.wav)
sr, ch = w.getframerate(), w.getnchannels()
x = np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, ch).mean(1) / 32768
hop, win = 256, 1024
spec = np.log1p(np.array([np.abs(np.fft.rfft(x[i:i + win] * np.hanning(win))) for i in range(0, len(x) - win, hop)]) * 10)
flux = np.concatenate([[0], np.maximum(0, np.diff(spec, axis=0)).sum(1)])
fps = sr / hop
t = np.arange(len(flux)) / fps
f = np.maximum(flux - np.convolve(flux, np.ones(16) / 16, "same"), 0)

best = None
for bpm in np.arange(a.min_bpm, a.max_bpm, 0.25):
    lag = 60 / bpm * fps
    c = sum((f[l:] * f[:-l]).sum() for l in (int(round(lag * k)) for k in (1, 2, 4)))
    if best is None or c > best[1]:
        best = (bpm, c)
bpm = best[0]
period = 60 / bpm
phases = np.linspace(0, period, 200, endpoint=False)
phase = phases[int(np.argmax([np.interp(np.arange(p, t[-1], period), t, f).sum() for p in phases]))]
beats = np.arange(phase, t[-1], period)
strength = np.interp(beats, t, f)
down = max(range(4), key=lambda k: strength[k::4].sum())

n = len(x) // hop
rms = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(1))
rt = np.arange(n) * hop / sr
print(f"bpm {bpm:.2f}  beat {period:.4f}s  first beat {phase:.3f}s  downbeat offset {down}")
print("bar start   level")
for k in range(down, len(beats), 4):
    s, e = beats[k], beats[k] + 4 * period
    if e < rt[-1]:
        print(f"{s:9.3f}   {rms[(rt >= s) & (rt < e)].mean() * 100:5.1f}")
