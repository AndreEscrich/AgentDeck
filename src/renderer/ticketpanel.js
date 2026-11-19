// The ticket panel: the floating panel a click on a key opens in the
// Tickets view (tickets.js), laid out like PM's own ticket view.
//
// On the left: the title (the pencil edits it), Description (Edit changes
// it), Attachments (a click opens one in the browser; drop files or click
// to upload), Subtasks (a progress bar, each subtask's status, priority and
// assignee; + adds one) and Comments. On the right: the status and the
// fields, each one editable: Assignee (and Assign to me), Assignee 2, Epic,
// Sprint, Components, Estimate, Priority, Story Points, Team and the
// project's custom fields for the ticket's type (Testable revision, Branch,
// Found in, ...). A subtask shows only the fields a subtask has.
//
// Every change goes to PM at once through the app's own sign-in
// (src/pmclient.js: pm_update_task / pm_update_subtask), and the panel then
// shows the ticket as PM has it now. The methods join TicketsView.

(() => {
  const P = TicketsView.prototype;
  const PRIORITIES = ['Critical', 'Highest', 'High', 'Medium', 'Low', 'Lowest'];
  const POINTS = [1, 2, 3, 5, 8, 13, 21];
  const up = d => `<path d="${d}" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  const PRIORITY_ICONS = {
    Critical: ['#e5493a', up('M6 11l6-5 6 5') + up('M6 17l6-5 6 5')],
    Highest: ['#e5493a', up('M6 11l6-5 6 5') + up('M6 17l6-5 6 5')],
    High: ['#e5493a', up('M6 15l6-6 6 6')],
    Medium: ['#f0a030', up('M6 10h12') + up('M6 15h12')],
    Low: ['#4c9aff', up('M6 9l6 6 6-6')],
    Lowest: ['#4c9aff', up('M6 7l6 5 6-5') + up('M6 13l6 5 6-5')],
  };
  const PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>';
  const UPLOAD = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z" fill="currentColor" opacity=".55"/><path d="M12 16V10m-3 3l3-3 3 3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const FILE = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M14 3v4h4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

  function priorityIcon(p) {
    const span = el('span', 'tp-priority');
    const icon = PRIORITY_ICONS[p];
    if (icon) span.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" style="color:${icon[0]}">${icon[1]}</svg>`;
    else span.textContent = '—';
    span.title = p ? `Priority: ${p}` : 'No priority';
    return span;
  }
  function initials(name) {
    const words = String(name || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    return ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }
  function avatar(name) {
    const span = el('span', 'tp-avatar', name ? initials(name) : '');
    let h = 0;
    for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
    span.style.background = name ? `hsl(${h} 45% 38%)` : 'transparent';
    if (!name) span.classList.add('none');
    span.title = name || 'Unassigned';
    return span;
  }
  function minutesText(m) {
    if (!m) return '';
    const h = Math.floor(m / 60), r = m % 60;
    return [h ? `${h}h` : '', r ? `${r}m` : ''].filter(Boolean).join(' ');
  }
  // "2h 30m", "1.5h", "45m", "1d" (8 hours) or a plain number of hours.
  function parseMinutes(text) {
    text = String(text || '').trim().toLowerCase();
    if (!text) return null;
    let total = 0, found = false;
    for (const [, n, unit] of text.matchAll(/(\d+(?:[.,]\d+)?)\s*([dhm]?)/g)) {
      found = true;
      total += parseFloat(n.replace(',', '.')) * (unit === 'd' ? 480 : unit === 'm' ? 1 : 60);
    }
    return found && total > 0 ? Math.round(total) : NaN;
  }
  function fileSize(n) {
    if (!n) return '';
    return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  const projectOf = t => t.project || String(t.key || '').split('-')[0];

  // ---------- data the panel needs besides the ticket ----------

  P.panelOptions = function (project) {
    this.optionLists ||= new Map();
    const hit = this.optionLists.get(project);
    if (hit && !hit.error) return hit;
    if (!hit?.loading) {
      this.optionLists.set(project, { loading: true });
      window.deck.pmOptions(project).then(r => {
        this.optionLists.set(project, r?.error ? { error: r.error } : r);
        if (r?.statuses?.length) this.statusLists.set(project, r.statuses);
        if (this.detailTicket && projectOf(this.detailTicket) === project) this.renderDetail(this.detailTicket, null);
      });
    }
    return null;
  };

  // Everyone the view has seen, for the assignee fields' suggestions.
  P.people = function () {
    const names = new Set();
    const add = t => { for (const n of [t?.assignee, t?.assignee2, t?.author]) if (n) names.add(n); };
    for (const d of Object.values(this.data)) (d.items || []).forEach(add);
    for (const d of this.subs.values()) (d.items || []).forEach(add);
    add(this.detailTicket);
    (this.detailTicket?.subtasks || []).forEach(add);
    return [...names].sort((a, b) => a.localeCompare(b));
  };

  // Your name as PM shows it: the assignee of most of your tickets.
  P.myName = function () {
    const count = new Map();
    for (const d of Object.values(this.data)) for (const t of d.items || []) if (t.assignee && !t.assignee.includes('@')) count.set(t.assignee, (count.get(t.assignee) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || this.email || 'Agent Hub';
  };

  // Attachments and comments, read when a ticket opens: key -> { items, loading, error }.
  P.panelList = function (store, key, read) {
    this[store] ||= new Map();
    const d = this[store].get(key);
    if (!d) {
      this[store].set(key, { loading: true });
      read().then(r => {
        this[store].set(key, Array.isArray(r) ? { items: r } : { error: r?.error || 'PM sent nothing.' });
        if (this.detailTicket?.key === key) this.renderDetail(this.detailTicket, null);
      });
      return { loading: true };
    }
    return d;
  };

  // ---------- saving ----------

  // Sends some fields to PM; the panel then shows the ticket as PM has it.
  P.saveFields = async function (t, fields) {
    this.panelBusy = true;
    this.detail.querySelector('.tp')?.classList.add('busy');
    const r = await window.deck.pmUpdate({ key: t.key, id: t.id, project: projectOf(t), subtask: !!t.subtask, fields })
      .catch(err => ({ error: String(err?.message || err) }));
    this.panelBusy = false;
    if (r?.notConnected) return this.setConnected({ connected: false });
    this.afterSave(t, r);
  };

  P.afterSave = function (t, r) {
    if (!r || r.error) {
      this.panelError = r?.error || 'PM did not answer.';
      if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
      return;
    }
    this.panelError = null;
    if (t.parentKey) r.parentKey = t.parentKey;
    const shown = ['title', 'status', 'category', 'color', 'textColor', 'statusId', 'priority', 'assignee', 'assignee2', 'sprint', 'epic'];
    for (const c of this.copies(r.key)) for (const f of shown) if (f in r) c[f] = r[f];
    if (!r.subtask && r.subtasks) this.subs.set(r.key, { items: r.subtasks });
    try { localStorage.setItem('pmTicketLists', JSON.stringify(this.data)); } catch { /* shown anyway */ }
    window.uiSound?.('done');
    this.renderList();
    if (this.selected === r.key) this.renderDetail(r, null);
  };

  // ---------- the panel ----------

  P.renderDetail = function (t, error) {
    const same = this.detailTicket?.key === t.key;
    const scroll = same ? this.detail.scrollTop : 0;
    if (!same) { this.panelError = null; this.editing = null; }
    this.detailTicket = t;
    const box = el('div', 'tp' + (this.panelBusy ? ' busy' : ''));
    box.append(this.panelTop(t), this.panelTitle(t));
    for (const text of [error, this.panelError]) if (text) box.append(el('div', 'tp-error', text));
    const cols = el('div', 'tp-cols');
    const main = el('div', 'tp-main');
    const side = el('div', 'tp-side');
    cols.append(main, side);
    box.append(cols);
    if (t.description === undefined && !error) main.append(el('div', 'gallery-note', 'Reading the ticket…'));
    else {
      main.append(this.panelDescription(t));
      if (t.id) main.append(this.panelAttachments(t));
      if (!t.subtask) main.append(this.panelSubtasks(t));
      main.append(this.panelComments(t));
    }
    this.panelSide(t, side);
    this.detail.replaceChildren(box);
    this.detail.scrollTop = scroll;
  };

  P.panelTop = function (t) {
    const top = el('div', 'tp-top');
    const crumbs = el('div', 'tp-crumbs');
    const sep = () => el('span', 'tp-sep', '›');
    if (t.epicName || t.epic) crumbs.append(el('span', 'tp-crumb', '⚑ ' + (t.epicName || t.epic)), sep());
    if (t.parentKey) {
      const parent = el('button', 'tp-crumb tp-crumb-link', shortKey(t.parentKey));
      parent.type = 'button';
      parent.title = `Back to ${t.parentKey}`;
      parent.onclick = () => this.select({ key: t.parentKey, project: projectOf(t), title: '', type: 'Story' });
      crumbs.append(parent, sep());
    }
    let icon;
    if (t.subtask) { icon = el('span', 'tickets-type-icon'); icon.innerHTML = SUBTASK_ICON; icon.title = 'Subtask'; }
    else icon = typeIcon(t.type);
    const link = el('a', 'tp-key', shortKey(t.key));
    link.href = pmItemUrl(t.key);
    link.target = '_blank';
    link.title = `Open ${t.key} in PM`;
    crumbs.append(icon, link);
    const tools = el('div', 'tp-tools');
    const start = el('button', 'gallery-use', 'Start agent');
    start.type = 'button';
    start.title = 'Put the ticket on the Hub\'s message box: say what to do and send. A Story with two or more subtasks gets the ⑂ Split button there.';
    start.onclick = () => this.onStart?.(t);
    const open = el('a', 'gallery-action', 'Open in PM');
    open.href = pmItemUrl(t.key);
    open.target = '_blank';
    const close = el('button', 'icon ticket-close', '✕');
    close.type = 'button';
    close.title = 'Close (Escape)';
    close.onclick = () => this.closeDetail();
    tools.append(start, open, close);
    top.append(crumbs, tools);
    return top;
  };

  P.panelTitle = function (t) {
    const row = el('div', 'tp-title-row');
    if (this.editing === 'title') {
      const input = document.createElement('input');
      input.className = 'tp-title-input';
      input.value = t.title;
      const done = save => {
        this.editing = null;
        const v = input.value.trim();
        if (save && v && v !== t.title) this.saveFields(t, { title: v });
        else this.renderDetail(t, null);
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      };
      input.onblur = () => { if (this.editing === 'title') done(true); };
      row.append(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return row;
    }
    const h = el('h2', 'tp-title', t.title || shortKey(t.key));
    const edit = el('button', 'icon tp-pencil');
    edit.type = 'button';
    edit.innerHTML = PENCIL;
    edit.title = 'Edit the title';
    edit.onclick = () => { this.editing = 'title'; this.renderDetail(t, null); };
    row.append(h, edit);
    return row;
  };

  // A section with a heading that folds it (remembered).
  P.panelSection = function (id, title, body, ...extra) {
    if (!this.folded) { try { this.folded = new Set(JSON.parse(localStorage.getItem('pmPanelFolded') || '[]')); } catch { this.folded = new Set(); } }
    const sec = el('section', 'tp-section' + (this.folded.has(id) ? ' folded' : ''));
    const head = el('div', 'tp-section-head');
    const fold = el('button', 'tp-fold');
    fold.type = 'button';
    fold.innerHTML = CHEVRON;
    fold.append(el('span', null, title));
    fold.onclick = () => {
      if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id);
      try { localStorage.setItem('pmPanelFolded', JSON.stringify([...this.folded])); } catch { /* this run only */ }
      sec.classList.toggle('folded');
    };
    head.append(fold, ...extra);
    sec.append(head, body);
    return sec;
  };

  P.panelDescription = function (t) {
    const body = el('div', 'tp-section-body');
    const edit = el('button', 'icon tp-pencil');
    edit.type = 'button';
    edit.innerHTML = PENCIL;
    edit.title = 'Edit the description';
    if (this.editing === 'description') {
      edit.classList.add('hidden');
      const bar = el('div', 'tp-editbar');
      for (const [cmd, label, title] of [['bold', 'B', 'Bold'], ['italic', 'I', 'Italic'], ['insertUnorderedList', '•', 'List'], ['insertOrderedList', '1.', 'Numbered list']]) {
        const b = el('button', 'tp-editbtn', label);
        b.type = 'button';
        b.title = title;
        b.onmousedown = e => { e.preventDefault(); document.execCommand(cmd); };
        bar.append(b);
      }
      const box = el('div', 'tp-desc tp-desc-edit msg-text');
      box.contentEditable = 'true';
      box.innerHTML = DOMPurify.sanitize(t.description || '', { ADD_ATTR: ['data-media-id', 'data-file-name', 'data-content-type', 'target'] });
      const media = new Map((t.media || []).map(m => [m.id, m]));
      for (const img of box.querySelectorAll('img[data-media-id]')) { const m = media.get(img.dataset.mediaId); if (m?.url) img.src = m.url; }
      const actions = el('div', 'tp-edit-actions');
      const save = el('button', 'gallery-use', 'Save');
      save.type = 'button';
      save.onclick = () => {
        const copy = box.cloneNode(true);
        for (const img of copy.querySelectorAll('img[data-media-id]')) img.removeAttribute('src');   // PM's links expire; PM stores the id
        this.editing = null;
        this.saveFields(t, { description: copy.innerHTML });
      };
      const cancel = el('button', 'gallery-action', 'Cancel');
      cancel.type = 'button';
      cancel.onclick = () => { this.editing = null; this.renderDetail(t, null); };
      box.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.onclick(); } };
      actions.append(save, cancel);
      body.append(bar, box, actions);
      requestAnimationFrame(() => box.focus());
    } else {
      edit.onclick = () => { this.editing = 'description'; this.renderDetail(t, null); };
      if (t.description) body.append(this.description(t));
      else {
        const empty = el('div', 'tp-desc tp-empty', 'Add a description…');
        empty.onclick = edit.onclick;
        body.append(empty);
      }
    }
    return this.panelSection('description', 'Description', body, edit);
  };

  // PM's HTML, cleaned, with its images as PM's short-lived links (videos
  // open in PM).
  P.description = function (t, html = t.description) {
    const div = el('div', 'tp-desc msg-text');
    div.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['data-media-id', 'data-file-name', 'target'] });
    const media = new Map((t.media || []).map(m => [m.id, m]));
    for (const img of div.querySelectorAll('img[data-media-id]')) {
      const m = media.get(img.dataset.mediaId);
      if (m?.url) {
        img.src = m.url;
        img.onclick = () => openImageOverlay(m.url, [...div.querySelectorAll('img')].map(i => i.src));
      } else {
        const a = el('a', 'ticket-media', `🖼 ${img.dataset.fileName || 'Image'} (open in PM)`);
        a.href = pmItemUrl(t.key);
        a.target = '_blank';
        img.replaceWith(a);
      }
    }
    for (const video of div.querySelectorAll('video')) {
      const a = el('a', 'ticket-media', `▶ ${video.dataset.fileName || 'Video'} (open in PM)`);
      a.href = pmItemUrl(t.key);
      a.target = '_blank';
      video.replaceWith(a);
    }
    for (const a of div.querySelectorAll('a[href]')) a.target = '_blank';
    return div;
  };

  P.panelAttachments = function (t) {
    const body = el('div', 'tp-section-body');
    const project = projectOf(t);
    const d = this.panelList('attachLists', t.key, () => window.deck.pmAttachments({ project, id: t.id }));
    if (d.error) body.append(el('div', 'tickets-error', d.error));
    if (d.items?.length) {
      const list = el('div', 'tp-files');
      for (const a of d.items) {
        const b = el('button', 'tp-file');
        b.type = 'button';
        const icon = el('span', 'tp-file-icon');
        icon.innerHTML = FILE;
        b.append(icon, el('span', 'tp-file-name', a.name), el('span', 'tp-file-size', fileSize(a.size)));
        b.title = `Open ${a.name} in the browser`;
        b.onclick = async () => {
          b.classList.add('busy');
          const r = await window.deck.pmOpenAttachment({ project, attachmentId: a.id });
          b.classList.remove('busy');
          if (r?.error) { this.panelError = r.error; this.renderDetail(t, null); }
        };
        list.append(b);
      }
      body.append(list);
    }
    const drop = el('button', 'tp-drop');
    drop.type = 'button';
    const icon = el('span', 'tp-drop-icon');
    icon.innerHTML = UPLOAD;
    drop.append(icon, el('span', null, this.uploading === t.key ? 'Uploading…' : 'Drop files or click to upload'));
    const upload = async paths => {
      if (this.uploading) return;
      this.uploading = t.key;
      this.renderDetail(t, null);
      const r = await window.deck.pmAttach({ project, projectId: t.projectId, id: t.id, paths }).catch(err => ({ error: String(err?.message || err) }));
      this.uploading = null;
      if (Array.isArray(r)) this.attachLists.set(t.key, { items: r });
      else if (r?.error) this.panelError = r.error;
      if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
    };
    drop.onclick = () => upload([]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove('over');
      const paths = [...e.dataTransfer.files].map(f => window.deck.pathForFile?.(f)).filter(Boolean);
      if (paths.length) upload(paths);
    };
    body.append(drop);
    const count = d.items?.length ? el('span', 'tp-count', String(d.items.length)) : '';
    return this.panelSection('attachments', 'Attachments', body, count);
  };

  P.panelSubtasks = function (t) {
    const body = el('div', 'tp-section-body');
    const subs = t.subtasks || [];
    const add = el('button', 'icon tp-add', '+');
    add.type = 'button';
    add.title = 'Add a subtask';
    add.onclick = () => { this.editing = 'subtask'; this.renderDetail(t, null); };
    if (subs.length) {
      const done = subs.filter(s => s.done).length;
      const pct = Math.round(done * 100 / subs.length);
      const bar = el('div', 'tp-progress');
      const track = el('div', 'tp-progress-track');
      const fill = el('div', 'tp-progress-fill');
      fill.style.width = pct + '%';
      track.append(fill);
      bar.append(track, el('span', 'tp-progress-text', `${pct}% Done`));
      body.append(bar);
      const list = el('div', 'tp-subs');
      for (const s of subs) {
        const row = el('div', 'tp-sub' + (s.done ? ' done' : ''));
        const icon = el('span', 'tickets-type-icon');
        icon.innerHTML = SUBTASK_ICON;
        row.append(icon, el('span', 'tp-sub-key', shortKey(s.key)), el('span', 'tp-sub-title', s.title),
          this.statusButton(s), priorityIcon(s.priority), avatar(s.assignee));
        row.title = s.title;
        row.onclick = e => { if (!e.target.closest('button')) this.select({ ...s, type: 'Subtask', parentKey: t.key }); };
        list.append(row);
      }
      body.append(list);
    }
    if (this.editing === 'subtask') {
      const input = document.createElement('input');
      input.className = 'tp-input';
      input.placeholder = 'What needs to be done? (Enter adds it)';
      input.onkeydown = async e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.editing = null; this.renderDetail(t, null); }
        if (e.key !== 'Enter' || !input.value.trim()) return;
        e.preventDefault();
        input.disabled = true;
        const r = await window.deck.pmCreateSubtask({ key: t.key, id: t.id, project: projectOf(t), title: input.value.trim() }).catch(err => ({ error: String(err?.message || err) }));
        if (r?.notConnected) return this.setConnected({ connected: false });
        this.editing = r?.error ? 'subtask' : null;
        this.afterSave(t, r);
        if (!r?.error) { this.editing = 'subtask'; this.renderDetail(this.detailTicket, null); }   // ready for the next one
      };
      body.append(input);
      requestAnimationFrame(() => input.focus());
    } else if (!subs.length) body.append(el('div', 'tp-empty-line', 'No subtasks.'));
    return this.panelSection('subtasks', 'Subtasks', body, add);
  };

  P.panelComments = function (t) {
    const body = el('div', 'tp-section-body');
    const target = { key: t.key, id: t.id, project: projectOf(t), subtask: !!t.subtask };
    const d = this.panelList('commentLists', t.key, () => window.deck.pmComments(target));
    if (d.loading) body.append(el('div', 'tp-empty-line', 'Reading the comments…'));
    if (d.error) body.append(el('div', 'tickets-error', d.error));
    for (const c of (d.items || []).filter(c => !c.deleted)) {
      const row = el('div', 'tp-comment' + (c.parentId ? ' reply' : ''));
      const head = el('div', 'tp-comment-head');
      const when = c.at ? new Date(c.at) : null;
      head.append(avatar(c.author), el('span', 'tp-comment-author', c.author || 'Someone'), el('span', 'tp-comment-time', when ? when.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''));
      row.append(head, this.description(t, c.content));
      body.append(row);
    }
    const write = document.createElement('textarea');
    write.className = 'tp-input tp-comment-input';
    write.placeholder = 'Add a comment…';
    write.rows = 2;
    const send = el('button', 'gallery-use', 'Comment');
    send.type = 'button';
    send.onclick = async () => {
      const text = write.value.trim();
      if (!text) return;
      send.disabled = write.disabled = true;
      const r = await window.deck.pmAddComment({ ...target, content: text, authorName: this.myName() }).catch(err => ({ error: String(err?.message || err) }));
      if (Array.isArray(r)) this.commentLists.set(t.key, { items: r });
      else this.panelError = r?.error || 'PM did not answer.';
      if (this.detailTicket?.key === t.key) this.renderDetail(this.detailTicket, null);
    };
    write.onkeydown = e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send.onclick(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); write.blur(); }
    };
    const box = el('div', 'tp-comment-new');
    box.append(write, send);
    body.append(box);
    const count = d.items?.length ? el('span', 'tp-count', String(d.items.length)) : '';
    return this.panelSection('comments', 'Comments', body, count);
  };

  // ---------- the fields on the right ----------

  P.panelSide = function (t, side) {
    const status = this.statusButton(t);
    status.classList.add('tp-status');
    side.append(status);
    const field = (label, ...kids) => {
      const f = el('div', 'tp-field');
      f.append(el('div', 'tp-label', label), ...kids);
      side.append(f);
      return f;
    };
    const select = (value, choices, onChange, { none = 'None', prefix } = {}) => {
      const wrap = el('div', 'tp-select');
      if (prefix) wrap.append(prefix);
      const s = document.createElement('select');
      if (none !== false) s.append(new Option(none, ''));
      for (const [v, label] of choices) s.append(new Option(label, v));
      s.value = value || '';
      s.onchange = () => onChange(s.value || null);
      wrap.append(s);
      return wrap;
    };
    const text = (value, onSave, { placeholder = '', parse } = {}) => {
      const input = document.createElement('input');
      input.className = 'tp-input';
      input.value = value || '';
      input.placeholder = placeholder;
      const before = input.value;
      input.onchange = () => {
        const v = input.value.trim();
        if (v === before) return;
        const out = parse ? parse(v) : (v || null);
        if (Number.isNaN(out)) { input.classList.add('bad'); input.title = 'Write it like 2h 30m, 45m or 1d'; return; }
        onSave(out);
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = before; input.blur(); }
      };
      return input;
    };
    const people = el('datalist');
    people.id = 'tp-people';
    for (const n of this.people()) people.append(new Option(n));
    side.append(people);
    const person = (value, key) => {
      const wrap = el('div', 'tp-person');
      const input = text(value, v => this.saveFields(t, { [key]: v ?? (t.subtask ? '' : null) }), { placeholder: 'Unassigned' });
      input.setAttribute('list', 'tp-people');
      wrap.append(avatar(value), input);
      return wrap;
    };

    const reporter = el('div', 'tp-static');
    reporter.append(...(t.author ? [avatar(t.author), el('span', null, t.author)] : [el('span', 'tp-faint', '—')]));
    field('Reporter', reporter);
    const me = el('button', 'tp-link', 'Assign to me');
    me.type = 'button';
    me.onclick = () => this.saveFields(t, { assignee: this.email || this.myName() });
    field('Assignee', person(t.assignee, 'assignee'), me);
    field('Assignee 2', person(t.assignee2, 'assignee2'));

    const o = this.panelOptions(projectOf(t));
    if (!t.subtask) {
      if (!o) side.append(el('div', 'tp-faint tp-loading', 'Reading the project\'s fields…'));
      else {
        const epics = (o.epics || []).filter(e => !e.done || e.id === t.epicId).map(e => [e.id, e.name]);
        if (t.epicId && !epics.some(e => e[0] === t.epicId)) epics.unshift([t.epicId, t.epicName || t.epic || 'Epic']);
        const epicColor = (o.epics || []).find(e => e.id === t.epicId)?.color;
        const dot = el('span', 'tp-dot');
        if (epicColor) dot.style.background = epicColor;
        field('Epic', select(t.epicId, epics, v => this.saveFields(t, { epicId: v }), { prefix: dot }));
        const sprints = (o.sprints || []).map(x => [x.id, x.name + (x.status === 'ACTIVE' ? ' (Active)' : '')]);
        if (t.sprintId && !sprints.some(x => x[0] === t.sprintId)) sprints.unshift([t.sprintId, t.sprint || 'Sprint']);
        field('Sprint', select(t.sprintId, sprints, v => this.saveFields(t, { sprintId: v }), { none: 'Backlog' }));
        field('Components', this.componentsPicker(t, o.components || []));
      }
    }
    field('Estimate', text(minutesText(t.estimate), v => this.saveFields(t, { estimate: v }), { placeholder: 'e.g. 2h 30m', parse: parseMinutes }));
    field('Priority', select(t.priority, PRIORITIES.map(p => [p, p]), v => this.saveFields(t, { priority: v }), { prefix: priorityIcon(t.priority) }));
    const points = el('div', 'tp-points');
    for (const n of POINTS) {
      const b = el('button', 'tp-point' + (t.storyPoints === n ? ' on' : ''), String(n));
      b.type = 'button';
      b.title = t.storyPoints === n ? 'Clear the story points' : `${n} story points`;
      b.onclick = () => this.saveFields(t, { storyPoints: t.storyPoints === n ? null : n });
      points.append(b);
    }
    field('Story Points', points);
    if (!t.subtask && o) {
      const teams = (o.teams || []).map(x => [x.id, x.name]);
      field('Team', select(t.teamId, teams, v => this.saveFields(t, { team: v })));
      for (const f of (o.fields || []).filter(f => f.types.includes(t.typeId))) {
        const value = t.customFields?.[f.id] ?? t.customFields?.[f.name] ?? '';
        const save = v => this.saveFields(t, { customFields: { [f.name]: v } });
        if ((f.type === 'select' || f.type === 'multiSelect') && f.values.length) {
          const choices = f.values.map(v => (typeof v === 'string' ? [v, v] : [v.value ?? v.label, v.label ?? v.value]));
          field(f.name, select(Array.isArray(value) ? value[0] : value, choices, save));
        } else field(f.name, text(Array.isArray(value) ? value.join(', ') : String(value), save));
      }
    }
    if (t.watchers) side.append(el('div', 'tp-faint tp-watchers', `${t.watchers} watching`));
  };

  // Components: a list to tick in a menu (a ticket can have several).
  P.componentsPicker = function (t, components) {
    const names = new Map(components.map(c => [c.id, c.name]));
    const chosen = t.componentIds || [];
    const b = el('button', 'tp-select tp-select-button', chosen.map(id => names.get(id) || 'Component').join(', ') || 'None');
    b.type = 'button';
    if (!components.length) { b.disabled = true; b.title = 'This project has no components.'; return b; }
    b.onclick = () => this.openMenu(b, 'components:' + t.key, menu => {
      menu.replaceChildren();
      const pick = new Set(chosen);
      for (const c of components) {
        const item = el('button', 'tickets-status-item' + (pick.has(c.id) ? ' on' : ''), c.name);
        item.type = 'button';
        item.onclick = () => {
          if (pick.has(c.id)) pick.delete(c.id); else pick.add(c.id);
          item.classList.toggle('on');
        };
        menu.append(item);
      }
      const save = el('button', 'gallery-use tp-menu-save', 'Save');
      save.type = 'button';
      save.onclick = () => { this.closeStatusMenu(); this.saveFields(t, { componentIds: [...pick] }); };
      menu.append(save);
    });
    return b;
  };
})();
