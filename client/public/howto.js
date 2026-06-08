function initHowto() {
  const dialog = document.getElementById('howto-dialog');
  const openBtn = document.getElementById('howto-toggle');
  if (!dialog || !openBtn || typeof dialog.showModal !== 'function') {
    return;
  }

  openBtn.addEventListener('click', () => dialog.showModal());

  // Backdrop click closes — but only when both mousedown and mouseup land on the
  // dialog itself, so a text-drag that ends outside the content area doesn't close.
  let downOnBackdrop = false;
  dialog.addEventListener('mousedown', (e) => {
    downOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener('mouseup', (e) => {
    if (downOnBackdrop && e.target === dialog) {
      dialog.close();
    }
    downOnBackdrop = false;
  });

  dialog.addEventListener('close', () => {
    try {
      localStorage.setItem('bookdrop-howto-seen', '1');
    } catch (_) {}
  });

  let seen = null;
  try {
    seen = localStorage.getItem('bookdrop-howto-seen');
  } catch (_) {}
  const hasKeyParam = new URLSearchParams(location.search).has('key');
  if (!seen && !hasKeyParam) {
    dialog.showModal();
  }
}

document.addEventListener('DOMContentLoaded', initHowto);
