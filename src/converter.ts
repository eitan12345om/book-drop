import fs from 'fs/promises';
import { spawn } from 'child_process';
import { basename, dirname, extname, join } from 'path';
import { logger } from './logger.js';

const KINDLEGEN_TIMEOUT_MS = 100_000;

async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    logger.debug({ filePath }, 'Deleted temporary file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ err, filePath }, 'Error deleting file');
    }
  }
}

/** Converters parse untrusted files, so they get none of the server's secrets. */
function converterEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, LANG, TMPDIR } = process.env;
  return Object.fromEntries(
    Object.entries({ PATH, HOME, LANG, TMPDIR }).filter(([, value]) => value !== undefined)
  );
}

function spawnProcess(
  cmd: string,
  args: string[],
  cwd: string,
  {
    isSuccess = (code: number | null) => code === 0,
    timeoutMs = 55_000,
    memoryLimitBytes,
  }: {
    isSuccess?: (code: number | null) => boolean;
    timeoutMs?: number;
    /** Address space the process may use, so it fails instead of growing without bound. */
    memoryLimitBytes?: number;
  } = {}
): Promise<string> {
  const MAX_OUTPUT_BYTES = 100 * 1024;
  return new Promise((resolve, reject) => {
    let output = '';
    let outputBytes = 0;
    let truncated = false;
    const options = { cwd, env: converterEnv() };
    // If memory runs out, the kernel kills a converter rather than the server and its sessions.
    // choom and prlimit are Linux-only; elsewhere, as in development, converters run unrestricted.
    const memoryCap = memoryLimitBytes ? ['prlimit', `--as=${memoryLimitBytes}`, '--'] : [];
    const proc =
      process.platform === 'linux'
        ? spawn('choom', ['-n', '1000', '--', ...memoryCap, cmd, ...args], options)
        : spawn(cmd, args, options);
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const appendOutput = (d: Buffer): void => {
      if (!truncated) {
        output += d.toString();
        outputBytes += d.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          output += '\n[output truncated]';
        }
      }
    };
    proc.stdout.on('data', appendOutput);
    proc.stderr.on('data', appendOutput);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} spawn error: ${err.message}`));
    });
    proc.once('close', (code, signal) => {
      clearTimeout(timer);
      if (isSuccess(code)) {
        resolve(output);
      } else if (signal) {
        reject(new Error(`${cmd} was killed by ${signal}\n${output}`));
      } else {
        reject(new Error(`${cmd} exited with code ${code}\n${output}`));
      }
    });
  });
}

/** Only `userMessage` is safe to show to the uploader; `message` contains raw tool output. */
export class ConversionError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ConversionError';
  }
}

const KINDLEGEN_ERROR_MESSAGES: Record<string, string> = {
  E23006: 'Language not recognized in metadata. Try adding it with an ebook editor tool.',
};

// Matches KindleGen's `Error(<module>):E<code>: <reason>[ Aborting.]` line.
function kindlegenErrorReason(output: string): string | null {
  const m = output.match(/^Error\([^)]*\):(E\d+):\s*(.+?)(?:\s*Aborting\.)?\s*$/m);
  if (!m) {
    return null;
  }
  const [, code, reason] = m;
  return KINDLEGEN_ERROR_MESSAGES[code] ?? reason;
}

function sanitizeOutput(message: string, ...replacements: [string, string][]): string {
  return replacements.reduce((msg, [from, to]) => msg.replaceAll(from, to), message);
}

export async function convertWithKindlegen(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.epub$/i, '.mobi');
  const mobi8Path = inputPath.replace(/\.epub$/i, '.mobi8');
  try {
    await spawnProcess(
      'kindlegen',
      [basename(inputPath), '-dont_append_source', '-c1', '-o', basename(outPath)],
      dirname(inputPath),
      {
        // kindlegen uses exit code 1 for success with warnings
        isSuccess: (code) => code === 0 || code === 1,
        timeoutMs: KINDLEGEN_TIMEOUT_MS,
      }
    );
    return outPath;
  } catch (err) {
    await deleteFile(outPath);
    const msg = sanitizeOutput(
      (err as Error).message,
      [basename(inputPath), 'infile.epub'],
      [basename(outPath), 'outfile.mobi']
    );
    const reason = kindlegenErrorReason(msg);
    if (reason) {
      throw new ConversionError(msg, `KindleGen couldn't convert this EPUB: ${reason}`, {
        cause: err,
      });
    }
    throw new Error(msg, { cause: err });
  } finally {
    await deleteFile(inputPath);
    await deleteFile(mobi8Path);
  }
}

export const KINDLING_WORK_DIR_PREFIX = '.kindling-';

// A real book needs at most about 220 MB; the cap makes a hostile one fail in seconds.
const KINDLING_MEMORY_LIMIT_BYTES = 384 * 1024 * 1024;
// kindling unpacks the whole book to disk and won't write past the sizes the zip declares.
const KINDLING_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

/** Sums the uncompressed sizes in a zip's central directory, which is at its end. */
async function declaredUnpackedSize(zipPath: string): Promise<number> {
  const file = await fs.open(zipPath, 'r');
  try {
    const { size } = await file.stat();
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      await file.read(buf, 0, length, position);
      return buf;
    };
    // The end record is 22 bytes plus a comment of up to 64 KB, after the zip64 locator.
    const tailStart = Math.max(0, size - 22 - 0xffff - 20);
    const tail = await read(tailStart, size - tailStart);
    const end = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (end < 0) {
      throw new Error('Not a zip archive');
    }
    let entries = tail.readUInt16LE(end + 10);
    let dirLength = tail.readUInt32LE(end + 12);
    let dirStart = tail.readUInt32LE(end + 16);
    if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
      const end64 = await read(Number(tail.readBigUInt64LE(end - 12)), 56);
      entries = Number(end64.readBigUInt64LE(32));
      dirLength = Number(end64.readBigUInt64LE(40));
      dirStart = Number(end64.readBigUInt64LE(48));
    }
    // These come from the upload, so they must not decide how much the server allocates.
    if (dirStart + dirLength > size) {
      throw new Error('Corrupt zip central directory');
    }
    const dir = await read(dirStart, dirLength);
    let total = 0;
    for (let i = 0, at = 0; i < entries; i++) {
      if (dir.readUInt32LE(at) !== 0x02014b50) {
        throw new Error('Corrupt zip central directory');
      }
      const nameLength = dir.readUInt16LE(at + 28);
      const extraLength = dir.readUInt16LE(at + 30);
      let entrySize = dir.readUInt32LE(at + 24);
      if (entrySize === 0xffffffff) {
        // The zip64 extra field leads with the real size when the 32-bit field can't hold it.
        let extra = at + 46 + nameLength;
        while (dir.readUInt16LE(extra) !== 0x0001) {
          extra += 4 + dir.readUInt16LE(extra + 2);
        }
        entrySize = Number(dir.readBigUInt64LE(extra + 4));
      }
      total += entrySize;
      at += 46 + nameLength + extraLength + dir.readUInt16LE(at + 32);
    }
    return total;
  } finally {
    await file.close();
  }
}

// kindling unpacks the book into a folder beside its input and leaves it there if it fails
// or is killed, so it runs in a scratch folder that is removed whatever the outcome.
export async function convertWithKindling(inputPath: string): Promise<string> {
  const outPath = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.mobi`);
  let workDir: string | undefined;
  let moved = false;
  try {
    if ((await declaredUnpackedSize(inputPath)) > KINDLING_MAX_UNPACKED_BYTES) {
      throw new ConversionError(
        'EPUB declares more than the unpacked size limit',
        'This EPUB is too large to convert for Kindle.'
      );
    }
    workDir = await fs.mkdtemp(join(dirname(inputPath), KINDLING_WORK_DIR_PREFIX));
    const workInput = join(workDir, 'in.epub');
    const workOutput = join(workDir, 'out.mobi');
    await fs.rename(inputPath, workInput);
    moved = true;
    const args = [
      'build',
      basename(workInput),
      '-o',
      basename(workOutput),
      // MOBI6 plus KF8, as KindleGen wrote: every Kindle opens it and shows its cover.
      '--legacy-mobi',
      // Amazon's publishing checks refuse about one book in five, e.g. for having no cover.
      '--no-validate',
      '--no-embed-source',
      // Full-resolution image copies can triple the size of an illustrated book.
      '--no-hd-images',
      // Files the book under Books with an ASIN, which the library needs to show a cover.
      '--doc-type',
      'ebok',
    ];
    await spawnProcess('kindling-cli', args, workDir, {
      memoryLimitBytes: KINDLING_MEMORY_LIMIT_BYTES,
    });
    await fs.rename(workOutput, outPath);
    return outPath;
  } finally {
    if (!moved) {
      await deleteFile(inputPath);
    }
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

export async function convertWithKepubify(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.epub$/i, '.kepub.epub');
  try {
    await spawnProcess(
      'kepubify',
      ['-v', '-u', '-o', basename(outPath), basename(inputPath)],
      dirname(inputPath)
    );
    return outPath;
  } catch (err) {
    await deleteFile(outPath);
    const msg = sanitizeOutput(
      (err as Error).message,
      [basename(inputPath), 'infile.epub'],
      [basename(outPath), 'outfile.kepub.epub']
    );
    throw new Error(msg, { cause: err });
  } finally {
    await deleteFile(inputPath);
  }
}

export async function convertWithPdfCropMargins(inputPath: string): Promise<string> {
  const dir = dirname(inputPath);
  const base = basename(inputPath, '.pdf');
  const outPath = join(dir, `${base}_cropped.pdf`);
  try {
    await spawnProcess(
      'pdfcropmargins',
      ['-s', '-u', '-o', basename(outPath), basename(inputPath)],
      dir
    );
    return outPath;
  } catch (err) {
    await deleteFile(outPath);
    const msg = sanitizeOutput(
      (err as Error).message,
      [basename(inputPath), 'infile.pdf'],
      [basename(outPath), 'outfile.pdf']
    );
    throw new Error(msg, { cause: err });
  } finally {
    await deleteFile(inputPath);
  }
}
