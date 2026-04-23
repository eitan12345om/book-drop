const ACCEPTED_EXTENSIONS = ['.epub', '.mobi', '.azw3', '.pdf', '.txt', '.cbz', '.cbr'];
const ACCEPT_ATTR = [
  ...ACCEPTED_EXTENSIONS,
  'application/epub+zip',
  'application/epub',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.mobi8-ebook',
  'application/pdf',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
].join(',');

// Don't restrict file type on iOS — it breaks the file picker
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const zoneEmpty = document.getElementById('zone-empty');
const zoneSelected = document.getElementById('zone-selected');
const zoneFileName = document.getElementById('zone-file-name');
const zoneFileSize = document.getElementById('zone-file-size');
const zoneClearBtn = document.getElementById('zone-clear-btn');
const fileQueue = document.getElementById('file-queue');
const submitBtn = document.getElementById('submit-btn');
const historySection = document.getElementById('history');
const historyList = document.getElementById('history-list');
const toastContainer = document.getElementById('toast-container');
const urlInput = document.getElementById('urlinput');
const statusMsg = document.getElementById('status-msg');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const pageUrlLink = document.getElementById('page-url');
const optionsNote = document.getElementById('options-note');

const receiveUrl = window.location.origin + '/receive';
pageUrlLink.href = receiveUrl;
pageUrlLink.textContent = receiveUrl;

if (!isIOS) {
  fileInput.accept = ACCEPT_ATTR;
}

const OPTIONS = [
  {
    id: 'kepubify',
    name: 'kepubify',
    label: 'Kobo format',
    tag: 'Kobo · EPUB',
    description:
      "Converts EPUB to Kobo's .kepub format — enables better typography, font control, and page turns. Only runs when sending an EPUB to a Kobo.",
    defaultChecked: false,
    enabledExtensions: ['.epub'],
  },
  {
    id: 'kindlegen',
    name: 'kindlegen',
    label: 'Kindle format',
    tag: 'Kindle · EPUB',
    description:
      "Converts EPUB to MOBI so Kindle can open it — Kindle doesn't natively support EPUB. Only runs when sending an EPUB to a Kindle.",
    defaultChecked: false,
    enabledExtensions: ['.epub'],
  },
  {
    id: 'pdfcropmargins',
    name: 'pdfcropmargins',
    label: 'Crop PDF margins',
    tag: 'PDF only',
    description:
      'Trims white borders from PDF pages so text fills more of the small screen. Most useful for academic papers or scanned books with wide margins.',
    defaultChecked: false,
    enabledExtensions: ['.pdf'],
  },
  {
    id: 'transliteration',
    name: 'transliteration',
    label: 'Transliterate filename',
    tag: 'Any file',
    description:
      "Replaces accented and non-Latin characters in the filename with ASCII equivalents (e.g. Ü→U, é→e). Helps older devices that can't handle Unicode filenames.",
    defaultChecked: false,
  },
  {
    id: 'fetchmetadata',
    name: 'fetchmetadata',
    label: 'Update metadata',
    tag: 'EPUB only',
    description:
      "Looks up title, author, publisher, and description from Google Books and updates the EPUB's internal metadata. You'll see what changed on the download page.",
    defaultChecked: false,
    enabledExtensions: ['.epub'],
  },
];

const MUTUALLY_EXCLUSIVE = ['kepubify', 'kindlegen'];

/** Renders the conversion option checkboxes into the options grid. */
function buildOptionsGrid() {
  const optionsGrid = document.getElementById('options-grid');
  OPTIONS.forEach(({ id, name, label, tag, description, defaultChecked, enabledExtensions }) => {
    const lbl = document.createElement('label');
    lbl.className = 'option-item';
    lbl.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.name = name;
    input.checked = defaultChecked;
    input.dataset.defaultChecked = defaultChecked;
    input.setAttribute('aria-describedby', `${id}-desc`);
    if (enabledExtensions) {
      input.dataset.enabledExtensions = enabledExtensions.join(',');
    }

    const wrapper = document.createElement('span');

    const labelRow = document.createElement('span');
    labelRow.className = 'option-label-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'option-label';
    labelEl.textContent = label;

    const tagEl = document.createElement('span');
    tagEl.className = 'option-tag';
    tagEl.textContent = tag;

    labelRow.append(labelEl, tagEl);

    const descEl = document.createElement('span');
    descEl.className = 'option-desc';
    descEl.id = `${id}-desc`;
    descEl.textContent = description;

    wrapper.append(labelRow, descEl);
    lbl.append(input, wrapper);
    optionsGrid.appendChild(lbl);
  });
}

/**
 * Enables or disables options based on the selected file.
 * When file is null (no selection or multiple files selected), all extension-restricted
 * options are disabled — multiple files may have mixed types and the server ignores
 * inapplicable conversions, but disabling avoids confusing silent no-ops.
 */
function updateOptionAvailability(file) {
  if (!file) {
    // No file or multiple files selected — disable all extension-restricted options
    OPTIONS.forEach(({ id, enabledExtensions }) => {
      if (!enabledExtensions) {
        return;
      }
      const input = document.getElementById(id);
      if (!input) {
        return;
      }
      input.disabled = true;
      input.checked = false;
      const label = input.closest('label');
      if (label) {
        label.classList.add('option-disabled');
      }
    });
    if (optionsNote) {
      optionsNote.textContent =
        selectedFiles.length > 1
          ? 'Conversion options are unavailable when multiple files are selected.'
          : '';
      optionsNote.classList.toggle('hidden', selectedFiles.length <= 1);
    }
    return;
  }

  if (optionsNote) {
    optionsNote.textContent = '';
    optionsNote.classList.add('hidden');
  }

  OPTIONS.forEach(({ id, enabledExtensions }) => {
    if (!enabledExtensions) {
      return;
    }
    const input = document.getElementById(id);
    if (!input) {
      return;
    }
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    const enabled = enabledExtensions.includes(ext);
    const wasDisabled = input.disabled;
    input.disabled = !enabled;
    if (!enabled) {
      input.checked = false;
    } else if (wasDisabled) {
      input.checked = input.dataset.defaultChecked === 'true';
    }
    const label = input.closest('label');
    if (label) {
      label.classList.toggle('option-disabled', !enabled);
    }
  });
}

/** Wires mutual-exclusion behaviour so checking one format option unchecks the other. */
function wireMutualExclusion() {
  MUTUALLY_EXCLUSIVE.forEach((id) => {
    document.getElementById(id).addEventListener('change', (e) => {
      if (e.target.checked) {
        MUTUALLY_EXCLUSIVE.forEach((otherId) => {
          if (otherId !== id) {
            document.getElementById(otherId).checked = false;
          }
        });
      }
    });
  });
}

let selectedFiles = [];
let currentUploadId = 0;

/** Returns a human-readable file size string. */
function formatSize(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/** Enables the submit button when one or more files are selected or a URL is entered. */
function updateSubmitState() {
  submitBtn.disabled = selectedFiles.length === 0 && !urlInput.value.trim();
}

/** Updates UI to reflect the currently selected files, or clears if empty. */
function setFiles(files) {
  selectedFiles = files.slice();
  updateSubmitState();
  if (files.length === 0) {
    zoneEmpty.classList.remove('hidden');
    zoneSelected.classList.add('hidden');
    dropZone.classList.remove('has-file');
    dropZone.setAttribute('aria-label', 'Choose or drop ebook files');
    fileInput.value = '';
    fileQueue.innerHTML = '';
    fileQueue.classList.add('hidden');
  } else if (files.length === 1) {
    zoneEmpty.classList.add('hidden');
    zoneSelected.classList.remove('hidden');
    zoneFileName.textContent = files[0].name;
    zoneFileSize.textContent = formatSize(files[0].size);
    dropZone.classList.add('has-file');
    dropZone.setAttribute('aria-label', `Selected: ${files[0].name}`);
    fileQueue.innerHTML = '';
    fileQueue.classList.add('hidden');
  } else {
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    zoneEmpty.classList.add('hidden');
    zoneSelected.classList.remove('hidden');
    zoneFileName.textContent = `${files.length} files selected`;
    zoneFileSize.textContent = formatSize(totalSize);
    dropZone.classList.add('has-file');
    dropZone.setAttribute('aria-label', `${files.length} files selected`);
    fileQueue.innerHTML = '';
    files.forEach((f, idx) => {
      const li = document.createElement('li');
      li.dataset.index = idx;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'fq-name';
      nameSpan.textContent = f.name;
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'fq-size';
      sizeSpan.textContent = formatSize(f.size);
      const statusSpan = document.createElement('span');
      statusSpan.className = 'fq-status';
      statusSpan.id = `fq-status-${idx}`;
      statusSpan.textContent = 'queued';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'fq-remove';
      removeBtn.setAttribute('aria-label', `Remove ${f.name}`);
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', () => {
        const newFiles = selectedFiles.filter((_, i) => i !== idx);
        setFiles(newFiles);
      });
      li.append(nameSpan, sizeSpan, statusSpan, removeBtn);
      fileQueue.appendChild(li);
    });
    fileQueue.classList.remove('hidden');
  }
  // Pass single file for per-type options; null disables extension-restricted options for mixed
  updateOptionAvailability(files.length === 1 ? files[0] : null);
}

/** Updates the status badge for file at index in the queue list. */
function setFileQueueStatus(index, text, modifier) {
  const el = document.getElementById(`fq-status-${index}`);
  if (!el) {
    return;
  }
  el.textContent = text;
  el.className = 'fq-status' + (modifier ? ` fq-${modifier}` : '');
}

/** Hides remove buttons in the queue (during upload). */
function lockFileQueue() {
  fileQueue.querySelectorAll('.fq-remove').forEach((btn) => btn.classList.add('hidden'));
}

/** Shows remove buttons in the queue (after upload fails). */
function unlockFileQueue() {
  fileQueue.querySelectorAll('.fq-remove').forEach((btn) => btn.classList.remove('hidden'));
}

/**
 * Resets the form for a new upload without clearing the file queue.
 * Used after a successful multi-file upload so completed rows stay visible.
 */
function resetFormAfterUpload() {
  selectedFiles = [];
  updateSubmitState();
  zoneEmpty.classList.remove('hidden');
  zoneSelected.classList.add('hidden');
  dropZone.classList.remove('has-file');
  dropZone.setAttribute('aria-label', 'Choose or drop ebook files');
  fileInput.value = '';
  updateOptionAvailability(null);
}

const HISTORY_KEY = 'bookdrop-sent';
const HISTORY_MAX = 5;
const HISTORY_TTL_MS = 60 * 60 * 1000;

/** Adds filenames from successful upload response texts to session history. */
function addToHistory(responseTexts) {
  const existing = readHistory();
  const now = Date.now();
  const newEntries = responseTexts
    .map((text) => {
      const match = text.match(/^Filename: (.+)$/m);
      return match ? { name: match[1].trim(), sentAt: now } : null;
    })
    .filter(Boolean);
  if (newEntries.length === 0) {
    return;
  }
  const merged = [...newEntries, ...existing].slice(0, HISTORY_MAX);
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
  } catch {}
}

function readHistory() {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const entries = JSON.parse(raw);
    const cutoff = Date.now() - HISTORY_TTL_MS;
    return entries.filter((e) => e.sentAt > cutoff).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Returns a short relative time string like "2 min ago" or "just now". */
function relativeTime(sentAt) {
  const mins = Math.floor((Date.now() - sentAt) / 60_000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins} min ago`;
  }
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr ago`;
}

/** Renders the recently-sent history section. */
function renderHistory() {
  const entries = readHistory();
  if (entries.length === 0) {
    historySection.classList.add('hidden');
    return;
  }
  historyList.innerHTML = '';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'history-name';
    nameSpan.textContent = entry.name;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'history-time';
    timeSpan.textContent = relativeTime(entry.sentAt);
    li.append(nameSpan, timeSpan);
    historyList.appendChild(li);
  });
  historySection.classList.remove('hidden');
}

/** Returns true if the file's extension is in ACCEPTED_EXTENSIONS, showing an error otherwise. */
function validateFile(file) {
  const ext = `.${file.name.split('.').pop().toLowerCase()}`;
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    showStatus(
      'error',
      `Unsupported format: ${file.name}\nAllowed: ${ACCEPTED_EXTENSIONS.join(', ')}`
    );
    return false;
  }
  return true;
}

/** Validates all files from a FileList and stages them, or shows an error and stops. */
function handleFiles(files) {
  if (!files || files.length === 0) {
    setFiles([]);
    return;
  }
  const valid = [];
  for (let i = 0; i < files.length; i++) {
    if (!validateFile(files[i])) {
      return; // validateFile already showed the error
    }
    valid.push(files[i]);
  }
  setFiles(valid);
  hideStatus();
}

zoneClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setFiles([]);
  hideStatus();
  dropZone.focus();
});

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.target !== dropZone) {
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
urlInput.addEventListener('input', updateSubmitState);

/** Builds a brief success summary string suitable for a toast. */
function buildSuccessToast(messages) {
  const deviceMatch = messages
    .find((m) => /^Sent to /m.test(m))
    ?.match(/^Sent to ([^(\n]+?)(?:\s*\(|$)/m);
  const device = deviceMatch ? deviceMatch[1].trim() : 'your device';
  const count = messages.length;
  return count === 1 ? `1 file sent to ${device}` : `${count} files sent to ${device}`;
}

/** Shows a self-dismissing toast notification for 3 seconds. */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 2700);
}

/** Displays a status message of the given type ('info', 'success', or 'error'). */
function showStatus(type, message) {
  statusMsg.textContent = message;
  statusMsg.className = `status-msg status-${type}`;
  statusMsg.classList.remove('hidden');
  if (type === 'error' || type === 'success') {
    statusMsg.focus();
  }
}

/** Hides the status message. */
function hideStatus() {
  statusMsg.classList.add('hidden');
}

/** Updates the progress bar visibility and fill percentage. */
function setProgress(value, visible) {
  progressWrap.classList.toggle('hidden', !visible);
  progressWrap.setAttribute('aria-valuenow', value);
  progressFill.style.setProperty('--progress', `${value}%`);
}

/**
 * Wraps a single XHR upload attempt in a Promise.
 * Resolves with the XHR on load (caller checks xhr.status).
 * Rejects on network-level error.
 */
/**
 * Turns the raw array of per-request server responses into a single human-friendly string.
 *
 * Single file:  "Sent to Kobo\nbook.epub"  (strips redundant "Filename: " label)
 * Multi-file:   "3 files sent to Kobo\n• book1.epub\n• book2.epub (converted with Kepubify)"
 * URL messages  ("URL added: …") are appended as-is after the file summary.
 */
function formatSuccessMessages(messages) {
  const fileMessages = [];
  const urlMessages = [];
  for (let i = 0; i < messages.length; i++) {
    if (/^Sent to /m.test(messages[i])) {
      fileMessages.push(messages[i]);
    } else {
      urlMessages.push(messages[i]);
    }
  }

  const lines = [];

  if (fileMessages.length === 1) {
    // Single file: keep the "Sent to …" header and prefix the filename with a bullet.
    lines.push(fileMessages[0].replace(/^Filename: /m, '\u2022 '));
  } else if (fileMessages.length > 1) {
    // Multiple files: one summary header, then a bulleted filename list.
    const deviceMatch = fileMessages[0].match(/^Sent to ([^(\n]+?)(?:\s*\(|$)/m);
    const device = deviceMatch ? deviceMatch[1].trim() : 'your device';
    lines.push(fileMessages.length + ' files sent to ' + device);
    for (let j = 0; j < fileMessages.length; j++) {
      const filenameMatch = fileMessages[j].match(/^Filename: (.+)$/m);
      if (!filenameMatch) {
        continue;
      }
      let entry = '\u2022 ' + filenameMatch[1];
      const convMatch = fileMessages[j].match(/converted with ([^)]+)\)/);
      if (convMatch) {
        entry += ' \u2014 converted with ' + convMatch[1];
      }
      if (/Metadata lookup failed/.test(fileMessages[j])) {
        entry += ' \u2014 metadata unchanged';
      }
      lines.push(entry);
    }
  }

  for (let k = 0; k < urlMessages.length; k++) {
    lines.push(urlMessages[k]);
  }

  return lines.join('\n');
}

function attemptUpload(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload', true);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    });
    xhr.addEventListener('load', () => resolve(xhr));
    xhr.addEventListener('error', () => reject(new Error('network')));
    xhr.send(formData);
  });
}

/**
 * Builds FormData for a single file upload.
 * Pass file=null for URL-only posts.
 */
function buildFormData(key, urlVal, file) {
  const formData = new FormData();
  formData.set('key', key);
  if (file) {
    formData.set('file', file, file.name);
  }
  if (urlVal) {
    formData.set('url', urlVal);
  }
  OPTIONS.forEach(({ id, name }) => {
    if (document.getElementById(id).checked) {
      formData.set(name, 'on');
    }
  });
  return formData;
}

/**
 * Uploads a single file with one retry on network failure.
 * On Android, cloud-storage files can fail mid-stream; buffering first avoids that.
 * Throws with message 'read' if the file can't be read into memory.
 */
async function uploadOneFile(key, urlVal, file, onProgress) {
  let xhr;
  try {
    xhr = await attemptUpload(buildFormData(key, urlVal, file), onProgress);
  } catch {
    onProgress(0);
    showStatus('info', 'Retrying\u2026');
    let retryFile;
    try {
      const buffer = await file.arrayBuffer();
      retryFile = new File([buffer], file.name, { type: file.type });
    } catch {
      throw new Error('read');
    }
    xhr = await attemptUpload(buildFormData(key, urlVal, retryFile), onProgress);
  }
  return xhr;
}

document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const key = document.getElementById('keyinput').value.trim().toUpperCase();
  if (key.length !== 4) {
    showStatus('error', 'Please enter the 4-character key shown on your e-reader.');
    return;
  }

  const urlVal = urlInput.value.trim();
  if (selectedFiles.length === 0 && !urlVal) {
    showStatus('error', 'Please choose a file or enter a URL.');
    return;
  }

  if (urlVal) {
    try {
      const parsed = new URL(urlVal);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error();
      }
    } catch {
      showStatus('error', 'Please enter a valid http or https URL.');
      return;
    }
  }

  const uploadId = ++currentUploadId;
  submitBtn.disabled = true;

  const filesToUpload = selectedFiles.slice(); // capture before any async gaps
  const successMessages = [];

  if (urlVal && filesToUpload.length > 0) {
    setProgress(0, true);
    showStatus('info', 'Staging URL\u2026');
    let urlXhr;
    try {
      urlXhr = await attemptUpload(buildFormData(key, urlVal, null), () => {});
    } catch {
      if (uploadId !== currentUploadId) {
        return;
      }
      submitBtn.disabled = false;
      setProgress(0, false);
      showStatus('error', 'Could not reach the server. Is it running?');
      return;
    }
    if (uploadId !== currentUploadId) {
      return;
    }
    if (urlXhr.status < 200 || urlXhr.status >= 300) {
      submitBtn.disabled = false;
      setProgress(0, false);
      showStatus('error', urlXhr.responseText || 'Failed to stage URL.');
      return;
    }
    successMessages.push(urlXhr.responseText);
  }

  if (filesToUpload.length === 0) {
    setProgress(0, true);
    showStatus('info', 'Uploading\u2026');
    let xhr;
    try {
      xhr = await attemptUpload(buildFormData(key, urlVal, null), () => {});
    } catch {
      if (uploadId !== currentUploadId) {
        return;
      }
      submitBtn.disabled = false;
      setProgress(0, false);
      showStatus('error', 'Could not reach the server. Is it running?');
      return;
    }
    if (uploadId !== currentUploadId) {
      return;
    }
    submitBtn.disabled = false;
    setProgress(0, false);
    if (xhr.status >= 200 && xhr.status < 300) {
      hideStatus();
      showToast(xhr.responseText);
      urlInput.value = '';
      updateSubmitState();
    } else {
      showStatus('error', xhr.responseText || 'Upload failed.');
    }
    return;
  }

  const total = filesToUpload.length;
  if (total > 1) {
    lockFileQueue();
  }
  for (let i = 0; i < total; i++) {
    if (uploadId !== currentUploadId) {
      return;
    }

    const fileLabel = total > 1 ? ` (${i + 1} of ${total})` : '';

    const onProgress = (pct) => {
      setProgress(pct, true);
      if (pct < 100) {
        statusMsg.textContent = `Uploading${fileLabel}\u2026 ${pct}%`;
        if (total > 1) {
          setFileQueueStatus(i, `${pct}%`, 'uploading');
        }
      } else {
        statusMsg.textContent = `Processing${fileLabel} please wait`;
        if (total > 1) {
          setFileQueueStatus(i, 'processing', 'uploading');
        }
      }
    };

    setProgress(0, true);
    statusMsg.textContent = `Uploading${fileLabel}\u2026`;
    statusMsg.className = 'status-msg status-info is-processing';
    statusMsg.classList.remove('hidden');
    if (total > 1) {
      setFileQueueStatus(i, 'uploading\u2026', 'uploading');
    }

    let xhr;
    try {
      xhr = await uploadOneFile(key, '', filesToUpload[i], onProgress);
    } catch (err) {
      if (uploadId !== currentUploadId) {
        return;
      }
      if (total > 1) {
        setFileQueueStatus(i, '\u2717 error', 'error');
        unlockFileQueue();
      }
      submitBtn.disabled = false;
      setProgress(0, false);
      if (successMessages.length > 0) {
        addToHistory(successMessages);
        renderHistory();
        showToast(buildSuccessToast(successMessages));
        resetFormAfterUpload();
        urlInput.value = '';
        updateSubmitState();
      }
      if (err.message === 'read') {
        showStatus(
          'error',
          `Could not read \u201c${filesToUpload[i].name}\u201d \u2014 try downloading it to your device first.`
        );
      } else {
        showStatus(
          'error',
          `Upload failed for \u201c${filesToUpload[i].name}\u201d. Try downloading the file to your device before uploading.`
        );
      }
      return;
    }

    if (uploadId !== currentUploadId) {
      return;
    }

    if (xhr.status < 200 || xhr.status >= 300) {
      if (total > 1) {
        setFileQueueStatus(i, '\u2717 error', 'error');
        unlockFileQueue();
      }
      submitBtn.disabled = false;
      setProgress(0, false);
      if (successMessages.length > 0) {
        addToHistory(successMessages);
        renderHistory();
        showToast(buildSuccessToast(successMessages));
        resetFormAfterUpload();
        urlInput.value = '';
        updateSubmitState();
      }
      showStatus('error', xhr.responseText || 'Upload failed.');
      return;
    }

    if (total > 1) {
      setFileQueueStatus(i, '\u2713 done', 'done');
    }
    successMessages.push(xhr.responseText);
  }

  if (uploadId !== currentUploadId) {
    return;
  }
  submitBtn.disabled = false;
  setProgress(0, false);
  addToHistory(successMessages);
  renderHistory();
  hideStatus();
  if (total > 1) {
    // Queue rows already show ✓ done — just show a brief summary, keep queue visible.
    showToast(buildSuccessToast(successMessages));
    resetFormAfterUpload();
  } else {
    showToast(formatSuccessMessages(successMessages));
    setFiles([]);
  }
  urlInput.value = '';
  updateSubmitState();
});

/** Checks if a file was shared via the Web Share Target API and pre-populates the drop zone. */
async function checkPendingShare() {
  if (!('caches' in window)) {
    return;
  }
  const cache = await caches.open('bookdrop-share');
  const response = await cache.match('/pending-share');
  if (!response) {
    return;
  }
  await cache.delete('/pending-share');
  const name = decodeURIComponent(response.headers.get('X-File-Name') || 'shared-file');
  const file = new File([await response.blob()], name, {
    type: response.headers.get('Content-Type') || 'application/octet-stream',
  });
  if (validateFile(file)) {
    setFiles([file]);
  }
}

/** Sets a conversion checkbox by id, triggering mutual-exclusion side-effects. */
function setOption(id, checked) {
  const el = document.getElementById(id);
  if (el && el.checked !== checked) {
    el.checked = checked;
    el.dispatchEvent(new Event('change'));
  }
}

/** Queries the device type for a key and autoselects the matching conversion option. */
function lookupDevice(key) {
  fetch('/device/' + key)
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      if (!data) {
        return;
      }
      if (data.device === 'Kindle') {
        setOption('kindlegen', true);
      } else if (data.device === 'Kobo') {
        setOption('kepubify', true);
      } else if (data.device === 'Tolino') {
        setOption('kepubify', false);
        setOption('kindlegen', false);
      }
    })
    .catch(function () {});
}

document.getElementById('keyinput').addEventListener('input', function (e) {
  const key = e.target.value.trim().toUpperCase();
  if (key.length === 4) {
    lookupDevice(key);
  }
});

buildOptionsGrid();
wireMutualExclusion();
checkPendingShare();
renderHistory();

// Pre-fill key from ?key= URL parameter (e.g. when arriving via QR code scan)
(function () {
  const params = new URLSearchParams(location.search);
  const urlKey = params.get('key');
  if (!urlKey) {
    return;
  }
  const input = document.getElementById('keyinput');
  if (!input) {
    return;
  }
  const trimmed = urlKey.toUpperCase().slice(0, 4);
  input.value = trimmed;
  if (trimmed.length === 4) {
    lookupDevice(trimmed);
  }
})();
