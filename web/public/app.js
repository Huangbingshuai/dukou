/* 渡口 · Dukou
   Codex-style shell: pick a tool, walk its project tree, read the conversation
   on the right, and send it to another tool from the transcript header. */

import { BRANDS } from './brands.js';

const ICONS = {
  ...BRANDS,
  fallback:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/></svg>',
};

const FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.5 7.5h6l2 2.2h9v8.3a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18z"/></svg>';
const CHEV =
  '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

const state = {
  harnesses: [],
  conversations: [],
  projects: [],
  active: null,
  // Remembered as the replica (origin + native id), because joining a mirror group
  // changes a conversation's key but never the replica id.
  selected: null,
  projectView: null,
  query: '',
  expanded: new Set(),
  expandedFor: null,
  autoOpened: false,
  doneAt: new Map(),
  busy: new Map(),
  // conversation key -> per-target plan ({ origin, replica, missing, total })
  plan: new Map(),
};

const el = {
  toolSwitch: document.querySelector('#tool-switch'),
  toolMark: document.querySelector('#tool-mark'),
  toolLabel: document.querySelector('#tool-label'),
  toolMenu: document.querySelector('#tool-menu'),
  refresh: document.querySelector('#refresh'),
  search: document.querySelector('#search'),
  tree: document.querySelector('#tree'),
  foot: document.querySelector('#foot-summary'),
  pane: document.querySelector('#pane'),
  welcome: document.querySelector('#welcome'),
  thread: document.querySelector('#thread'),
  threadTitle: document.querySelector('#thread-title'),
  threadMeta: document.querySelector('#thread-meta'),
  threadProject: document.querySelector('#thread-project'),
  threadTools: document.querySelector('#thread-tools'),
  transcript: document.querySelector('#transcript'),
  toast: document.querySelector('#toast'),
};

// A missing node used to fail silently at the first render; say it out loud once.
for (const [name, node] of Object.entries(el)) {
  if (!node) console.error(`缺少 DOM 节点: ${name}`);
}

/* ---------- helpers ---------- */

function icon(id) {
  const holder = document.createElement('span');
  holder.innerHTML = ICONS[id] ?? ICONS.fallback;
  return holder.firstElementChild;
}

let toastTimer;

function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('bad', bad);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 5000);
}

function relative(ms) {
  const delta = Date.now() - ms;
  if (delta < 90_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** Thread titles in these stores can carry newlines and pasted markdown. */
function oneLine(text, limit = 0) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return limit && flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function shortPath(cwd) {
  const text = String(cwd || '');
  if (!text) return '';
  const home = text.match(/^\/Users\/[^/]+/) ?? text.match(/^\/home\/[^/]+/);
  const rest = home ? text.slice(home[0].length) : text;
  const parts = rest.split('/').filter(Boolean);
  return parts.length ? `~/${parts.slice(-2).join('/')}` : '~';
}

function harnessOf(id) {
  return state.harnesses.find((entry) => entry.id === id);
}

function library() {
  return state.conversations.filter((conversation) => conversation.replicas[state.active]);
}

/**
 * The tool's own projects, in the tool's own order, each holding its chats.
 * Chats the tool never filed under a project fall into a trailing group.
 */
function projects() {
  const byProject = new Map();
  const unfiled = [];
  for (const conversation of library()) {
    const id = conversation.projects?.[state.active];
    if (!id) {
      unfiled.push(conversation);
      continue;
    }
    const entry = byProject.get(id) ?? { id, chats: [] };
    entry.chats.push(conversation);
    byProject.set(id, entry);
  }

  // A tool without a project registry (Claude Code) still groups by directory;
  // fall back to the conversations' own project ids, sorted for stability.
  const known = state.projects.length > 0 ? state.projects : [...byProject.keys()].map((id) => ({
    id,
    name: id.split('/').filter(Boolean).slice(-1)[0] || id,
    path: id,
  })).sort((a, b) => a.name.localeCompare(b.name));

  const out = known.map((project) => ({
    key: project.id,
    name: project.name,
    cwd: project.path,
    chats: (byProject.get(project.id)?.chats ?? []).sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
  }));

  // A project id the tool no longer lists must not hide its chats: fold them in
  // with the unfiled ones instead of dropping them from the tree.
  if (state.projects.length > 0) {
    const knownIds = new Set(known.map((project) => project.id));
    for (const [id, entry] of byProject) {
      if (!knownIds.has(id)) unfiled.push(...entry.chats);
    }
  }

  if (unfiled.length > 0) {
    out.push({
      key: '__unfiled__',
      name: '未归类',
      cwd: '',
      chats: unfiled.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
    });
  }
  return out;
}

function selectedConversation() {
  if (!state.selected) return undefined;
  const { origin, id } = state.selected;
  return state.conversations.find((conversation) => conversation.replicas[origin]?.id === id);
}

function isSelected(conversation) {
  if (!state.selected) return false;
  const replica = conversation.replicas[state.selected.origin];
  return replica?.id === state.selected.id;
}

/* ---------- sidebar ---------- */

function renderToolSwitch() {
  const entry = harnessOf(state.active);
  if (!entry) return;
  el.toolMark.replaceChildren(icon(entry.id));
  el.toolMark.style.setProperty('--tone', entry.color);
  el.toolLabel.textContent = entry.label;

  el.toolMenu.replaceChildren();
  for (const candidate of state.harnesses) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.style.setProperty('--tone', candidate.color);
    mark.append(icon(candidate.id));
    button.append(mark, Object.assign(document.createElement('span'), { textContent: candidate.label }));
    button.append(
      Object.assign(document.createElement('span'), {
        className: 'count',
        textContent: String(state.conversations.filter((conversation) => conversation.replicas[candidate.id]).length),
      }),
    );
    button.addEventListener('click', () => {
      closeMenu();
      state.active = candidate.id;
      state.selected = null;
      state.projectView = null;
      state.expanded = new Set();
      state.expandedFor = null;
      state.autoOpened = false;
      hideThread();
      void load();
    });
    el.toolMenu.append(button);
  }
}

function openMenu() {
  el.toolMenu.hidden = false;
  el.toolSwitch.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  el.toolMenu.hidden = true;
  el.toolSwitch.setAttribute('aria-expanded', 'false');
}

function chatRow(conversation, depth = 0) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'chat-row';
  row.setAttribute('aria-current', String(isSelected(conversation)));
  row.style.paddingLeft = depth ? undefined : '29px';

  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = oneLine(conversation.title, 120) || '(无标题)';
  name.title = conversation.title || '';

  const tip = document.createElement('span');
  tip.className = 'tip';
  tip.textContent = relative(conversation.updatedAt);

  row.append(name, tip);
  row.addEventListener('click', () => select(conversation));
  return row;
}

function renderTree() {
  const query = state.query.trim().toLowerCase();
  const all = projects();

  // One place decides the initial expansion. Keys come from the rendered rows, so a
  // tool with no project registry (Claude Code groups by folder) expands too. The
  // key includes those ids so a render holding the previous tool's list cannot mark
  // the new tool as initialised; collapsing by hand keeps the key and survives
  // refreshes.
  const expansionKey = `${state.active}|${all.map((project) => project.key).join(',')}`;
  if (state.expandedFor !== expansionKey && all.length > 0) {
    state.expanded = new Set(all.map((project) => project.key));
    state.expanded.add('__unfiled__');
    state.expandedFor = expansionKey;
  }

  const matches = (conversation) =>
    !query || `${conversation.title} ${conversation.project} ${conversation.cwd}`.toLowerCase().includes(query);

  el.tree.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'section';
  heading.innerHTML = `${CHEV}<span>项目</span>`;
  el.tree.append(heading);

  let shown = 0;
  for (const project of all) {
    const chats = project.chats.filter(matches);
    if (query && chats.length === 0) continue;
    // A project the app lists but this machine has no threads for is still shown:
    // hiding it reads as "the project is missing" rather than "the chats are not
    // stored locally".
    shown += 1;

    const hasChats = chats.length > 0;
    const expanded = hasChats && (query || state.expanded.has(project.key));

    const row = document.createElement('div');
    row.className = `project-row${hasChats ? '' : ' empty'}${state.projectView === project.key ? ' selected' : ''}`;
    row.title = project.cwd || project.name;

    // The chevron owns expansion; the row itself opens the project on the right.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'project-toggle';
    toggle.setAttribute('aria-label', expanded ? '收起项目' : '展开项目');
    toggle.setAttribute('aria-expanded', String(expanded));
    if (hasChats) {
      toggle.innerHTML = CHEV;
      toggle.style.transform = expanded ? 'rotate(90deg)' : 'none';
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.expanded.has(project.key)) state.expanded.delete(project.key);
        else state.expanded.add(project.key);
        renderTree();
      });
    } else {
      toggle.disabled = true;
    }

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'project-main';
    main.append(Object.assign(document.createElement('span'), { className: 'folder', innerHTML: FOLDER }));
    main.append(Object.assign(document.createElement('span'), { className: 'project-name', textContent: project.name }));
    const count = Object.assign(document.createElement('span'), {
      className: `project-count${project.chats.length === 0 ? ' zero' : ''}`,
      textContent: String(project.chats.length),
    });
    if (project.chats.length === 0) count.title = '本机没有这段项目下的对话记录（Codex 客户端里可能来自云端）';
    main.append(count);
    main.addEventListener('click', () => showProject(project));

    row.append(toggle, main);
    el.tree.append(row);

    if (!expanded || chats.length === 0) continue;
    // Every chat under an expanded project is listed; the tree scrolls, and a
    // "more" fold would make a project look like it is missing conversations.
    for (const conversation of chats) el.tree.append(chatRow(conversation));
  }

  if (query && shown === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.style.padding = '18px 10px';
    none.style.color = 'var(--muted)';
    none.textContent = '没有匹配的对话。';
    el.tree.append(none);
  }

}

/* ---------- transcript ---------- */

/** Right pane for a project itself: what it is, and what it holds. */
function showProject(project) {
  state.projectView = project.key;
  state.selected = null;
  renderTree();
  el.welcome.hidden = true;
  el.thread.hidden = false;
  el.threadTitle.textContent = project.name;
  el.threadMeta.textContent = [shortPath(project.cwd), `${project.chats.length} 段对话`].filter(Boolean).join('  ·  ');
  el.threadProject.replaceChildren();

  el.threadTools.replaceChildren();
  el.transcript.replaceChildren();

  const intro = document.createElement('p');
  intro.className = 'text-block';
  intro.textContent = project.cwd || '';
  el.transcript.append(intro);

  if (project.chats.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-block';
    empty.textContent =
      '这个项目下本机没有任何对话记录。\n\nCodex 客户端里如果还能看到对话，那是它从云端同步来的——本机 ~/.codex 里没有对应的线程文件，所以这里既读不到内容，也没法迁移。';
    el.transcript.append(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'project-chats';
  for (const conversation of project.chats) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'project-chat';
    row.append(Object.assign(document.createElement('span'), { textContent: conversation.title || '(无标题)' }));
    row.append(Object.assign(document.createElement('em'), { textContent: relative(conversation.updatedAt) }));
    row.addEventListener('click', () => select(conversation));
    list.append(row);
  }
  el.transcript.append(list);
}

function hideThread() {
  el.thread.hidden = true;
  el.welcome.hidden = false;
}

function renderThread(conversation) {
  el.welcome.hidden = true;
  el.thread.hidden = false;
  el.threadTitle.textContent = oneLine(conversation.title) || '(无标题)';
  el.threadTitle.title = conversation.title || '';

  const entry = harnessOf(state.active);
  el.threadMeta.textContent = [
    entry?.label ?? '',
    shortPath(conversation.cwd),
    relative(conversation.updatedAt),
  ]
    .filter(Boolean)
    .join('  ·  ');
  el.threadProject.replaceChildren(buildAssignControl(conversation));

  el.threadTools.replaceChildren();

  const others = state.harnesses.filter((candidate) => candidate.id !== state.active && candidate.canWrite);
  // Nothing to send when the conversation is already everywhere — but saying so
  // inside the menu is clearer than a button that silently disappears.
  if (others.length === 0) return;

  // One compact control: with more tools the header must not grow a row of buttons.
  const wrap = document.createElement('div');
  wrap.className = 'send-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'send-trigger';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.append(Object.assign(document.createElement('span'), { textContent: '发送到' }));
  button.insertAdjacentHTML(
    'beforeend',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

  const menu = document.createElement('div');
  menu.className = 'send-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  // Render whatever the plan already knows; fetch it once per selection so the
  // menu can say "缺 3 条" instead of a vague "已有".
  const renderMenu = (plan) => {
    menu.replaceChildren();
    const total = plan?.[0]?.total;
    if (typeof total === 'number') {
      menu.append(
        Object.assign(document.createElement('div'), {
          className: 'send-menu-note',
          textContent: `共 ${total} 条消息`,
        }),
      );
    }
    for (const candidate of others) {
      const status = plan?.find((entry) => entry.origin === candidate.id);
      const replica = conversation.replicas[candidate.id];
      if (!replica) {
        menu.append(sendMenuItem(conversation, candidate, status ? `${status.missing} 条` : ''));
      } else if (status && status.missing === 0) {
        menu.append(upToDateItem(candidate, status.total));
      } else {
        menu.append(
          existingItem(conversation, candidate, status ? `缺 ${status.missing} 条` : '检查中…'),
        );
      }
    }
    // Two or more tools behind → one action instead of two round trips.
    const behind = (plan ?? []).filter((entry) => entry.missing > 0 && state.harnesses.find((h) => h.id === entry.origin)?.canWrite);
    if (behind.length > 1) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'send-menu-action';
      action.textContent = `全部同步 · ${behind.length} 个工具`;
      action.addEventListener('click', (event) => {
        event.stopPropagation();
        void syncAll(conversation, behind, action);
      });
      menu.append(action);
    }
  };
  state.refreshSendMenu = renderMenu;
  renderMenu(state.plan.get(conversation.key));
  if (!state.plan.has(conversation.key)) {
    void loadPlan(conversation).then((plan) => {
      if (plan) renderMenu(plan);
    });
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', () => {
    if (!menu.hidden) {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      state.refreshSendMenu = null;
      if (state.needsReload) {
        state.needsReload = false;
        void load();
      }
    }
  });

  wrap.append(button, menu);
  el.threadTools.append(wrap);
}

/** Lets the reader move a conversation into a project when the store has no link. */
function buildAssignControl(conversation) {
  const wrap = document.createElement('span');
  wrap.className = 'assign-wrap';

  const currentId = conversation.projects?.[state.active];
  const current = state.projects.find((project) => project.id === currentId);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'assign';
  trigger.textContent = `项目：${current?.name ?? '未归类'}`;
  trigger.title = '把这段对话归到某个项目';
  trigger.setAttribute('aria-haspopup', 'menu');

  const menu = document.createElement('div');
  menu.className = 'assign-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const options = [{ id: null, name: '未归类' }, ...state.projects];
  for (const option of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `assign-item${option.id === currentId ? ' current' : ''}`;
    item.textContent = option.name;
    item.addEventListener('click', async (event) => {
      event.stopPropagation();
      menu.hidden = true;
      try {
        const response = await fetch('/api/assign', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            origin: state.active,
            id: conversation.replicas[state.active].id,
            projectId: option.id,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        toast(`已归到「${option.name}」`);
        await load();
      } catch (error) {
        toast(`没有完成：${error.message}`, true);
      }
    });
    menu.append(item);
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => {
    menu.hidden = true;
  });

  wrap.append(trigger, menu);
  return wrap;
}

/**
 * A tool that already holds this conversation. The copy keeps growing while the
 * conversation goes on, so this stays actionable: pressing it appends whatever
 * the target is still missing.
 */
function existingItem(conversation, candidate, hintText = '') {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'send-item existing';
  item.setAttribute('role', 'menuitem');
  const mark = icon(candidate.id);
  const label = Object.assign(document.createElement('span'), { textContent: `同步到 ${candidate.label}` });
  const hint = Object.assign(document.createElement('em'), { textContent: hintText });
  item.append(mark, label, hint);
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    void sendTo(conversation, candidate, item, label, hint);
  });
  return item;
}

/** Already identical everywhere: show it, but nothing to press. */
function upToDateItem(candidate, total) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'send-item up-to-date';
  item.disabled = true;
  item.setAttribute('role', 'menuitem');
  item.append(
    icon(candidate.id),
    Object.assign(document.createElement('span'), { textContent: `${candidate.label} 已最新` }),
    Object.assign(document.createElement('em'), { textContent: `${total} 条一致` }),
  );
  return item;
}

/** One row per missing tool, with its own clock while the copy is being written. */
function sendMenuItem(conversation, candidate, hintText = '') {  const key = `${conversation.key}:${candidate.id}`;
  const phase = state.busy.get(key);

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'send-item';
  item.setAttribute('role', 'menuitem');
  const mark = icon(candidate.id);
  const label = Object.assign(document.createElement('span'), { textContent: `发送到 ${candidate.label}` });
  const timer = Object.assign(document.createElement('em'), {
    textContent: phase === 'done' ? (state.doneAt.get(key) ?? '') : hintText,
  });
  item.append(mark, label, timer);

  if (phase === 'done') {
    item.classList.add('done');
    label.textContent = `已发送到 ${candidate.label}`;
    item.disabled = true;
    return item;
  }
  if (phase === 'busy') {
    item.classList.add('busy');
    item.disabled = true;
    label.textContent = '发送中';
    return item;
  }

  item.addEventListener('click', (event) => {
    event.stopPropagation();
    void sendTo(conversation, candidate, item, label, timer);
  });
  return item;
}

/**
 * Loads the whole transcript in one request, like the Codex app: no pagination and
 * no "load more" — the conversation is simply there and the pane scrolls.
 */
async function loadTranscript(conversation) {
  const replicaId = conversation.replicas[state.active].id;
  state.transcript = { origin: state.active, id: replicaId, lines: [], total: 0, conversationKey: conversation.key };
  el.transcript.replaceChildren(Object.assign(document.createElement('p'), { className: 'thread-meta', textContent: '读取中…' }));
  await fetchAll();
}

async function fetchAll() {
  const transcriptState = state.transcript;
  if (!transcriptState) return;
  try {
    const response = await fetch('/api/transcript', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: transcriptState.origin, id: transcriptState.id, all: true }),
    });
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    transcriptState.lines = payload.lines ?? [];
    transcriptState.total = payload.total ?? transcriptState.lines.length;
    renderTranscript({ keepAnchor: true });
  } catch (error) {
    // The row outlived its session (filtered or deleted): resync instead of
    // leaving a dead entry that fails every time it is clicked.
    if (/not found/i.test(String(error.message))) {
      toast('这段对话已经不在了，已重新扫描', true);
      state.selected = null;
      hideThread();
      await load();
      return;
    }
    toast(`读取失败：${error.message}`, true);
  }
}

/**
 * Renders whatever is loaded. Tool calls, outputs and reasoning are folded into a
 * single activity line per gap so the page reads as a conversation.
 */
function renderTranscript({ keepAnchor = false } = {}) {
  const transcriptState = state.transcript;
  if (!transcriptState) return;
  const scroller = el.pane;
  const before = keepAnchor
    ? { top: scroller.scrollTop, height: scroller.scrollHeight }
    : null;

  el.transcript.replaceChildren();

  if (transcriptState.lines.length === 0) {
    el.transcript.append(Object.assign(document.createElement('p'), { className: 'thread-meta', textContent: '这段对话没有任何内容。' }));
    return;
  }

  let activity = [];
  const flushActivity = () => {
    if (activity.length === 0) return;
    const tools = activity.filter((item) => item.kind === 'tool').length;
    const thoughts = activity.length - tools;
    const details = document.createElement('details');
    details.className = 'activity-fold';
    const summary = document.createElement('summary');
    const parts = [];
    if (tools > 0) parts.push(`${tools} 个操作`);
    if (thoughts > 0) parts.push(`${thoughts} 段思考`);
    const lead =
      activity.find((item) => item.kind === 'tool' && item.role !== 'tool') ??
      activity.find((item) => item.kind === 'tool');
    summary.textContent = parts.join(' · ');
    if (lead) summary.title = lead.text.replace(/\s+/g, ' ').slice(0, 160);
    const body = document.createElement('div');
    body.className = 'activity-body';
    for (const item of activity) {
      if (item.kind === 'reasoning') {
        body.append(Object.assign(document.createElement('div'), { className: 'reasoning', textContent: item.text }));
        continue;
      }
      const row = document.createElement('div');
      row.className = 'tool';
      row.append(Object.assign(document.createElement('b'), { textContent: item.role === 'tool' ? '结果' : '调用' }));
      row.append(Object.assign(document.createElement('span'), { className: 'tool-text', textContent: item.text }));
      body.append(row);
    }
    details.append(summary, body);
    el.transcript.append(details);
    activity = [];
  };

  for (const line of transcriptState.lines) {
    if (line.kind === 'image') {
      flushActivity();
      const figure = document.createElement('figure');
      figure.className = 'msg-image';
      const image = document.createElement('img');
      image.src = line.src;
      image.alt = line.mime ?? '图片';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('click', () => window.open(line.src, '_blank'));
      image.title = '点击查看原图';
      figure.append(image);
      el.transcript.append(figure);
      continue;
    }
    if (line.kind === 'text') {
      flushActivity();
      if (line.role === 'user') {
        const turn = document.createElement('div');
        turn.className = 'turn user';
        turn.append(Object.assign(document.createElement('div'), { className: 'bubble', textContent: line.text }));
        el.transcript.append(turn);
      } else {
        el.transcript.append(Object.assign(document.createElement('div'), { className: 'text-block', textContent: line.text }));
      }
      continue;
    }
    activity.push(line);
  }
  flushActivity();

  if (before) {
    scroller.scrollTop = before.top + (scroller.scrollHeight - before.height);
  }
}

function select(conversation) {
  state.projectView = null;
  state.selected = { origin: state.active, id: conversation.replicas[state.active].id };
  renderTree();
  renderThread(conversation);
  void loadTranscript(conversation);
}

/* ---------- actions ---------- */

/**
 * Copies whatever is missing to every tool that is behind, one after another.
 * Each write is the same idempotent append the single buttons use.
 */
async function syncAll(conversation, targets, action) {
  const sourceId = conversation.replicas[state.active]?.id;
  if (!sourceId) return;
  action.disabled = true;
  let appended = 0;
  let done = 0;
  for (const target of targets) {
    action.textContent = `同步中 ${done + 1}/${targets.length} · ${target.label}`;
    try {
      const response = await fetch('/api/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceOrigin: state.active, sourceId, target: target.origin }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      appended += payload.missing ?? 0;
    } catch (error) {
      toast(`同步到 ${target.label} 没有完成：${error.message}`, true);
    }
    done += 1;
  }
  action.textContent = `已补齐 ${appended} 条`;
  toast(
    appended > 0
      ? `已补齐 ${appended} 条，涉及 ${targets.length} 个工具`
      : '这些工具本来就已经是最新的',
  );
  const plan = state.plan.get(conversation.key);
  for (const target of targets) {
    const row = plan?.find((entry) => entry.origin === target.origin);
    if (row) {
      row.missing = 0;
      row.replica = true;
    }
  }
  state.needsReload = true;
  state.refreshSendMenu?.();
}

async function sendTo(conversation, target, item, label, timer) {
  const key = `${conversation.key}:${target.id}`;
  const started = Date.now();
  state.busy.set(key, 'busy');
  item.classList.add('busy');
  item.disabled = true;
  label.textContent = '发送中';
  const tick = setInterval(() => {
    timer.textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  }, 100);

  try {
    const response = await fetch('/api/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceOrigin: state.active,
        sourceId: conversation.replicas[state.active].id,
        target: target.id,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    clearInterval(tick);
    state.busy.set(key, 'done');
    state.doneAt.set(key, `${elapsed}s`);
    item.classList.remove('busy');
    item.classList.add('done');
    label.textContent = conversation.replicas[target.id]
      ? `已同步 ${target.label}`
      : `已发送到 ${target.label}`;
    timer.textContent = `${elapsed}s`;
    toast(
      payload.action === 'skip'
        ? `${target.label} 里已经有了 · ${elapsed}s`
        : `已${payload.action === 'create' ? '复制' : '补齐'} ${payload.messages} 条到 ${target.label} · ${elapsed}s`,
    );
    if (payload.sessionId) conversation.replicas[target.id] ??= { id: payload.sessionId, archived: false };
    const plan = state.plan.get(conversation.key);
    const row = plan?.find((entry) => entry.origin === target.id);
    if (row) {
      row.missing = 0;
      row.replica = true;
    }
    state.needsReload = true;
    state.refreshSendMenu?.();
  } catch (error) {
    clearInterval(tick);
    state.busy.delete(key);
    item.classList.remove('busy');
    item.disabled = false;
    label.textContent = `重试 ${target.label}`;
    timer.textContent = '失败';
    toast(`没有完成：${error.message}`, true);
  }
}

async function loadPlan(conversation) {
  const replica = conversation.replicas[state.active];
  if (!replica) return null;
  try {
    const response = await fetch(
      `/api/plan?origin=${encodeURIComponent(state.active)}&id=${encodeURIComponent(replica.id)}`,
    );
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    state.plan.set(conversation.key, payload.targets ?? []);
    return payload.targets ?? [];
  } catch {
    return null;
  }
}

/* ---------- data ---------- */

async function loadProjects() {
  if (!state.active) {
    state.projects = [];
    return;
  }
  try {
    const response = await fetch(`/api/projects?harness=${encodeURIComponent(state.active)}`);
    const payload = await response.json();
    state.projects = payload.projects ?? [];
  } catch {
    state.projects = [];
  }
}

let lastLoadAt = 0;
let loading = false;

async function load() {
  // Two overlapping loads (startup + a focus/SSE wakeup) used to race and leave
  // the tree half-rendered; one at a time is both cheaper and steadier.
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/conversations');
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    state.harnesses = payload.harnesses ?? [];
    state.conversations = payload.conversations ?? [];
    state.plan.clear();
    lastLoadAt = Date.now();

    // A conversation that was filtered out (an empty shell, an archived thread)
    // must not stay on screen with its old transcript.
    if (state.selected) {
      const id = state.selected.id;
      const origin = state.selected.origin;
      const still = state.conversations.some((conversation) => conversation.replicas[origin]?.id === id);
      if (!still) {
        state.selected = null;
        state.projectView = null;
        hideThread();
      }
    }

    if (!state.active || !state.harnesses.some((entry) => entry.id === state.active)) {
      // Start on Codex when it exists: it is the tool most conversations live in,
      // and a stable starting point beats "whichever list is longest today".
      const preferred = state.harnesses.find((entry) => entry.id === 'codex');
      const busiest = [...state.harnesses].sort(
        (a, b) =>
          state.conversations.filter((c) => c.replicas[b.id]).length -
          state.conversations.filter((c) => c.replicas[a.id]).length,
      )[0];
      state.active = preferred?.id ?? busiest?.id ?? null;
    }

    await loadProjects();

    // Every conversation is visible without clicking: all projects start expanded.
    // Collapsing one is a per-tool choice the reader makes afterwards.
    // Land on content instead of an empty pane: open the newest conversation once.
    if (!state.autoOpened && !state.selected && !state.projectView) {
      const newest = [...library()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))[0];
      if (newest) {
        select(newest);
        state.autoOpened = true;
      }
    }

    el.foot.textContent = `${state.conversations.length} 段对话 · ${state.harnesses.length} 个工具`;
    render();
    if (state.selected) {
      const conversation = selectedConversation();
      if (conversation) renderThread(conversation);
      // A conversation that vanished from the store keeps its last transcript on
      // screen; only an explicit tool switch clears the pane.
    }
  } catch (error) {
    el.foot.textContent = `读取失败：${error.message}`;
  } finally {
    loading = false;
  }
}

function render() {
  renderToolSwitch();
  renderTree();
  if (!state.selected && !state.projectView) hideThread();
}

/* ---------- wiring ---------- */

el.toolSwitch.addEventListener('click', (event) => {
  event.stopPropagation();
  if (el.toolMenu.hidden) openMenu();
  else closeMenu();
});

document.addEventListener('click', (event) => {
  if (!el.toolMenu.hidden && !el.toolMenu.contains(event.target)) closeMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
  if (event.key === '/' && document.activeElement !== el.search) {
    event.preventDefault();
    el.search.focus();
  }
  const index = Number(event.key);
  if (index >= 1 && index <= state.harnesses.length && document.activeElement !== el.search) {
    state.active = state.harnesses[index - 1].id;
    state.selected = null;
    state.projectView = null;
    state.expanded = new Set();
    state.expandedFor = null;
    hideThread();
    render();
  }
});

el.search.addEventListener('input', () => {
  state.query = el.search.value;
  renderTree();
});

el.refresh.addEventListener('click', () => void load());

// A tab left open for hours keeps its old list; a quiet re-sync when it becomes
// visible again fixes that. Startup visibility churn is ignored on purpose.
let wasHidden = document.visibilityState === 'hidden';
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    wasHidden = true;
    return;
  }
  if (wasHidden && Date.now() - lastLoadAt > 30_000) {
    wasHidden = false;
    void load();
  }
});

function listen() {
  const stream = new EventSource('/api/stream');
  let dropped = false;
  // A restarted server leaves the page holding the previous list: rows that no
  // longer exist stay clickable until the next manual refresh. Re-sync on
  // reconnect so a restart (and its filters) shows up by itself.
  stream.addEventListener('open', () => {
    if (dropped) {
      dropped = false;
      void load();
    }
  });
  stream.addEventListener('error', () => {
    dropped = true;
  });
  stream.addEventListener('synced', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.changed > 0) toast(`已自动补齐 ${payload.changed} 个副本`);
    void load();
  });
  stream.addEventListener('migrated', () => void load());
}

void load();
listen();
