/**
 * The demo's one clip, as real media the run itself holds.
 *
 * The clip event used to point at an Arweave URL nothing stood behind — a
 * placeholder showing the shape, unplayable by construction. But the guide's
 * broadcaster page exists to PLAY a clip from a free fetch, and a spec that
 * proves playback needs media that actually arrives. So the demo serves its
 * own: this module synthesizes a few seconds of sound in pure TypeScript, the
 * player serves it on loopback, and the clip event names that URL.
 *
 * Sound alone, on purpose. The glossary says a clip may be sound alone, and a
 * WAV is the one media a browser plays natively that this run can write with
 * no encoder: the vibes go through the ffmpeg inside the origin's own image,
 * but a clip generated at announce time would mean reaching for that image a
 * second way — and "Docker and this repository's own toolchain, and nothing
 * else" stays true by not doing that. On a real station a clip lives on
 * Arweave, was paid to write once at the store, and is whatever the
 * broadcaster cut; here it is the smallest thing a `<video>` element will
 * genuinely play.
 */

/** What the demo announces about its clip, and what the media below really is. */
export const FIRST_LIGHT = {
  fileName: 'first-light.wav',
  contentType: 'audio/wav',
  title: 'first light',
  /** The literal the guide's spec asserts, and the length of the synthesized sound. */
  durationSeconds: 6,
  description: 'the first vibes this station ever held',
};

/** Mono 16-bit PCM at a rate small enough that six seconds is under 100 KiB. */
const SAMPLE_RATE = 8_000;
const BYTES_PER_SAMPLE = 2;

/**
 * Six seconds of a low sine with a slow swell — WAV, whole, in memory.
 *
 * The envelope fades in and out so the clip starts and ends silently instead
 * of clicking, which is the difference between "a test file" and something a
 * person can bear to press play on.
 */
export function firstLightMedia(): Uint8Array {
  const samples = SAMPLE_RATE * FIRST_LIGHT.durationSeconds;
  const dataBytes = samples * BYTES_PER_SAMPLE;
  const wav = new DataView(new ArrayBuffer(44 + dataBytes));

  const ascii = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      wav.setUint8(at + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  wav.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  wav.setUint32(16, 16, true); // the fmt chunk's own size
  wav.setUint16(20, 1, true); // PCM, uncompressed
  wav.setUint16(22, 1, true); // one track of sound
  wav.setUint32(24, SAMPLE_RATE, true);
  wav.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  wav.setUint16(32, BYTES_PER_SAMPLE, true);
  wav.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  wav.setUint32(40, dataBytes, true);

  for (let at = 0; at < samples; at += 1) {
    const seconds = at / SAMPLE_RATE;
    const swell = Math.sin(
      (Math.PI * at) / (SAMPLE_RATE * FIRST_LIGHT.durationSeconds)
    );
    const tone =
      Math.sin(2 * Math.PI * 220 * seconds) * 0.7 +
      Math.sin(2 * Math.PI * 277.18 * seconds) * 0.3;
    wav.setInt16(44 + at * BYTES_PER_SAMPLE, tone * swell * 0.4 * 32767, true);
  }

  return new Uint8Array(wav.buffer);
}
