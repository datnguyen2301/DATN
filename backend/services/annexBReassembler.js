/**
 * Reassembles the Annex-B byte stream emitted by the EZVIZ cloud helper.
 *
 * Why this exists: the helper depacketizes RTP only for H.265. For an H.264
 * device it writes each RTP payload out verbatim with a start code in front, so
 * every fragmented NAL arrives as a run of FU-A units (type 28) instead of one
 * complete NAL. ffmpeg cannot decode that — the slice headers never appear where
 * a parser expects them — which is why an H.264 camera produced a stream that
 * connected fine and decoded to nothing.
 *
 * This transform rebuilds fragmented NALs (H.264 FU-A, and H.265 FU for
 * symmetry) and passes everything else through byte-for-byte, so a camera whose
 * stream the helper already handles correctly is unaffected.
 *
 * It also sniffs the codec from the first parameter set it sees and emits a
 * 'codec' event, because the two device families differ and callers need to pick
 * the matching ffmpeg input format. The parameter-set NAL bytes distinguish them
 * unambiguously: H.264 SPS/PPS are 0x67/0x68, which read as H.265 types 51/52
 * (neither a parameter set), while H.265 VPS/SPS/PPS are 0x40/0x42/0x44, which
 * read as H.264 types 0/2/4 (likewise not parameter sets).
 */

const { Transform } = require('stream');

const START_CODE = Buffer.from([0, 0, 0, 1]);

// Give up waiting for a parameter set eventually; a stream that never announces
// itself still has to reach ffmpeg somehow.
const CODEC_SNIFF_TIMEOUT_MS = 20_000;

function detectCodec(nal) {
  const b = nal[0];
  if ((b & 0x80) !== 0) return null;          // forbidden_zero_bit set: not a NAL header
  const h264Type = b & 0x1f;
  if (h264Type === 7 || h264Type === 8) return 'h264';
  const hevcType = (b >> 1) & 0x3f;
  if (hevcType === 32 || hevcType === 33 || hevcType === 34) return 'hevc';
  return null;
}

class AnnexBReassembler extends Transform {
  constructor(options = {}) {
    super(options);
    this.buf = Buffer.alloc(0);
    this.inNal = false;       // whether buf starts inside a NAL body
    this.scanned = 0;         // bytes of buf already searched for a start code
    this.codec = null;
    this.pending = null;      // NAL being rebuilt from fragments
    this.fragmentsSeen = 0;
    this.rebuiltNals = 0;
    this.droppedFragments = 0;

    this.sniffTimer = setTimeout(() => {
      if (!this.codec) {
        this.codec = 'hevc';  // the helper's native output format
        this.emit('codec', this.codec, { guessed: true });
      }
    }, CODEC_SNIFF_TIMEOUT_MS);
    if (this.sniffTimer.unref) this.sniffTimer.unref();
  }

  /**
   * Find the next start code at or after `from`. Four-byte codes are matched
   * ahead of three-byte ones so the extra leading zero is consumed as part of
   * the delimiter rather than left on the end of the preceding NAL.
   */
  static findStartCode(buf, from) {
    for (let i = Math.max(0, from); i + 3 <= buf.length; i += 1) {
      if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
      if (buf[i + 2] === 0 && i + 4 <= buf.length && buf[i + 3] === 1) return { pos: i, len: 4 };
      if (buf[i + 2] === 1) return { pos: i, len: 3 };
    }
    return null;
  }

  _emitNal(nal) {
    if (!nal.length) return;
    if (!this.codec) {
      const codec = detectCodec(nal);
      if (codec) {
        clearTimeout(this.sniffTimer);
        this.codec = codec;
        this.emit('codec', codec, { guessed: false });
      }
    }
    this.push(START_CODE);
    this.push(nal);
  }

  /**
   * Handle one NAL from the wire: pass it through, or fold it into the NAL being
   * rebuilt when it is a fragmentation unit.
   */
  _handleNal(nal) {
    if (nal.length < 2) {
      this._emitNal(nal);
      return;
    }

    const isFuA = this.codec === 'h264' && (nal[0] & 0x1f) === 28;
    const isFuHevc = this.codec === 'hevc' && ((nal[0] >> 1) & 0x3f) === 49;
    if (!isFuA && !isFuHevc) {
      this._emitNal(nal);
      return;
    }

    this.fragmentsSeen += 1;

    // H.264 FU-A: 1-byte indicator + 1-byte header. H.265 FU: 2-byte NAL header
    // + 1-byte header. In both the header's top bits are start/end markers and
    // its low bits carry the original NAL type.
    const headerLen = isFuA ? 2 : 3;
    if (nal.length <= headerLen) {
      this.droppedFragments += 1;
      return;
    }
    const fuHeader = nal[headerLen - 1];
    const start = (fuHeader & 0x80) !== 0;
    const end = (fuHeader & 0x40) !== 0;
    const payload = nal.subarray(headerLen);

    if (start) {
      const originalType = fuHeader & (isFuA ? 0x1f : 0x3f);
      const reconstructedHeader = isFuA
        ? Buffer.from([(nal[0] & 0xe0) | originalType])
        : Buffer.from([(nal[0] & 0x81) | (originalType << 1), nal[1]]);
      this.pending = [reconstructedHeader, payload];
    } else if (this.pending) {
      this.pending.push(payload);
    } else {
      // Mid-fragment with no start seen — the frame it belongs to is already
      // unrecoverable, so drop rather than emit a NAL with a missing head.
      this.droppedFragments += 1;
      return;
    }

    if (end && this.pending) {
      this._emitNal(Buffer.concat(this.pending));
      this.rebuiltNals += 1;
      this.pending = null;
    }
  }

  /**
   * `buf` always begins at a NAL body once `inNal` is set, so a NAL split across
   * chunks is completed by the chunk that carries the next start code. `scanned`
   * keeps the search from re-walking bytes already known to hold no start code.
   */
  _transform(chunk, _enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    let from = this.scanned;
    for (;;) {
      const sc = AnnexBReassembler.findStartCode(this.buf, from);
      if (!sc) break;
      // Before the first start code lies either nothing or stream preamble.
      if (this.inNal) this._handleNal(this.buf.subarray(0, sc.pos));
      this.buf = this.buf.subarray(sc.pos + sc.len);
      this.inNal = true;
      from = 0;
    }

    // A start code can straddle the chunk boundary, so the last 3 bytes stay
    // eligible for rescanning.
    this.scanned = Math.max(0, this.buf.length - 3);
    cb();
  }

  _flush(cb) {
    clearTimeout(this.sniffTimer);
    if (this.inNal && this.buf.length) this._handleNal(this.buf);
    this.buf = Buffer.alloc(0);
    this.inNal = false;
    cb();
  }

  stats() {
    return {
      codec: this.codec,
      fragmentsSeen: this.fragmentsSeen,
      rebuiltNals: this.rebuiltNals,
      droppedFragments: this.droppedFragments,
    };
  }
}

module.exports = { AnnexBReassembler, detectCodec };
