const ACCEPTED_EXTENSIONS = ['.epub', '.mobi', '.pdf', '.txt', '.cbz', '.cbr'];
const ACCEPT_ATTR = [
  ...ACCEPTED_EXTENSIONS,
  'application/epub+zip',
  'application/epub',
  'application/x-mobipocket-ebook',
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
const submitBtn = document.getElementById('submit-btn');
const urlInput = document.getElementById('urlinput');
const statusMsg = document.getElementById('status-msg');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const pageUrlLink = document.getElementById('page-url');

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

/** Enables or disables options that restrict to certain file extensions based on the selected file. */
function updateOptionAvailability(file) {
  OPTIONS.forEach(({ id, enabledExtensions }) => {
    if (!enabledExtensions) {
      return;
    }
    const input = document.getElementById(id);
    if (!input) {
      return;
    }
    const ext = file ? '.' + file.name.split('.').pop().toLowerCase() : null;
    const enabled = ext === null || enabledExtensions.includes(ext);
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

let selectedFile = null;
let currentUploadId = 0;

/** Returns a human-readable file size string. */
function formatSize(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/** Enables the submit button when a file is selected or a URL is entered. */
function updateSubmitState() {
  submitBtn.disabled = !selectedFile && !urlInput.value.trim();
}

/** Updates UI to reflect the currently selected file, or clears it if file is null. */
function setFile(file) {
  selectedFile = file;
  updateSubmitState();
  if (file) {
    zoneEmpty.classList.add('hidden');
    zoneSelected.classList.remove('hidden');
    zoneFileName.textContent = file.name;
    zoneFileSize.textContent = formatSize(file.size);
    dropZone.classList.add('has-file');
    dropZone.setAttribute('aria-label', `Selected: ${file.name}`);
  } else {
    zoneEmpty.classList.remove('hidden');
    zoneSelected.classList.add('hidden');
    dropZone.classList.remove('has-file');
    dropZone.setAttribute('aria-label', 'Choose or drop an ebook file');
  }
  updateOptionAvailability(file);
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

/** Validates and stages the first file from a FileList. */
function handleFiles(files) {
  const f = files && files[0];
  if (!f) {
    setFile(null);
    return;
  }
  if (validateFile(f)) {
    setFile(f);
    hideStatus();
  }
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
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

statusMsg.addEventListener('click', () => {
  if (!statusMsg.classList.contains('status-info')) {
    hideStatus();
  }
});

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
function attemptUpload(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload', true);
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
 * Builds FormData for an upload. Pass fileOverride to substitute a pre-read
 * File (used on retry); omit to use the current selectedFile.
 */
function buildFormData(key, urlVal, fileOverride) {
  const file = fileOverride !== undefined ? fileOverride : selectedFile;
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

document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const key = document.getElementById('keyinput').value.trim().toUpperCase();
  if (key.length !== 4) {
    showStatus('error', 'Please enter the 4-character key shown on your e-reader.');
    return;
  }

  const urlVal = urlInput.value.trim();
  if (!selectedFile && !urlVal) {
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
  setProgress(0, true);
  showStatus('info', 'Uploading\u2026');

  const fileAtSubmit = selectedFile; // capture before any async gaps

  const onProgress = (pct) => {
    setProgress(pct, true);
    showStatus('info', pct < 100 ? `Uploading\u2026 ${pct}%` : 'Processing\u2026 please wait');
  };

  function handleResponse(xhr) {
    if (uploadId !== currentUploadId) {
      return;
    }
    submitBtn.disabled = false;
    setProgress(0, false);
    if (xhr.status >= 200 && xhr.status < 300) {
      showStatus('success', xhr.responseText);
      setFile(null);
      urlInput.value = '';
      updateSubmitState();
    } else {
      showStatus('error', xhr.responseText || 'Upload failed.');
    }
  }

  let xhr;
  try {
    xhr = await attemptUpload(buildFormData(key, urlVal), onProgress);
  } catch {
    if (uploadId !== currentUploadId) {
      return;
    }

    if (!fileAtSubmit) {
      // URL-only: no content URI involved, don't retry.
      submitBtn.disabled = false;
      setProgress(0, false);
      showStatus('error', 'Could not reach the server. Is it running?');
      return;
    }

    // File upload failed at network level — pre-read into memory and retry once.
    // On Android, cloud storage files (e.g. Dropbox) stream from a content provider
    // that can fail mid-upload; buffering first avoids that streaming failure.
    showStatus('info', 'Retrying\u2026');
    setProgress(0, true);

    let retryFile;
    try {
      const buffer = await fileAtSubmit.arrayBuffer();
      retryFile = new File([buffer], fileAtSubmit.name, { type: fileAtSubmit.type });
    } catch {
      if (uploadId !== currentUploadId) {
        return;
      }
      submitBtn.disabled = false;
      setProgress(0, false);
      showStatus(
        'error',
        'Upload failed. Could not read the file \u2014 try downloading it to your device first.'
      );
      return;
    }

    try {
      xhr = await attemptUpload(buildFormData(key, urlVal, retryFile), onProgress);
    } catch {
      if (uploadId !== currentUploadId) {
        return;
      }
      submitBtn.disabled = false;
      setProgress(0, false);
      showStatus(
        'error',
        'Upload failed. Try downloading the file to your device before uploading.'
      );
      return;
    }
  }

  handleResponse(xhr);
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
    setFile(file);
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
