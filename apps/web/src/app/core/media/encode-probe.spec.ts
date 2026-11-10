import { asHighProfile } from './encode-probe';

const sdp = (lines: string[]) => lines.join('\r\n') + '\r\n';

describe('asHighProfile', () => {
  it('presents the H.264 codec the SFU picked as High profile and adds a start bitrate', () => {
    const out = asHighProfile(sdp([
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 108 114 118',
      'a=rtpmap:108 H264/90000',
      'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      'a=rtpmap:114 H264/90000',
      'a=fmtp:114 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
    ]));
    expect(out).toContain('a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032;x-google-start-bitrate=4000');
    expect(out).toContain('a=fmtp:114 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f');
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('leaves sections alone whose first codec is not H.264 (cameras publish VP8) and audio', () => {
    const input = sdp([
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 108',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:108 H264/90000',
      'a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    ]);
    expect(asHighProfile(input)).toBe(input);
  });
});
