import { GovConfig, GovSample, GovState, SAMPLE_MS, govInit, govStep, govTarget, ladderFor, rungLabel } from './share-governor';

const HW = ladderFor('smooth', false, 'hardware');
const cfg: GovConfig = { expectHardware: true, softwareLadder: ladderFor('smooth', false, 'software') };
const ok: GovSample = { active: true, captureFps: 60, limit: 'none', encoder: 'hardware' };

/** Feeds the same sample `count` times, two seconds apart; returns the state and the clock. */
function run(s: GovState, now: number, x: GovSample, count: number, c = cfg): [GovState, number] {
  for (let i = 0; i < count; i++) {
    now += SAMPLE_MS;
    s = govStep(s, x, now, c);
  }
  return [s, now];
}

const label = (s: GovState) => rungLabel(govTarget(s));

describe('ladderFor', () => {
  it('gives a hardware PC the full ladder and a software PC only what it can hold', () => {
    expect(HW.map(rungLabel)).toEqual(['1080p · 60', '720p · 60', '720p · 30']);
    expect(ladderFor('smooth', false, 'software').map(rungLabel)).toEqual(['720p · 30']);
    expect(ladderFor('sharp', false, 'software').map(rungLabel)).toEqual(['1080p · 15']);
    expect(ladderFor('smooth', true, 'hardware').map(rungLabel)).toEqual(['720p · 60', '720p · 30']);
    expect(ladderFor('sharp', true, 'hardware').map(rungLabel)).toEqual(['720p · 30', '720p · 15']);
  });
});

describe('govStep', () => {
  it('stays at the top while nothing limits the stream', () => {
    const [s] = run(govInit(HW, 0), 0, ok, 100);
    expect(label(s)).toBe('1080p · 60');
    expect(s.reason).toBe('ok');
  });

  it('ignores limits while the encoder is still ramping up after the start', () => {
    const [s] = run(govInit(HW, 0), 0, { ...ok, limit: 'bandwidth' }, 4);
    expect(s.bitrateScale).toBe(1);
  });

  it('steps one rung down after 6 s of CPU limitation, and back up after 30 clean seconds', () => {
    let [s, now] = run(govInit(HW, 0), 0, ok, 6);
    [s, now] = run(s, now, { ...ok, limit: 'cpu' }, 3);
    expect(label(s)).toBe('720p · 60');
    expect(s.reason).toBe('cpu');
    [s, now] = run(s, now, ok, 25);
    expect(label(s)).toBe('1080p · 60');
    expect(s.reason).toBe('ok');
  });

  it('lowers the bitrate first on an upload limit, then the rung', () => {
    let [s, now] = run(govInit(HW, 0), 0, ok, 6);
    [s, now] = run(s, now, { ...ok, limit: 'bandwidth' }, 3);
    expect(label(s)).toBe('1080p · 60');
    expect(govTarget(s).bitrate).toBe(5_600_000);
    [s, now] = run(s, now, { ...ok, limit: 'bandwidth' }, 6);
    expect(label(s)).toBe('720p · 60');
    expect(s.reason).toBe('bandwidth');
  });

  it('caps the frame rate at 30 when the capture cannot deliver 60, but not for a still screen', () => {
    let [s, now] = run(govInit(HW, 0), 0, ok, 6);
    const [still] = run(s, now, { ...ok, captureFps: 2 }, 10);
    expect(label(still)).toBe('1080p · 60');
    [s, now] = run(s, now, { ...ok, captureFps: 38 }, 3);
    expect(label(s)).toBe('1080p · 30');
    expect(s.reason).toBe('capture');
  });

  it('waits twice as long before the next try when a step up had to be taken back', () => {
    let [s, now] = run(govInit(HW, 0), 0, ok, 6);
    [s, now] = run(s, now, { ...ok, limit: 'cpu' }, 3);
    const wait = s.upWait;
    [s, now] = run(s, now, ok, 25); // back up
    [s, now] = run(s, now, { ...ok, limit: 'cpu' }, 6); // fails again right away
    expect(label(s)).toBe('720p · 60');
    expect(s.upWait).toBe(wait * 2);
  });

  it('moves to the software ladder when the browser did not use the hardware encoder', () => {
    const [s, now] = run(govInit(HW, 0), 0, { ...ok, encoder: 'software' }, 3);
    expect(label(s)).toBe('720p · 30');
    expect(s.reason).toBe('software');
    const [later] = run(s, now, { ...ok, encoder: 'software' }, 60);
    expect(label(later)).toBe('720p · 30');
    expect(later.reason).toBe('software');
  });

  it('judges nothing while nobody receives the main layer', () => {
    let [s, now] = run(govInit(HW, 0), 0, ok, 6);
    [s, now] = run(s, now, { active: false, captureFps: null, limit: 'cpu', encoder: null }, 10);
    expect(label(s)).toBe('1080p · 60');
  });
});
