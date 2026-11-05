function initThemeToggle() {
  var btn = document.getElementById('theme-toggle');
  if (!btn) {
    return;
  }

  function update() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  btn.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (_) {}
    update();
  });

  update();
}

document.addEventListener('DOMContentLoaded', initThemeToggle);
