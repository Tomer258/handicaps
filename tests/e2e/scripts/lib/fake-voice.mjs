import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Writes a fake microphone input that sounds like speech (syllable bursts, moving pitch, harmonics) to .tmp and
 * returns its path for --use-file-for-fake-audio-capture. Chrome's built-in fake beep is a stationary tone that
 * noise suppression (browser or RNNoise) removes, which makes "is speaking" checks fail or flake.
 */
export function fakeVoiceFile() {
  const file = resolve(import.meta.dirname, '../../../../.tmp/poc-voice.wav');
  const rate = 48000, n = rate * 6, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, syl = (t * 4) % 1; // four syllables per second
    const env = syl < 0.7 ? Math.sin((Math.PI * syl) / 0.7) : 0;
    const f0 = 140 + 60 * Math.sin(2 * Math.PI * 0.7 * t) + 30 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += (2 * Math.PI * f0) / rate;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) / h;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * env * 0.45)) * 32767), 44 + i * 2);
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, buf);
  return file;
}
