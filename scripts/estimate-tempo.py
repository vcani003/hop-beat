"""
Authoring aid: estimate a track's tempo and first downbeat.

This is NOT the analysis pipeline from spec §8 — that is MVP 2's job, in
TypeScript, with a real onset detector. This is the equivalent of a person
tapping along to find the tempo before hand-writing a chart, which is exactly
what MVP 1 calls for. The note PATTERN is still designed by hand; this only
supplies the grid it is written on.

Energy flux is a crude onset function, but dance music has a loud kick on the
beat, which is the easiest possible case.

Usage: python3 scripts/estimate-tempo.py <audio file>
"""
import array
import subprocess
import sys

SR = 22050
HOP = 512                      # ~23 ms per frame
MIN_BPM, MAX_BPM = 70, 180


def decode(path):
    raw = subprocess.run(
        ['ffmpeg', '-v', 'quiet', '-i', path,
         '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
        capture_output=True, check=True).stdout
    samples = array.array('h')
    samples.frombytes(raw[:len(raw) - (len(raw) % 2)])
    return samples


def onset_envelope(samples):
    """Positive frame-to-frame change in energy — a kick makes a spike."""
    energies = []
    for start in range(0, len(samples) - HOP, HOP):
        total = 0
        for i in range(start, start + HOP, 4):   # decimate; kicks are low-freq
            v = samples[i]
            total += v * v
        energies.append((total / (HOP / 4)) ** 0.5)

    flux = [0.0]
    for i in range(1, len(energies)):
        flux.append(max(0.0, energies[i] - energies[i - 1]))

    mean = sum(flux) / len(flux)
    return [f - mean for f in flux]


def best_tempo(flux):
    fps = SR / HOP
    min_lag = int(fps * 60 / MAX_BPM)
    max_lag = int(fps * 60 / MIN_BPM)

    best, best_lag = -1e18, min_lag
    scores = {}
    for lag in range(min_lag, max_lag + 1):
        total = 0.0
        for i in range(lag, len(flux)):
            total += flux[i] * flux[i - lag]
        total /= (len(flux) - lag)
        scores[lag] = total
        if total > best:
            best, best_lag = total, lag

    bpm = 60 * fps / best_lag
    # Tempo estimators routinely land an octave out; nudge into a danceable band.
    while bpm < 90:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return bpm, best, scores


def best_offset(flux, bpm):
    """Slide a pulse train over the flux and keep the best-fitting phase."""
    fps = SR / HOP
    period = 60 * fps / bpm
    best, best_offset_frames = -1e18, 0.0
    steps = int(period * 4)
    for step in range(steps):
        phase = step / 4.0
        total, n = 0.0, 0
        pos = phase
        while pos < len(flux):
            total += flux[int(pos)]
            n += 1
            pos += period
        if n and total / n > best:
            best, best_offset_frames = total / n, phase
    return best_offset_frames * HOP / SR * 1000


def main(path):
    samples = decode(path)
    flux = onset_envelope(samples)
    bpm, strength, _ = best_tempo(flux)
    offset_ms = best_offset(flux, bpm)
    duration = len(samples) / SR
    print(f'file        {path.split("/")[-1]}')
    print(f'duration    {duration:.1f} s')
    print(f'bpm         {bpm:.2f}')
    print(f'first beat  {offset_ms:.0f} ms')
    print(f'confidence  {strength:.3g} (relative; compare across candidates only)')


if __name__ == '__main__':
    main(sys.argv[1])
