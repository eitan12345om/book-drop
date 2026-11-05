import fs from 'fs/promises';
import { spawn } from 'child_process';
import { basename, dirname, join } from 'path';
import { logger } from './logger.js';

/** KindleGen is much slower than the other converters, so it gets its own cap. */
const KINDLEGEN_TIMEOUT_MS = 100_000;

/** Deletes a file, silently ignoring ENOENT. */
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

/** Spawns a child process and resolves with its combined stdout+stderr output, or rejects on error or timeout. */
function spawnProcess(
  cmd: string,
  args: string[],
  cwd: string,
  isSuccess: (code: number | null) => boolean = (code) => code === 0,
  timeoutMs = 55_000
): Promise<string> {
  const MAX_OUTPUT_BYTES = 100 * 1024;
  return new Promise((resolve, reject) => {
    let output = '';
    let outputBytes = 0;
    let truncated = false;
    const proc = spawn(cmd, args, { cwd });
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
    proc.once('close', (code) => {
      clearTimeout(timer);
      if (isSuccess(code)) {
        resolve(output);
      } else {
        reject(new Error(`${cmd} exited with code ${code}\n${output}`));
      }
    });
  });
}

/** A conversion failure whose `userMessage` is safe to show to the uploader. */
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

/** Extracts the reason from KindleGen's `Error(<module>):E<code>: <reason>` line, if any. */
function kindlegenErrorReason(output: string): string | null {
  const m = output.match(/^Error\([^)]*\):(E\d+):\s*(.+?)(?:\s*Aborting\.)?\s*$/m);
  if (!m) {
    return null;
  }
  const [, code, reason] = m;
  return KINDLEGEN_ERROR_MESSAGES[code] ?? reason;
}

/** Applies a series of string replacements to sanitize tool output before surfacing it to the user. */
function sanitizeOutput(message: string, ...replacements: [string, string][]): string {
  return replacements.reduce((msg, [from, to]) => msg.replaceAll(from, to), message);
}

/** Converts an EPUB to MOBI using kindlegen, deleting the original on completion. */
export async function convertWithKindlegen(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.epub$/i, '.mobi');
  const mobi8Path = inputPath.replace(/\.epub$/i, '.mobi8');
  try {
    await spawnProcess(
      'kindlegen',
      [basename(inputPath), '-dont_append_source', '-c1', '-o', basename(outPath)],
      dirname(inputPath),
      // kindlegen uses exit code 1 for success with warnings
      (code) => code === 0 || code === 1,
      KINDLEGEN_TIMEOUT_MS
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

/**
 * Converts an EPUB to MOBI using kindling, deleting the original on completion.
 *
 * kindling unpacks the book into a folder beside its input and leaves it there if it fails
 * or is killed, so it runs in a scratch folder that is removed whatever the outcome.
 */
export async function convertWithKindling(inputPath: string): Promise<string> {
  const outPath = inputPath.replace(/\.epub$/i, '.mobi');
  let workDir: string | undefined;
  try {
    workDir = await fs.mkdtemp(join(dirname(inputPath), '.kindling-'));
    const workInput = join(workDir, basename(inputPath));
    const workOutput = join(workDir, basename(outPath));
    await fs.rename(inputPath, workInput);
    await spawnProcess(
      'kindling-cli',
      [
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
      ],
      workDir
    );
    await fs.rename(workOutput, outPath);
    return outPath;
  } catch (err) {
    const msg = sanitizeOutput(
      (err as Error).message,
      [basename(inputPath), 'infile.epub'],
      [basename(outPath), 'outfile.mobi']
    );
    throw new Error(msg, { cause: err });
  } finally {
    await deleteFile(inputPath);
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

/** Converts an EPUB to Kobo's kepub format using kepubify, deleting the original on completion. */
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

/** Crops white margins from a PDF using pdfcropmargins, deleting the original on completion. */
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
