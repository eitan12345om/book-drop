// Apply theme immediately (before first paint) to avoid flash
(function () {
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute(
    'data-theme',
    stored === 'dark' || (!stored && prefersDark) ? 'dark' : 'light',
  );
})();

function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) {
    return;
  }

  function update() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    update();
  });

  update();
}

document.addEventListener('DOMContentLoaded', initThemeToggle);
