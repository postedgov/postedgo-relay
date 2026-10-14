'use strict';

const $ = (id) => document.getElementById(id);
const statusNames = { queued: 'Queued', running: 'Working', needs_input: 'Needs your input', handoff: 'Manual handoff', awaiting_review: 'Ready to verify', completed: 'Verified', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
const agentCopy = {
  codex: ['⌘', 'Codex', 'Build, debug, and implement.', 'Your existing Codex account'],
  kimi: ['K', 'Kimi', 'Think through the next move.', 'Your existing agent setup'],
  hermes: ['H', 'Hermes', 'Bring your tools and memory.', 'Your existing agent setup'],
  grok: ['𝕏', 'Grok Bot', 'An outside view, in the loop.', 'Your existing Grok Bot'],
};
let state = { projects: [], tasks: [], agents: [], paused: false };
let selectedProject = null;
let selectedTask = null;
let detail = null;
let stateFingerprint = '';
let detailFingerprint = '';
let approvalFingerprint = '';
let projectsFingerprint = '';
let tasksFingerprint = '';
let actionsFingerprint = '';
let polling = false;
let toastTimer;
let token = '';
let currentView = 'chat';
let chatFingerprint = '';
let chatRequestVersion = 0;
let renderedRoom = null;
let participantsFingerprint = '';
let chatSending = false;
const roomDrafts = new Map();
const messageNodes = new Map();

try {
  token = new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('relay-token') || '';
  if (token) localStorage.setItem('relay-token', token);
} catch { token = new URLSearchParams(location.hash.slice(1)).get('token') || ''; }
if (location.hash.includes('token=')) history.replaceState(null, '', location.pathname + location.search);

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(label, className, action) {
  const result = node('button', `button ${className}`, label);
  result.type = 'button';
  result.addEventListener('click', () => runAction(result, action));
  return result;
}
function notify(message, error = false) {
  const container = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
  if ($('toast').parentElement !== container) container.append($('toast'));
  $('toast').setAttribute('role', error ? 'alert' : 'status');
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
}
function requireAccess(message) {
  $('access-message').textContent = message;
  $('access').hidden = false;
  $('app').hidden = true;
}
async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Relay-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) requireAccess('This connection link has expired or is missing. Reopen Relay using its launcher.');
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}
async function runAction(control, action, errorId) {
  if (control.disabled) return;
  control.disabled = true;
  if (errorId) $(errorId).hidden = true;
  try { await action(); }
  catch (error) {
    if (errorId) { $(errorId).textContent = error.message; $(errorId).hidden = false; }
    else notify(error.message, true);
  } finally { control.disabled = false; }
}
function projectById(id) { return state.projects.find((project) => project.id === id); }
function agentName(id) { return state.agents.find((agent) => agent.id === id)?.name || agentCopy[id]?.[1] || id; }
function statusBadge(status, label) { return node('span', `status ${status}`, label || statusNames[status] || status); }
function isDiscussion(task) { return Boolean(task.chatMessageId) && task.intent === 'review'; }
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function roomName(project) { return project?.name === 'Playground' ? 'Team room' : project?.name || 'Team room'; }
function saveDraft() {
  if (selectedProject) roomDrafts.set(selectedProject, { text: $('chat-input').value, recipient: $('chat-recipient').value, intent: $('chat-intent').value });
}
function selectProject(id, view = 'chat') {
  saveDraft();
  selectedProject = id;
  currentView = view;
  chatRequestVersion++;
  chatFingerprint = '';
  renderedRoom = null;
  messageNodes.clear();
  $('chat-messages').replaceChildren();
  const draft = roomDrafts.get(id);
  $('chat-input').value = draft?.text || '';
  $('chat-recipient').value = draft?.recipient || state.leadAgent || 'codex';
  $('chat-intent').value = draft?.intent || 'review';
  $('chat-error').hidden = true;
  renderState();
  updateComposerNote();
  if (id) refreshChat(id).catch((error) => notify(error.message, true));
}
function setView(view) {
  currentView = view;
  renderState();
  if (view === 'chat' && selectedProject) refreshChat(selectedProject).catch((error) => notify(error.message, true));
}
function renderProjects() {
  const key = JSON.stringify([state.projects, selectedProject, currentView, state.tasks.length]);
  if (key === projectsFingerprint) return;
  projectsFingerprint = key;
  $('all-projects').classList.toggle('active', currentView === 'history');
  $('all-projects').setAttribute('aria-current', currentView === 'history' ? 'page' : 'false');
  $('total-count').textContent = state.tasks.length;
  $('projects-empty').hidden = state.projects.length > 0;
  $('projects').replaceChildren(...state.projects.map((project) => {
    const active = selectedProject === project.id && currentView === 'chat';
    const control = node('button', `nav-item${active ? ' active' : ''}`);
    control.title = project.path;
    control.setAttribute('aria-current', active ? 'page' : 'false');
    control.append(node('span', 'project-icon', '#'), node('span', 'project-name', roomName(project)));
    control.addEventListener('click', () => selectProject(project.id));
    return control;
  }));
}
function renderAgents() {
  const lead = state.leadAgent || 'codex';
  const key = JSON.stringify([state.agents, lead]);
  if (key === participantsFingerprint) return;
  participantsFingerprint = key;
  $('agent-count').textContent = `${state.agents.length} participants`;
  $('room-lead-note').textContent = `${agentName(lead)} leads. @mention anyone to bring them in.`;
  $('sidebar-lead-note').textContent = `${agentName(lead)} leads the conversation. Mention anyone to bring them in.`;
  $('agents').replaceChildren(...state.agents.map((agent) => {
    const control = node('button', `participant ${agent.id}`);
    control.type = 'button';
    control.disabled = !agent.available && agent.mode !== 'manual';
    control.setAttribute('aria-label', `Message ${agent.name}`);
    const avatar = node('span', `agent-icon ${agent.id}`, agentCopy[agent.id]?.[0] || agent.name[0]);
    avatar.setAttribute('aria-hidden', 'true');
    control.append(avatar, node('span', '', agent.name));
    if (agent.id === lead) control.append(node('span', 'participant-label', 'Lead'));
    else if (agent.mode === 'webhook') control.append(node('span', 'participant-label', agent.available ? 'Automatic' : 'Unavailable'));
    else if (agent.mode === 'manual') control.append(node('span', 'participant-label manual', 'Manual'));
    const availability = agent.mode === 'webhook' ? agent.detail : agent.mode === 'manual' ? 'Manual copy-and-paste handoff' : agent.available ? 'Installed · uses your existing account' : 'Not installed';
    control.title = availability;
    control.addEventListener('click', () => { $('chat-recipient').value = agent.id; updateComposerNote(); $('chat-input').focus(); });
    return control;
  }));
  const chosen = $('chat-recipient').value || lead;
  const options = state.agents.map((agent) => {
    const option = new Option(`${agent.name}${agent.id === lead ? ' · Lead' : agent.mode === 'manual' ? ' · Manual' : ''}`, agent.id);
    option.disabled = !agent.available && agent.mode !== 'manual';
    return option;
  });
  options.push(new Option('Whole team · connected agents', 'team'));
  const automatic = state.agents.some(a => a.id === 'grok' && a.mode === 'webhook');
  $('grok-settings').textContent = automatic ? 'Grok connection' : 'Connect Grok';
  $('grok-empty-note').textContent = automatic ? 'Grok replies here automatically. Its approvals stay in Grok Bot.' : 'Connect Grok Bot once to bring its replies into this room.';
  $('chat-recipient').replaceChildren(...options);
  $('chat-recipient').value = options.some((option) => option.value === chosen && !option.disabled) ? chosen : lead;
}
function updateComposerNote() {
  const text = $('chat-input').value;
  const grokMention = /(?:^|\s)@grok\b/i.test(text);
  const automatic = state.agents.some(a => a.id === 'grok' && a.mode === 'webhook');
  const grok = grokMention || $('chat-recipient').value === 'grok' || (automatic && (/(?:^|\s)@team\b/i.test(text) || $('chat-recipient').value === 'team'));
  $('composer-note').textContent = grok ? (automatic ? 'Grok replies here automatically. Keep messages short; older context may be omitted. Approvals stay in Grok Bot; local file changes stay with local agents.' : 'Connect Grok for automatic replies, or use its manual handoff.') : $('chat-intent').value === 'work' ? 'Work mode allows project edits. Check the result before applying changes.' : 'Discussion asks agents to leave files unchanged. Their existing permissions still apply.';
  $('chat-input').placeholder = `Message ${$('chat-recipient').value === 'team' ? 'the team' : agentName($('chat-recipient').value)}, or @mention someone…`;
  saveDraft();
}
function updateRoomStatus() {
  const active = state.tasks.find((task) => task.id === state.activeTaskId && task.projectId === selectedProject);
  const queued = state.tasks.filter((task) => task.projectId === selectedProject && task.status === 'queued').length;
  let text = 'A shared conversation, with you in control.';
  if (state.cleanupError) text = state.cleanupError;
  else if (state.paused) text = 'Queue paused. Resume it from Task history to continue replies.';
  else if (active?.status === 'needs_input') text = `${agentName(active.agent)} needs your input. Open its reply to respond.`;
  else if (active?.status === 'handoff') text = 'Grok Bot is waiting for a manual handoff.';
  else if (active?.executionMode === 'webhook') text = 'Waiting for Grok’s cloud reply. Any approvals appear in Grok Bot.';
  else if (active) text = `${agentName(active.agent)} is working${queued ? ` · ${queued} queued` : ''}…`;
  else if (queued) text = `${queued} ${queued === 1 ? 'reply' : 'replies'} queued.`;
  $('room-status').textContent = text;
}
async function refreshChat(projectId) {
  const version = ++chatRequestVersion;
  const result = await api(`/chat/${encodeURIComponent(projectId)}`);
  if (projectId !== selectedProject || version !== chatRequestVersion) return;
  renderChat(result);
}
function scrollToLatest() {
  $('conversation').scrollTop = $('conversation').scrollHeight;
  $('latest-messages').hidden = true;
}
function renderChat(result, forceScroll = false) {
  const fingerprint = JSON.stringify([selectedProject, result]);
  if (chatFingerprint === fingerprint && !forceScroll) return;
  chatFingerprint = fingerprint;
  const scroller = $('conversation');
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  const newRoom = renderedRoom !== selectedProject;
  if (newRoom) { messageNodes.clear(); $('chat-messages').replaceChildren(); renderedRoom = selectedProject; }
  const messages = result.messages || [];
  $('chat-empty').hidden = messages.length > 0;
  $('chat-earlier').hidden = !result.hasEarlier;
  const ids = new Set(messages.map((message) => String(message.id)));
  for (const [id, element] of messageNodes) if (!ids.has(id)) { element.remove(); messageNodes.delete(id); }
  for (const message of messages) {
    const id = String(message.id);
    const author = message.role === 'user' ? 'you' : message.author;
    const task = message.task;
    let article = messageNodes.get(id);
    if (!article) {
      article = node('article', `message ${author === 'you' ? 'from-user' : 'from-agent'}`);
      article.dataset.messageId = id;
      const avatar = node('span', `message-avatar ${author}`, author === 'you' ? 'Y' : agentCopy[author]?.[0] || author?.[0] || '?');
      avatar.setAttribute('aria-hidden', 'true');
      const body = node('div', 'message-body');
      const heading = node('div', 'message-heading');
      heading.append(node('h3', '', author === 'you' ? 'You' : agentName(author)));
      if (author === 'codex') heading.append(node('span', 'lead-label', 'Lead'));
      const time = node('time', '', dateLabel(message.createdAt));
      time.dateTime = message.createdAt;
      heading.append(time);
      body.append(heading, node('div', 'message-text'), node('div', 'message-error'), node('div', 'message-actions'));
      article.append(avatar, body);
      messageNodes.set(id, article);
      $('chat-messages').append(article);
    }
    const text = message.text || task?.output || (task?.status === 'running' ? (task.executionMode === 'webhook' ? 'Waiting for Grok Bot… Check its app if an approval is needed.' : 'Thinking…') : task?.status === 'queued' ? 'Waiting for its turn…' : task?.status === 'handoff' ? 'Ready for a manual handoff. Open the instructions, then bring Grok’s reply back here.' : task?.status === 'needs_input' ? 'I need your input to continue.' : '');
    const textElement = article.querySelector('.message-text');
    if (textElement.textContent !== text) textElement.textContent = text;
    textElement.classList.toggle('pending', !message.text && !task?.output);
    const error = article.querySelector('.message-error');
    error.textContent = task?.error || '';
    error.hidden = !task?.error;
    const actions = article.querySelector('.message-actions');
    const actionsKey = JSON.stringify([task?.id, task?.status, message.approvals?.length]);
    if (actions.dataset.key !== actionsKey) {
      actions.dataset.key = actionsKey;
      const controls = [];
      if (task) {
        const status = node('span', `chat-status ${task.status}`, task.status === 'running' ? 'Replying' : task.status === 'awaiting_review' ? 'Reply ready' : statusNames[task.status] || task.status);
        controls.push(status);
        const label = task.status === 'needs_input' ? 'Respond to request' : task.status === 'handoff' ? 'Open Grok handoff' : task.status === 'awaiting_review' && task.intent === 'work' ? 'Review result' : 'Details';
        controls.push(button(label, `${['needs_input', 'handoff'].includes(task.status) ? 'secondary' : 'subtle'} small`, () => openTask(task.id)));
        if (['queued', 'running', 'needs_input', 'handoff'].includes(task.status)) controls.push(button(task.executionMode === 'webhook' ? 'Stop waiting' : 'Cancel', 'subtle small', async () => { await api(`/tasks/${encodeURIComponent(task.id)}/cancel`, {}); await refresh(); }));
      }
      actions.replaceChildren(...controls);
    }
  }
  if (newRoom || forceScroll || atBottom) scrollToLatest();
  else $('latest-messages').hidden = false;
}
function renderTasks() {
  const tasks = state.tasks.filter((task) => !selectedProject || task.projectId === selectedProject);
  const key = JSON.stringify([selectedTask, selectedProject, state.projects, tasks.map(({ id, title, projectId, agent, status, intent, parentTaskId, createdAt }) => ({ id, title, projectId, agent, status, intent, parentTaskId, createdAt }))]);
  if (key === tasksFingerprint) return;
  tasksFingerprint = key;
  const focusedTask = document.activeElement?.dataset.taskId;
  $('task-count').textContent = tasks.length;
  $('task-empty').hidden = tasks.length > 0;
  $('tasks').hidden = tasks.length === 0;
  $('empty-start').textContent = state.projects.length ? 'Back to conversation ↗' : 'Add your first project ↗';
  $('tasks').replaceChildren(...tasks.map((task) => {
    const row = node('button', `task-row${selectedTask === task.id ? ' selected' : ''}`);
    row.dataset.taskId = task.id;
    row.setAttribute('aria-expanded', selectedTask === task.id ? 'true' : 'false');
    row.setAttribute('aria-controls', 'task-detail');
    const name = node('span');
    name.append(node('span', 'task-name', task.title), node('span', 'task-subtitle', `${projectById(task.projectId)?.name || 'Project'} · ${task.intent === 'review' ? 'Review' : 'Work'}${task.parentTaskId ? ' · Follow-up' : ''}`));
    row.append(name, node('span', 'task-agent', agentName(task.agent)), statusBadge(task.status, isDiscussion(task) && task.status === 'awaiting_review' ? 'Reply ready' : undefined), node('span', 'task-time', dateLabel(task.createdAt)));
    row.addEventListener('click', () => openTask(task.id));
    return row;
  }));
  if (focusedTask) [...$('tasks').children].find((row) => row.dataset.taskId === focusedTask)?.focus({ preventScroll: true });
}
function renderState() {
  if (!projectById(selectedProject)) selectedProject = (state.projects.find((project) => project.name === 'Playground') || state.projects[0])?.id || null;
  const project = projectById(selectedProject);
  $('chat-pane').hidden = currentView !== 'chat';
  $('history-pane').hidden = currentView !== 'history';
  $('room-title').textContent = roomName(project);
  $('page-title').textContent = 'Task history';
  $('page-description').textContent = `${roomName(project)} · Results, approvals, and project changes.`;
  $('breadcrumb-name').textContent = currentView === 'chat' ? roomName(project) : `${roomName(project)} / Task history`;
  $('queue-paused').hidden = !state.paused;
  $('queue-paused').textContent = state.cleanupError || 'Queue paused. New replies will wait; the current reply can finish.';
  $('toggle-queue').textContent = state.paused ? (state.cleanupError ? 'Processes checked · resume' : 'Resume queue') : 'Pause queue';
  $('toggle-queue').disabled = false;
  $('send-message').disabled = !selectedProject || chatSending;
  renderProjects(); renderAgents(); renderTasks(); updateRoomStatus(); updateComposerNote();
}
async function refresh() {
  if (!token || polling || !$('access').hidden) return;
  polling = true;
  try {
    const next = await api('/state');
    const fingerprint = JSON.stringify(next);
    state = next;
    if (fingerprint !== stateFingerprint) { stateFingerprint = fingerprint; renderState(); }
    $('connection').classList.remove('disconnected');
    $('connection').lastElementChild.textContent = 'Connected locally';
    if (selectedProject && currentView === 'chat') await refreshChat(selectedProject);
    if (selectedTask) await refreshDetail(selectedTask);
  } catch (error) {
    $('connection').classList.add('disconnected');
    $('connection').lastElementChild.textContent = 'Connection interrupted';
    $('connection').title = error.message;
  } finally { polling = false; }
}
async function openTask(id) {
  selectedTask = id;
  detail = null;
  detailFingerprint = '';
  approvalFingerprint = '';
  $('handoff-result').value = '';
  $('task-detail').hidden = true;
  renderTasks();
  try {
    await refreshDetail(id);
    if (selectedTask === id && !$('task-detail-dialog').open) $('task-detail-dialog').showModal();
  } catch (error) { notify(error.message, true); }
}
async function refreshDetail(id) {
  const next = await api(`/tasks/${encodeURIComponent(id)}`);
  if (id !== selectedTask) return;
  detail = next;
  const fingerprint = JSON.stringify(next);
  if (fingerprint !== detailFingerprint) { detailFingerprint = fingerprint; renderDetail(); }
}
async function taskAction(action, message, body = {}) {
  const id = selectedTask;
  const result = await api(`/tasks/${encodeURIComponent(id)}/${action}`, body);
  if (message) notify(message);
  if (action === 'resume') {
    const task = result.task || result;
    selectedTask = task.id || id;
    detailFingerprint = '';
    approvalFingerprint = '';
  }
  await refresh();
}
function renderDetail() {
  const { task, events = [], approvals = [], handoffPrompt = '' } = detail;
  $('task-detail').hidden = false;
  $('detail-title').textContent = task.title;
  $('detail-kicker').textContent = `${agentName(task.agent)} / ${isDiscussion(task) ? 'Discussion' : task.intent === 'review' ? 'Review' : 'Work'}`;
  const meta = [statusBadge(task.status, isDiscussion(task) && task.status === 'awaiting_review' ? 'Reply ready' : undefined), node('span', '', projectById(task.projectId)?.name || 'Project'), node('span', '', `Created ${new Date(task.createdAt).toLocaleString()}`)];
  if (task.appliedAt) meta.push(node('span', '', 'Changes applied to project'));
  $('detail-meta').replaceChildren(...meta);
  const actionKey = JSON.stringify([task.id, task.status, task.appliedAt, task.isolate, task.baseHead, task.workspace]);
  if (actionsFingerprint !== actionKey) {
  actionsFingerprint = actionKey;
  const actions = [];
  if (['queued', 'running', 'needs_input', 'handoff'].includes(task.status)) actions.push(button(task.executionMode === 'webhook' ? 'Stop waiting' : 'Cancel task', 'subtle small danger', () => taskAction('cancel', task.executionMode === 'webhook' ? 'Relay stopped waiting. Grok may still be running in its app.' : 'Task cancelled.')));
  if (task.status === 'awaiting_review' && !isDiscussion(task)) actions.push(button('Mark as verified', 'primary small', async () => {
    if (window.confirm('Have you checked the result and any changed files? Marking this task as verified records your approval.')) await taskAction('verify', 'Result verified.');
  }));
  if (['awaiting_review', 'completed', 'failed', 'interrupted'].includes(task.status)) actions.push(button('Send to another agent ↗', 'secondary small', () => openComposer(task)));
  if (['failed', 'cancelled', 'interrupted'].includes(task.status)) actions.push(button('Continue with context', 'secondary small', () => taskAction('resume', 'New task queued with the previous context.')));
  if (task.status === 'completed' && task.isolate && task.baseHead && !task.appliedAt) actions.push(button('Apply verified changes', 'secondary small', async () => {
    if (window.confirm('Apply this task’s verified changes to the original project? Relay will check that the project is clean and has not moved from the starting revision.')) await taskAction('apply', 'Verified changes applied to the project.');
  }));
  if (task.workspace) actions.push(button('Open folder', 'subtle small', () => taskAction('open-folder', null)));
  $('detail-actions').replaceChildren(...actions);
  }
  $('detail-error').hidden = !task.error;
  $('detail-error').textContent = task.error || '';
  const approvalsKey = JSON.stringify([task.id, approvals]);
  if (approvalFingerprint !== approvalsKey) { approvalFingerprint = approvalsKey; renderApprovals(approvals); }
  $('handoff').hidden = task.status !== 'handoff';
  $('handoff-prompt').textContent = handoffPrompt || task.prompt;
  $('task-output').textContent = task.output || (task.status === 'queued' ? 'Waiting for its turn. Agent output will appear here.' : task.status === 'handoff' ? 'Submit Grok Bot’s result above to bring it into Relay.' : ['running', 'needs_input'].includes(task.status) ? 'The agent is working. Its response will appear here.' : 'No response text was recorded. Check the activity and project files.');
  $('result-state').textContent = task.status === 'awaiting_review' ? isDiscussion(task) ? 'Response received' : 'Needs your verification' : task.status === 'completed' ? 'Verified by you' : '';
  $('task-prompt').textContent = task.prompt;
  $('workspace-path').textContent = task.executionMode === 'webhook' ? 'Grok Bot · Cloud reply · Local files are not shared · Approvals stay in Grok Bot' : task.workspace ? `Task folder · ${task.workspace}` : '';
  const activity = events.slice(-80).reverse().map((event) => {
    let data = event.data || {};
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = { text: data }; } }
    const item = node('li', 'event');
    const title = data.title || (event.type === 'status' ? statusNames[data.status] || 'Status updated' : event.type.replaceAll('_', ' '));
    item.append(node('span', '', title));
    const text = data.text || data.message || (event.type === 'status' ? '' : data.status);
    if (text && text !== title) item.append(node('span', 'event-text', typeof text === 'string' ? text : JSON.stringify(text)));
    const time = node('time', '', dateLabel(event.createdAt));
    time.dateTime = event.createdAt;
    item.append(time);
    return item;
  });
  if (!activity.length) activity.push(node('li', 'event', 'No activity yet.'));
  $('task-events').replaceChildren(...activity);
}
function renderApprovals(approvals) {
  $('approvals').replaceChildren(...approvals.map((approval) => {
    const panel = node('section', 'approval');
    panel.append(node('h3', '', approval.title || 'Your input is needed'), node('p', '', approval.description || 'Review this request before continuing.'));
    const answers = {};
    for (const question of approval.questions || []) {
      const label = node('label', '', question.question || question.header);
      const field = node('textarea');
      field.rows = 2;
      field.setAttribute('aria-label', question.question || question.header || 'Your answer');
      label.append(field);
      panel.append(label);
      answers[question.id] = field;
      if (question.options?.length) {
        const select = node('select');
        select.setAttribute('aria-label', `Suggested answers for ${question.header || question.question}`);
        select.append(new Option('Choose a suggestion…', ''));
        for (const option of question.options) select.append(new Option(option.description ? `${option.label} — ${option.description}` : option.label, option.label));
        select.addEventListener('change', () => { if (select.value) field.value = select.value; });
        panel.insertBefore(select, label);
      }
    }
    const actions = node('div', 'approval-actions');
    for (const [index, option] of (approval.options?.length ? approval.options : [{ id: 'submit', label: 'Send answers' }]).entries()) {
      actions.append(button(option.label, `${index === 0 ? 'primary' : 'secondary'} small`, async () => {
        const payload = { requestId: approval.id, optionId: option.id };
        if (Object.keys(answers).length) payload.answers = Object.fromEntries(Object.entries(answers).map(([id, field]) => [id, field.value]));
        await taskAction('approve', 'Response sent to the agent.', payload);
      }));
    }
    panel.append(actions);
    return panel;
  }));
}
function openProjectDialog() {
  $('project-form').reset();
  $('project-error').hidden = true;
  $('project-dialog').showModal();
}
function openComposer(parent) {
  if (!state.projects.length) { openProjectDialog(); return; }
  if ($('task-detail-dialog').open) $('task-detail-dialog').close();
  $('task-form').reset();
  $('task-error').hidden = true;
  $('task-project').replaceChildren(...state.projects.map((project) => new Option(project.name, project.id)));
  $('task-project').value = parent?.projectId || selectedProject || state.projects[0].id;
  $('task-project').disabled = Boolean(parent);
  $('task-agent').replaceChildren(...state.agents.map((agent) => {
    const option = new Option(`${agent.name}${agent.mode === 'manual' ? ' · Manual handoff' : agent.available ? '' : ' · Not found'}`, agent.id);
    option.disabled = !agent.available && agent.mode !== 'manual';
    return option;
  }));
  const agent = state.agents.find((agent) => (agent.available || agent.mode === 'manual') && agent.id !== parent?.agent) || state.agents.find((agent) => agent.available || agent.mode === 'manual');
  if (agent) $('task-agent').value = agent.id;
  $('task-parent').value = parent?.id || '';
  $('task-dialog-title').textContent = parent ? 'Hand off the work' : 'New task';
  $('review-context').hidden = !parent;
  if (parent) {
    $('task-title').value = `Review: ${parent.title}`.slice(0, 160);
    $('task-instructions').value = 'Review the preceding task’s result and any changed files. Check that the original goal is met, identify concrete issues, and report the evidence you checked. Do not apply changes to the original project.';
    $('task-intent').value = 'review';
    $('task-isolate').checked = Boolean(parent.isolate);
  }
  updateAgentNote();
  $('task-dialog').showModal();
}
function updateAgentNote() {
  const mode = state.agents.find((agent) => agent.id === $('task-agent').value)?.mode;
  const manual = mode === 'manual';
  $('agent-note').textContent = mode === 'webhook' ? 'Grok receives recent conversation text in the cloud. Keep messages short; older context may be omitted. It cannot edit your local files through Relay. Approvals stay in Grok Bot.' : manual ? 'Relay will prepare instructions for you to paste into Grok Bot. Paste its result back when finished.' : 'Uses the installed agent and its existing account. Review is an instruction; each runtime retains its own permissions.';
  $('create-task').textContent = manual ? 'Prepare handoff ↗' : 'Add to queue ↗';
}

let grokStatus;
function showGrokStatus(value) {
  grokStatus = value;
  $('grok-url').value = value.webhookUrl || '';
  $('grok-key').value = '';
  $('grok-enabled').checked = value.enabled;
  $('grok-key').placeholder = value.keySaved ? 'Saved · leave blank to keep it' : 'Paste the routine’s key';
  $('grok-instruction').value = value.instruction;
  $('grok-test').disabled = !selectedProject || !value.enabled || !value.configured || !value.tunnelInstalled;
  $('grok-connection-status').textContent = value.configurationError || (!value.tunnelInstalled ? 'Reply connection helper is missing. See the setup guide in Relay’s folder.' : !value.configured ? 'Add the dedicated routine’s URL and key to connect.' : !value.enabled ? 'Automatic replies are off. Manual handoff is available.' : value.lastResultAt ? `Last automatic reply: ${new Date(value.lastResultAt).toLocaleString()}` : 'Connection saved. Send a test to verify a full reply.');
}
$('grok-settings').addEventListener('click', () => runAction($('grok-settings'), async () => {
  showGrokStatus(await api('/grok'));
  $('grok-error').hidden = true;
  $('grok-dialog').showModal();
}));
$('grok-dialog').addEventListener('close', () => { $('grok-key').value = ''; });
$('grok-form').addEventListener('submit', event => {
  event.preventDefault();
  runAction($('grok-save'), async () => {
    showGrokStatus(await api('/grok', { webhookUrl: $('grok-url').value.trim(), webhookKey: $('grok-key').value.trim(), enabled: $('grok-enabled').checked }));
    await refresh();
    notify('Grok connection saved.');
  }, 'grok-error');
});
$('copy-grok-instruction').addEventListener('click', () => runAction($('copy-grok-instruction'), async () => {
  try { await navigator.clipboard.writeText($('grok-instruction').value); notify('Setup instructions copied.'); }
  catch { $('grok-instruction').select(); notify('Press ⌘C to copy the selected instructions.'); }
}));
$('grok-test').addEventListener('click', () => runAction($('grok-test'), async () => {
  if (!selectedProject || !grokStatus?.configured || !grokStatus.enabled) return;
  if ($('grok-url').value.trim() !== grokStatus.webhookUrl || $('grok-key').value.trim() || $('grok-enabled').checked !== grokStatus.enabled) throw new Error('Save the connection changes before testing.');
  const projectId = selectedProject;
  await api(`/chat/${encodeURIComponent(projectId)}`, { text: '@grok Connection check: please reply “Grok is here in the Relay room.” Do not change any files or settings.', recipient: 'grok', intent: 'review' });
  $('grok-dialog').close();
  selectProject(projectId);
  await refresh();
}, 'grok-error'));

$('all-projects').addEventListener('click', () => setView('history'));
$('add-project').addEventListener('click', openProjectDialog);
$('add-project-small').addEventListener('click', openProjectDialog);
$('new-task').addEventListener('click', () => openComposer());
$('empty-start').addEventListener('click', () => state.projects.length ? setView('chat') : openProjectDialog());
$('task-agent').addEventListener('change', updateAgentNote);
$('close-detail').addEventListener('click', () => $('task-detail-dialog').close());
$('task-detail-dialog').addEventListener('close', () => { selectedTask = null; detail = null; $('task-detail').hidden = true; renderTasks(); });
$('access-retry').addEventListener('click', () => { if (!token) location.reload(); else { $('access').hidden = true; $('app').hidden = false; refresh(); } });
$('toggle-queue').addEventListener('click', () => runAction($('toggle-queue'), async () => { await api('/queue', { paused: !state.paused }); await refresh(); }));
for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => close.closest('dialog').close());
$('pick-folder').addEventListener('click', () => runAction($('pick-folder'), async () => {
  const result = await api('/pick-folder', {});
  if (result.path) {
    $('project-path').value = result.path;
    if (!$('project-name').value.trim()) $('project-name').value = result.path.split('/').filter(Boolean).at(-1) || 'Project';
  }
}, 'project-error'));
$('project-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(event.submitter, async () => {
    const result = await api('/projects', { name: $('project-name').value.trim(), path: $('project-path').value.trim() });
    const project = result.project || result;
    $('project-dialog').close();
    notify('Project room created. Start a conversation with your team.');
    await refresh();
    selectProject(project.id);
  }, 'project-error');
});
$('task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(event.submitter, async () => {
    const body = { projectId: $('task-project').value, title: $('task-title').value.trim(), prompt: $('task-instructions').value.trim(), agent: $('task-agent').value, intent: $('task-intent').value, isolate: $('task-isolate').checked, timeoutMinutes: Number($('task-timeout').value) };
    if ($('task-parent').value) body.parentTaskId = $('task-parent').value;
    const result = await api('/tasks', body);
    const task = result.task || result;
    $('task-dialog').close();
    selectProject(body.projectId, currentView);
    notify(body.agent === 'grok' && state.agents.find(a => a.id === 'grok')?.mode === 'manual' ? 'Handoff prepared. Copy the instructions into Grok Bot.' : 'Task added to the queue.');
    await refresh();
    await openTask(task.id);
  }, 'task-error');
});
$('copy-handoff').addEventListener('click', () => runAction($('copy-handoff'), async () => {
  try { await navigator.clipboard.writeText($('handoff-prompt').textContent); notify('Instructions copied. Paste them into Grok Bot.'); }
  catch { const range = document.createRange(); range.selectNodeContents($('handoff-prompt')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); notify('Instructions selected. Press ⌘C to copy.'); }
}));
$('handoff-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(event.submitter, async () => {
    await taskAction('handoff', 'Grok’s result is ready for verification.', { output: $('handoff-result').value.trim() });
    $('handoff-result').value = '';
  });
});

$('chat-recipient').addEventListener('change', updateComposerNote);
$('chat-intent').addEventListener('change', updateComposerNote);
$('chat-input').addEventListener('input', updateComposerNote);
$('chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
});
$('conversation').addEventListener('scroll', () => {
  if ($('conversation').scrollHeight - $('conversation').scrollTop - $('conversation').clientHeight < 100) $('latest-messages').hidden = true;
});
$('latest-messages').addEventListener('click', scrollToLatest);
for (const suggestion of document.querySelectorAll('[data-suggestion]')) suggestion.addEventListener('click', () => {
  $('chat-input').value = suggestion.dataset.suggestion;
  updateComposerNote();
  $('chat-input').focus();
});
$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('chat-input').value.trim();
  const projectId = selectedProject;
  if (chatSending || !text || !projectId) return;
  const body = { text, recipient: $('chat-recipient').value, intent: $('chat-intent').value };
  runAction($('send-message'), async () => {
    chatSending = true;
    try {
    chatRequestVersion++;
    const result = await api(`/chat/${encodeURIComponent(projectId)}`, body);
    chatRequestVersion++;
    if (projectId === selectedProject) {
      if ($('chat-input').value.trim() === text) $('chat-input').value = '';
      saveDraft();
      renderChat(result, true);
      $('chat-input').focus();
    } else if (roomDrafts.get(projectId)?.text.trim() === text) roomDrafts.delete(projectId);
    await refresh();
    } finally { chatSending = false; }
  }, 'chat-error');
});

if (!token) requireAccess('Open Relay using its launcher to connect this browser securely.');
else { renderState(); refresh(); }
setInterval(refresh, 2200);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
