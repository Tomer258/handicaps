// What the installed browser says about video encoding on this PC (the questions encode-probe.ts asks).
// Usage: node scripts/encode-probe-check.mjs [chrome|msedge]     (needs ng serve on :4200 for a secure-context page)
import { chromium } from '@playwright/test';

const [, , channel = 'msedge'] = process.argv;
const browser = await chromium.launch({ channel, headless: false });
const page = await browser.newPage();
await page.goto('http://localhost:4200/login');
const out = await page.evaluate(async () => {
  const res = {};
  res.sendCodecs = [...new Set(RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType))];
  res.h264Profiles = RTCRtpSender.getCapabilities('video').codecs.filter((c) => /h264/i.test(c.mimeType)).map((c) => c.sdpFmtpLine);
  res.encodingInfo = {};
  const types = ['video/H264', 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034', 'video/VP8', 'video/AV1'];
  for (const contentType of types)
    for (const [width, height, framerate, bitrate] of [[1920, 1080, 60, 8e6], [1280, 720, 30, 2.5e6]]) {
      try {
        const i = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType, width, height, framerate, bitrate } });
        res.encodingInfo[`${contentType} ${height}p${framerate}`] = `supported=${i.supported} smooth=${i.smooth} powerEfficient=${i.powerEfficient}`;
      } catch (e) {
        res.encodingInfo[`${contentType} ${height}p${framerate}`] = `error ${e.message}`;
      }
    }
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  res.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
