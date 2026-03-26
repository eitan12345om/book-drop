// NOTE: this file runs on old Kobo WebKit (538.1) which does not support `let`.
// Use `var` for mutable variables; `const` is fine.
/* eslint-disable no-var */
const POLL_INTERVAL_MS = 5000;
var currentKey = null;
var pollTimer = null;
var currentSSE = null;

const keyDisplay = document.getElementById('key-display');
const refreshBtn = document.getElementById('refresh-btn');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const downloadCard = document.getElementById('download-card');
const downloadCardTitle = document.getElementById('download-card-title');
const downloadList = document.getElementById('download-list');
const errorMsg = document.getElementById('error-msg');
const pageUrlLink = document.getElementById('page-url');

pageUrlLink.href = window.location.href;
pageUrlLink.textContent = window.location.href;

/** Updates the connection status indicator dot and label. */
function setStatus(state, label) {
  statusDot.className =
    'dot' + (state === 'active' ? ' dot-active' : state === 'waiting' ? ' dot-waiting' : ' hidden');
  statusLabel.textContent = label;
}

/** Displays an error banner with the given message. */
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

/** Hides the error banner. */
function hideError() {
  errorMsg.classList.add('hidden');
  errorMsg.textContent = '';
}

/** Cancels the active polling interval. */
function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Closes the active SSE connection. */
function stopSSE() {
  if (currentSSE !== null) {
    currentSSE.close();
    currentSSE = null;
  }
}

/** Handles a parsed status payload from either SSE or poll. */
function handleStatusPayload(data) {
  hideError();
  const file = data.file || null;
  const urls = data.urls || [];
  const hasContent = (file && file.name) || urls.length > 0;
  setStatus(
    hasContent ? 'active' : 'waiting',
    hasContent ? 'File ready \u2014 tap to download' : 'Waiting for a file to be sent\u2026'
  );
  renderDownloads(file, urls);
}

/** Opens an SSE connection for the given key; falls back to polling if SSE is unsupported or errors. */
function startSSE(key) {
  stopSSE();

  if (typeof EventSource === 'undefined') {
    // SSE not supported — start polling immediately
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    return;
  }

  var es;
  try {
    es = new EventSource('/events/' + encodeURIComponent(key));
  } catch (_) {
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    return;
  }
  currentSSE = es;

  es.onmessage = function (e) {
    var data;
    try {
      data = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    handleStatusPayload(data);
  };

  es.addEventListener('expired', function () {
    stopSSE();
    stopPolling();
    currentKey = null;
    renderDownloads(null, []);
    setStatus('idle', '');
    showError('Key expired. Tap refresh to get a new one.');
  });

  es.onerror = function () {
    stopSSE();
    // Fall back to polling if the SSE connection drops
    if (currentKey) {
      poll();
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }
  };
}

/** Renders the download card with links for the staged file and any URLs, or hides it if empty. */
function renderDownloads(file, urls) {
  const hasFile = file && file.name;
  const hasUrls = urls && urls.length > 0;
  const hasContent = hasFile || hasUrls;

  if (!hasContent) {
    downloadCard.classList.add('hidden');
    downloadList.innerHTML = '';
    return;
  }

  if (hasFile && hasUrls) {
    downloadCardTitle.textContent = 'Downloads & links';
  } else if (hasFile) {
    downloadCardTitle.textContent = 'Download';
  } else {
    downloadCardTitle.textContent = 'Links';
  }

  downloadList.innerHTML = '';

  if (hasFile) {
    const a = document.createElement('a');
    a.href = '/' + encodeURIComponent(file.name) + '?key=' + encodeURIComponent(currentKey);
    a.className = 'download-item';
    a.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2a.75.75 0 0 1 .75.75v8.69l2.47-2.47a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L5.72 10.03a.75.75 0 1 1 1.06-1.06l2.47 2.47V2.75A.75.75 0 0 1 10 2ZM3.75 15a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H3.75Z"/></svg>';
    const span = document.createElement('span');
    span.textContent = file.name;
    a.appendChild(span);
    downloadList.appendChild(a);

    var diff = file.metadataDiff;
    if (diff && Object.keys(diff).length > 0) {
      var diffEl = document.createElement('div');
      diffEl.className = 'metadata-diff';
      Object.keys(diff).forEach(function (field) {
        var change = diff[field];
        var row = document.createElement('div');
        row.className = 'metadata-diff-row';
        var fieldEl = document.createElement('span');
        fieldEl.className = 'metadata-field';
        fieldEl.textContent = field;
        var beforeEl = document.createElement('span');
        beforeEl.className = 'metadata-before';
        beforeEl.textContent = change.before || '(none)';
        var arrowEl = document.createElement('span');
        arrowEl.className = 'metadata-arrow';
        arrowEl.textContent = '\u2192';
        var afterEl = document.createElement('span');
        afterEl.className = 'metadata-after';
        afterEl.textContent = change.after;
        row.appendChild(fieldEl);
        row.appendChild(beforeEl);
        row.appendChild(arrowEl);
        row.appendChild(afterEl);
        diffEl.appendChild(row);
      });
      downloadList.appendChild(diffEl);
    }
  }

  if (hasUrls) {
    for (var i = 0; i < urls.length; i++) {
      var safeUrl;
      if (!/^https?:\/\//i.test(urls[i])) {
        continue;
      }
      safeUrl = urls[i];
      const link = document.createElement('a');
      link.href = safeUrl;
      link.className = 'download-item';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z"/><path d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z"/></svg>';
      const urlSpan = document.createElement('span');
      urlSpan.textContent = urls[i];
      link.appendChild(urlSpan);
      downloadList.appendChild(link);
    }
  }

  downloadCard.classList.remove('hidden');
}

/** Polls the status endpoint once and updates the UI based on the response. */
function poll() {
  if (!currentKey) {
    return;
  }
  const key = currentKey;
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/status/' + encodeURIComponent(key));
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) {
      return;
    }
    if (key !== currentKey) {
      return;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      var data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (_) {
        return;
      }
      handleStatusPayload(data);
    } else if (xhr.status === 0) {
      stopPolling();
      showError('Could not reach the server.');
      setStatus('idle', '');
    } else {
      stopPolling();
      currentKey = null;
      renderDownloads(null, []);
      setStatus('idle', '');
      showError('Key expired. Tap refresh to get a new one.');
    }
  };
  xhr.send();
}

/** Requests a new session key from the server and begins SSE. */
function requestKey() {
  stopPolling();
  stopSSE();
  hideError();
  currentKey = null;
  keyDisplay.textContent = '\u2013\u2013\u2013\u2013';
  keyDisplay.setAttribute('aria-label', 'Generating key');
  renderDownloads(null, []);
  setStatus('idle', 'Generating key\u2026');
  refreshBtn.disabled = true;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/generate');
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) {
      return;
    }
    refreshBtn.disabled = false;
    if (xhr.status >= 200 && xhr.status < 300) {
      const key = xhr.responseText.trim();
      currentKey = key;
      keyDisplay.textContent = key;
      keyDisplay.setAttribute('aria-label', 'Key: ' + key.split('').join(' '));
      setStatus('waiting', 'Waiting for a file to be sent\u2026');
      startSSE(key);
    } else {
      showError(xhr.responseText || 'Could not reach the server. Is it running?');
      setStatus('idle', '');
    }
  };
  xhr.send();
}

refreshBtn.addEventListener('click', requestKey);

requestKey();
