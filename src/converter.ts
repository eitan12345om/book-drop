import fs from 'fs/promises';
import { spawn } from 'child_process';
import { basename, dirname, join } from 'path';
import { logger } from './logger.js';
import {
  KINDLE_CONVERTER,
  KINDLE_OUTPUT_FORMAT,
  KOBO_CONVERTER,
  MAX_CONCURRENT_CONVERSIONS,
  MAX_CONVERSION_WAIT_MS,
  MAX_QUEUED_CONVERSIONS,
} from './config.js';
import { Semaphore } from './semaphore.js';

/** KindleGen is much slower than the other converters, so it gets its own cap. */
const KINDLEGEN_TIMEOUT_MS = 100_000;

class TimeoutError extends Error {}

/** What the user asked for, independent of which tool performs it. */
export type ConversionIntent = 'kobo' | 'kindle' | 'pdfcrop';

export class ConversionError extends Error {
  /** The tool's own reason the book won't convert, when it gives one that is safe to show. */
  readonly userMessage?: string;

  /** Which conversion was being attempted; attached by the registry, since a backend
   * only knows its own tool and can serve more than one intent. */
  intent?: ConversionIntent;

  constructor(
    public readonly tool: string,
    public readonly timedOut: boolean,
    message: string,
    options?: { cause?: unknown; userMessage?: string }
  ) {
    super(message, options);
    this.name = 'ConversionError';
    this.userMessage = options?.userMessage;
  }
}

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
      reject(new TimeoutError(`${cmd} timed out after ${timeoutMs} ms`));
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

/** Strips any e-reader-specific extension so a fresh one can be applied. */
function stripEbookExtension(filename: string): string {
  return filename.replace(/\.kepub\.epub$/i, '').replace(/\.(epub|mobi|azw3)$/i, '');
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
    throw new ConversionError('KindleGen', err instanceof TimeoutError, msg, {
      cause: err,
      userMessage: reason ? `KindleGen couldn't convert this EPUB: ${reason}` : undefined,
    });
  } finally {
    await deleteFile(inputPath);
    await deleteFile(mobi8Path);
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
    throw new ConversionError('Kepubify', err instanceof TimeoutError, msg, { cause: err });
  } finally {
    await deleteFile(inputPath);
  }
}

/**
 * Converts an EPUB with calibre, deleting the original on completion.
 *
 * calibre picks the output format from the file extension, and ".kepub.epub" reads as
 * plain EPUB — which silently yields an EPUB with no Kobo markup. Kobo devices in turn
 * only recognise sideloaded kepubs by that exact double extension, so kepub output is
 * written as ".kepub" and renamed afterwards.
 */
export async function convertWithCalibre(
  inputPath: string,
  format: 'kepub' | 'azw3' | 'mobi'
): Promise<string> {
  const base = stripEbookExtension(inputPath);
  const workPath = `${base}.${format}`;
  const outPath = format === 'kepub' ? `${base}.kepub.epub` : workPath;
  try {
    await spawnProcess(
      'ebook-convert',
      [basename(inputPath), basename(workPath)],
      dirname(inputPath)
    );
    if (workPath !== outPath) {
      await fs.rename(workPath, outPath);
    }
    return outPath;
  } catch (err) {
    await deleteFile(workPath);
    await deleteFile(outPath);
    const msg = sanitizeOutput(
      (err as Error).message,
      [basename(inputPath), 'infile.epub'],
      [basename(workPath), `outfile.${format}`]
    );
    throw new ConversionError('calibre', err instanceof TimeoutError, msg, { cause: err });
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
    throw new ConversionError('pdfCropMargins', err instanceof TimeoutError, msg, { cause: err });
  } finally {
    await deleteFile(inputPath);
  }
}

export interface ConverterBackend {
  /** Display name, shown to users in success messages and used as a log field. */
  readonly tool: string;
  /** Executable that must be present on PATH for this backend to work. */
  readonly command: string;
  /** The filename the user will receive, given the name they uploaded. */
  outputName(filename: string): string;
  /** Runs the conversion and resolves with the path to the converted file. */
  run(inputPath: string): Promise<string>;
}

const BACKENDS: Record<ConversionIntent, Record<string, ConverterBackend>> = {
  kobo: {
    calibre: {
      tool: 'calibre',
      command: 'ebook-convert',
      outputName: (filename) => `${stripEbookExtension(filename)}.kepub.epub`,
      run: (inputPath) => convertWithCalibre(inputPath, 'kepub'),
    },
    kepubify: {
      tool: 'Kepubify',
      command: 'kepubify',
      outputName: (filename) => `${stripEbookExtension(filename)}.kepub.epub`,
      run: convertWithKepubify,
    },
  },
  kindle: {
    calibre: {
      tool: 'calibre',
      command: 'ebook-convert',
      outputName: (filename) => `${stripEbookExtension(filename)}.${KINDLE_OUTPUT_FORMAT}`,
      run: (inputPath) => convertWithCalibre(inputPath, KINDLE_OUTPUT_FORMAT),
    },
    kindlegen: {
      tool: 'KindleGen',
      command: 'kindlegen',
      outputName: (filename) => `${stripEbookExtension(filename)}.mobi`,
      run: convertWithKindlegen,
    },
  },
  pdfcrop: {
    pdfcropmargins: {
      tool: 'pdfCropMargins',
      command: 'pdfcropmargins',
      outputName: (filename) => filename,
      run: convertWithPdfCropMargins,
    },
  },
};

const SELECTED: Record<ConversionIntent, string> = {
  kobo: KOBO_CONVERTER,
  kindle: KINDLE_CONVERTER,
  pdfcrop: 'pdfcropmargins',
};

const conversionSlots = new Semaphore(
  MAX_CONCURRENT_CONVERSIONS,
  MAX_QUEUED_CONVERSIONS,
  MAX_CONVERSION_WAIT_MS
);

/** Returns the backend currently configured to serve an intent. */
export function backendFor(intent: ConversionIntent): ConverterBackend {
  const backend = BACKENDS[intent][SELECTED[intent]];
  if (!backend) {
    throw new Error(`No converter backend "${SELECTED[intent]}" for ${intent}`);
  }
  return backend;
}

/** Runs an intent through its configured backend once a slot is free, tagging failures with the intent. */
export async function convert(intent: ConversionIntent, inputPath: string): Promise<string> {
  try {
    return await conversionSlots.run(async (queuedMs) => {
      if (queuedMs > 0) {
        logger.info(
          { intent, queuedMs, active: conversionSlots.activeCount },
          'Conversion waited for a free slot'
        );
      }
      return backendFor(intent).run(inputPath);
    });
  } catch (err) {
    if (err instanceof ConversionError) {
      err.intent = intent;
    }
    throw err;
  }
}

/**
 * Reports at startup whether each configured backend's executable can be spawned, so a
 * misconfigured image is visible in the logs rather than discovered by the first user to
 * tick a conversion option. Missing tools are logged but not fatal: sending files works
 * without any converter, so refusing to boot would turn lost conversions into an outage.
 *
 * Exit status is ignored — the tools disagree on how to report a version, and only a
 * spawn failure tells us the binary is absent.
 */
export async function reportConverterAvailability(): Promise<void> {
  const intents: ConversionIntent[] = ['kobo', 'kindle', 'pdfcrop'];
  await Promise.all(
    intents.map(async (intent) => {
      const { command, tool } = backendFor(intent);
      try {
        await spawnProcess(command, ['--version'], '/tmp', () => true, 10_000);
        logger.info({ intent, tool, command }, 'Converter available');
      } catch (err) {
        logger.error(
          { err, intent, tool, command },
          'Configured converter is unavailable — this conversion will fail for every upload'
        );
      }
    })
  );
}
