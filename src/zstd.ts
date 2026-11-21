import zlib from 'node:zlib';

/**
 * DSH appends each durable batch to `session.v4.jsonl.zstd` as its own
 * independently decodable, checksummed Zstandard frame. A single
 * `zstdDecompressSync` call only decodes the first frame, so both reading and
 * writing have to work frame by frame.
 *
 * The scanner below is a port of DSH's own `scanZstdFrames`: it walks the frame
 * header and block headers structurally instead of hunting for the magic bytes,
 * so compressed payload that happens to contain the magic cannot fool it.
 */

const ZSTD_MAGIC = 0xfd2fb528;

export interface FrameRange {
  start: number;
  end: number;
}

export interface FrameScan {
  frames: FrameRange[];
  /** Start of a final frame that ends past EOF, i.e. torn by an interrupted write. */
  tornStart?: number;
}

export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): FrameScan {
  const frames: FrameRange[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Decompresses every complete frame and returns the concatenated plaintext. */
export function decompressFrames(file: string, bytes: Buffer): string {
  const { frames, tornStart } = scanZstdFrames(bytes);
  const chunks: Buffer[] = [];
  for (const frame of frames) {
    chunks.push(zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
  }
  if (tornStart !== undefined) {
    // A session being written right now can end inside its last frame. DSH
    // recovers that tail with a flush-terminated decode; a torn frame that still
    // refuses is simply dropped, exactly like DSH's own reader.
    try {
      chunks.push(
        zlib.zstdDecompressSync(bytes.subarray(tornStart), {
          finishFlush: zlib.constants.ZSTD_e_flush,
        } as zlib.ZstdOptions),
      );
    } catch {
      // ignore the unreadable tail
    }
  }
  void file;
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One independently decodable, checksummed frame — byte-compatible with the
 * frames DSH writes, so its reader accepts what we produce.
 */
export function compressFrame(text: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
}
