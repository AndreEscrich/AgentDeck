// The notifications in the corner of the screen (toast.html, src/toast.js).
// Each is the agent's Hub tile as the app sent it (hub.snapshot), with what
// happened under its title. Its tank fills up when it comes in, and a
// finished one sloshes like in the Hub. They stack up, the newest at the
// bottom, and stay until you open the app (or dismiss one with its ×).

const box = document.getElementById('toasts');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-mother').disabled = theme !== 'mother';
  document.getElementById('theme-light').disabled = theme !== 'light';
}

// The window takes the room the tiles need (none: it hides). Measured at
// once: while the window is hidden, its page gets no animation frames.
function resize() {
  const live = box.querySelectorAll('.notice:not(.leaving)').length;
  window.toastHost.size(live ? box.offsetWidth : 0, live ? box.offsetHeight : 0);
}

function dismiss(toast) {
  if (toast.classList.contains('leaving')) return;
  toast.classList.add('leaving');
  setTimeout(() => { toast.remove(); resize(); }, 300);
}

window.toastHost.onAdd(({ id, body, tile, theme }) => {
  applyTheme(theme || 'default');
  // A newer notification about the same agent takes the place of the older.
  for (const old of box.querySelectorAll('.notice')) if (old.dataset.id === id) old.remove();
  const toast = document.createElement('div');
  toast.className = 'notice';
  toast.dataset.id = id;
  toast.innerHTML = tile;
  const el = toast.firstElementChild;
  const step = el.querySelector('.hub-step');
  if (step && body) {
    step.textContent = body;
    step.title = body;
    step.classList.remove('hidden', 'changed');
  }
  el.classList.remove('current');
  // It springs in once (the retro theme draws it); like in the Hub, the class
  // goes after, or a later animation would play it again.
  el.addEventListener('animationend', e => { if (e.target === el && ['spawn', 'mu-draw'].includes(e.animationName)) el.classList.remove('spawn'); });
  el.onclick = () => {
    window.toastHost.open(id);
    for (const t of box.querySelectorAll('.notice')) dismiss(t);
  };
  const close = el.querySelector('.tile-remove');
  if (close) {
    close.title = 'Dismiss';
    close.onclick = e => { e.stopPropagation(); dismiss(toast); };
  }
  box.appendChild(toast);
  // As many as fit on the screen: the oldest make room.
  const live = [...box.querySelectorAll('.notice:not(.leaving)')];
  while (live.length > 1 && box.offsetHeight > screen.availHeight) live.shift().remove();

  // The tank fills up from empty to where the agent is.
  const liquid = el.querySelector('.liquid');
  if (liquid) {
    const level = liquid.style.height;
    liquid.style.height = '0%';
    void liquid.offsetHeight;
    setTimeout(() => { liquid.style.height = level; }, 30);
  }
  if (el.classList.contains('state-idle')) {
    setTimeout(() => {
      el.classList.add('finish');
      setTimeout(() => el.classList.remove('finish'), 1300);
    }, 900);
  }
  resize();
});

window.toastHost.onClear(() => {
  for (const t of box.querySelectorAll('.notice')) dismiss(t);
});
