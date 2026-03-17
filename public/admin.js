(() => {
  const tokenKey = 'adminToken';
  let token = localStorage.getItem(tokenKey) || '';
  let activityChart;

  const loginCard = document.getElementById('loginCard');
  const dashboard = document.getElementById('dashboard');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const adminSession = document.getElementById('adminSession');
  const adminName = document.getElementById('adminName');
  const logoutBtn = document.getElementById('logoutBtn');
  const statsFields = {
    totalUsers: document.getElementById('totalUsers'),
    onlineUsers: document.getElementById('onlineUsers'),
    totalGroups: document.getElementById('totalGroups'),
    activeChats: document.getElementById('activeChats')
  };
  const searchInput = document.getElementById('searchUser');
  const clearSearch = document.getElementById('clearSearch');
  const refreshBtn = document.getElementById('refreshBtn');
  const lastUpdated = document.getElementById('lastUpdated');
  const userList = document.getElementById('userList');
  const rowTemplate = document.getElementById('user-row-template');
  const liveUsersTable = document.getElementById('liveUsers');
  const liveUserTemplate = document.getElementById('live-user-row');
  const reportList = document.getElementById('reportList');
  const reportTemplate = document.getElementById('report-row');
  const groupList = document.getElementById('groupList');
  const groupTemplate = document.getElementById('group-row');
  const offlineList = document.getElementById('offlineList');
  const offlineTemplate = document.getElementById('offline-row');
  const contactList = document.getElementById('contactList');
  const contactTemplate = document.getElementById('contact-row');
  const conversationEl = document.getElementById('conversation');
  const chatTitle = document.getElementById('chatTitle');
  const contactHeader = document.getElementById('contactHeader');
  const memberList = document.getElementById('memberList');
  const memberTemplate = document.getElementById('member-row');
  const membersHeader = document.getElementById('membersHeader');

  let activeChatUser = '';
  let activeChatUserName = '';
  let activeContact = '';
  const contactNames = new Map();
  let activeGroupId = '';
  let activeGroupName = '';

  function authHeaders() {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function showDashboard(username) {
    loginCard.hidden = true;
    dashboard.hidden = false;
    adminSession.hidden = false;
    adminName.textContent = username ? `Admin • ${username}` : 'Admin';
    refreshAll();
  }

  function showLogin(message = '') {
    loginCard.hidden = false;
    dashboard.hidden = true;
    adminSession.hidden = true;
    loginError.textContent = message;
  }

  function formatTime(value) {
    const ts = Number(value);
    if (!Number.isFinite(ts)) return '—';
    return new Date(ts).toLocaleString();
  }

  async function handleLogin(event) {
    event.preventDefault();
    loginError.textContent = '';
    const formData = new FormData(loginForm);
    const username = formData.get('username');
    const password = formData.get('password');

    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (!res.ok) {
        loginError.textContent = 'Invalid credentials';
        return;
      }

      const data = await res.json();
      token = data.token;
      localStorage.setItem(tokenKey, token);
      showDashboard(data.username || 'Admin');
    } catch (error) {
      loginError.textContent = 'Login failed, please try again';
      console.error(error);
    }
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
        ...authHeaders()
      }
    });

    if (res.status === 401) {
      clearAuth('Session expired. Please sign in again.');
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Request failed');
    }

    return res.json();
  }

  function clearAuth(message = '') {
    token = '';
    localStorage.removeItem(tokenKey);
    showLogin(message);
  }

  async function loadStats() {
    const data = await fetchJson('/admin/stats');
    statsFields.totalUsers.textContent = data.totalUsers;
    statsFields.onlineUsers.textContent = data.onlineUsers;
    statsFields.totalGroups.textContent = data.totalGroups;
    statsFields.activeChats.textContent = data.activeChats;
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  function renderUsers(users = []) {
    userList.innerHTML = '';
    if (!users.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'No users found';
      cell.classList.add('muted');
      row.appendChild(cell);
      userList.appendChild(row);
      return;
    }

    users.forEach((user) => {
      const fragment = rowTemplate.content.cloneNode(true);
      fragment.querySelector('[data-field="id"]').textContent = user.id;
      fragment.querySelector('[data-field="username"]').textContent = user.username;
      const statusCell = fragment.querySelector('[data-field="status"]');
      statusCell.textContent = user.status === 'online' ? 'Online' : 'Offline';
      statusCell.className = user.status === 'online' ? 'status status-online' : 'status status-offline';
      fragment.querySelector('[data-field="lastSeen"]').textContent = user.status === 'online' ? 'Now' : formatTime(user.lastSeen);

      const deleteBtn = fragment.querySelector('[data-action="delete"]');
      deleteBtn.addEventListener('click', () => confirmDelete(user));
      const banBtn = fragment.querySelector('[data-action="ban"]');
      banBtn.addEventListener('click', () => banUser(user));
      const chatsBtn = fragment.querySelector('[data-action="chats"]');
      chatsBtn.addEventListener('click', () => openUserChats(user));

      userList.appendChild(fragment);
    });
  }

  async function loadUsers() {
    const query = searchInput.value.trim();
    const url = query ? `/admin/users?search=${encodeURIComponent(query)}` : '/admin/users';
    const data = await fetchJson(url);
    renderUsers(data.users || []);
  }

  function renderLiveUsers(list = []) {
    liveUsersTable.innerHTML = '';
    if (!list.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.textContent = 'No live connections';
      cell.classList.add('muted');
      row.appendChild(cell);
      liveUsersTable.appendChild(row);
      return;
    }

    list.forEach((user) => {
      const fragment = liveUserTemplate.content.cloneNode(true);
      fragment.querySelector('[data-field=\"id\"]').textContent = user.userId;
      fragment.querySelector('[data-field=\"username\"]').textContent = user.username || '—';
      liveUsersTable.appendChild(fragment);
    });
  }

  async function loadLiveUsers() {
    const data = await fetchJson('/admin/live-users');
    renderLiveUsers(data.users || []);
  }

  function renderReports(list = []) {
    reportList.innerHTML = '';
    if (!list.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'No reports';
      cell.classList.add('muted');
      row.appendChild(cell);
      reportList.appendChild(row);
      return;
    }

    list.forEach((report) => {
      const fragment = reportTemplate.content.cloneNode(true);
      fragment.querySelector('[data-field=\"reporter\"]').textContent = report.reporterUsername || report.reporterId;
      fragment.querySelector('[data-field=\"text\"]').textContent = (report.messageText || '').slice(0, 140) || '(empty)';
      fragment.querySelector('[data-field=\"reason\"]').textContent = report.reason || 'Not provided';
      fragment.querySelector('[data-field=\"createdAt\"]').textContent = formatTime(report.createdAt);

      const dismissBtn = fragment.querySelector('[data-action=\"dismiss\"]');
      dismissBtn.addEventListener('click', () => dismissReport(report.id));

      const deleteBtn = fragment.querySelector('[data-action=\"delete-msg\"]');
      deleteBtn.addEventListener('click', () => deleteMessage(report.messageId, report.id));

      reportList.appendChild(fragment);
    });
  }

  async function loadReports() {
    const data = await fetchJson('/admin/reports');
    renderReports(data.reports || []);
  }

  function renderGroups(groups = []) {
    groupList.innerHTML = '';
    if (!groups.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'No groups';
      cell.classList.add('muted');
      row.appendChild(cell);
      groupList.appendChild(row);
      return;
    }
    groups.forEach((group) => {
      const fragment = groupTemplate.content.cloneNode(true);
      fragment.querySelector('[data-field=\"name\"]').textContent = group.groupName || '(unnamed group)';
      fragment.querySelector('[data-field=\"groupId\"]').textContent = group.groupId || '(id missing)';
      fragment.querySelector('[data-field=\"members\"]').textContent = group.members || 0;
      fragment.querySelector('[data-field=\"count\"]').textContent = group.messages;
      fragment.querySelector('[data-action=\"delete-group\"]').addEventListener('click', () => deleteGroup(group.groupId));
      fragment.querySelector('[data-action=\"members\"]').addEventListener('click', () => loadMembers(group.groupId, group.groupName));
      fragment.querySelector('[data-field=\"name\"]').addEventListener('click', () => openGroupChat(group.groupId, group.groupName));
      fragment.querySelector('[data-field=\"groupId\"]').addEventListener('click', () => openGroupChat(group.groupId, group.groupName));
      groupList.appendChild(fragment);
    });
  }

  async function loadGroups() {
    const data = await fetchJson('/admin/groups');
    renderGroups(data.groups || []);
  }

  function renderMembers(members = [], groupName = '') {
    memberList.innerHTML = '';
    membersHeader.textContent = groupName ? `Members of ${groupName}` : 'Group members';
    if (!members.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.textContent = 'No members found';
      cell.classList.add('muted');
      row.appendChild(cell);
      memberList.appendChild(row);
      return;
    }
    members.forEach((m) => {
      const fragment = memberTemplate.content.cloneNode(true);
      const label = m.displayName || m.username || m.id;
      fragment.querySelector('[data-field=\"member\"]').textContent = label;
      fragment.querySelector('[data-action=\"remove-member\"]').addEventListener('click', () => removeMember(m.groupId, m.id, label));
      memberList.appendChild(fragment);
    });
  }

  async function loadMembers(groupId, groupName) {
    const data = await fetchJson(`/admin/groups/${encodeURIComponent(groupId)}/members`);
    const members = (data.members || []).map((m) => ({ ...m, groupId }));
    renderMembers(members, groupName);
  }

  async function removeMember(groupId, userId, label) {
    const ok = window.confirm(`Remove ${label} from this group?`);
    if (!ok) return;
    await fetchJson(`/admin/groups/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    await loadMembers(groupId, activeGroupName || '');
    await loadGroups();
  }

  function renderOffline(list = []) {
    offlineList.innerHTML = '';
    if (!list.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.textContent = 'No pending offline messages';
      cell.classList.add('muted');
      row.appendChild(cell);
      offlineList.appendChild(row);
      return;
    }
    list.forEach((item) => {
      const fragment = offlineTemplate.content.cloneNode(true);
      fragment.querySelector('[data-field=\"userId\"]').textContent = item.toUserId;
      fragment.querySelector('[data-field=\"count\"]').textContent = item.count;
      fragment.querySelector('[data-action=\"view-offline\"]').addEventListener('click', () => viewOfflineMessages(item.toUserId));
      offlineList.appendChild(fragment);
    });
  }

  async function loadOffline() {
    const data = await fetchJson('/admin/offline-messages');
    renderOffline(data.offline || []);
  }

  async function viewOfflineMessages(userId) {
    const data = await fetchJson(`/admin/offline/${encodeURIComponent(userId)}`);
    const msgs = data.messages || [];
    const preview = msgs.map((m) => `• ${formatTime(m.timestamp)} – ${m.fromUserId}: ${m.text || ''}`).join('\n') || 'No undelivered messages';
    alert(`Offline messages for ${userId} (showing up to 200):\n\n${preview}`);
  }

  function renderContacts(list = []) {
    contactList.innerHTML = '';
    contactNames.clear();
    if (!list.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.textContent = 'No contacts';
      cell.classList.add('muted');
      row.appendChild(cell);
      contactList.appendChild(row);
      return;
    }
    list.forEach((c) => {
      const display = c.contactDisplayName || c.contactUsername || c.contactId;
      contactNames.set(c.contactId, display);
      const fragment = contactTemplate.content.cloneNode(true);
      fragment.querySelector('[data-field=\"contact\"]').textContent = `${display} (${c.messageCount || 0})`;
      fragment.querySelector('tr').addEventListener('click', () => openConversation(c.contactId));
      contactList.appendChild(fragment);
    });
  }

  function renderConversation(list = []) {
    conversationEl.innerHTML = '';
    if (!list.length) {
      conversationEl.textContent = 'No messages in this conversation (limit 300 shown).';
      return;
    }
    list.forEach((msg) => {
      const fromName = msg.fromDisplayName || msg.fromUsername || msg.fromUserId;
      const toName = msg.toDisplayName || msg.toUsername || msg.toUserId;
      const div = document.createElement('div');
      const isPeerChat = Boolean(activeChatUser && activeContact);
      const isFromPrimary = isPeerChat && msg.fromUserId === activeChatUser;
      const isGroup = Boolean(activeGroupId);

      if (isGroup) {
        div.className = 'bubble bubble-group';
      } else {
        div.className = isFromPrimary ? 'bubble bubble-left' : 'bubble bubble-right';
      }

      if (isGroup) {
        const senderLine = document.createElement('span');
        senderLine.className = 'sender';
        senderLine.textContent = fromName;
        div.appendChild(senderLine);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${formatTime(msg.timestamp)}`;
      const text = document.createElement('div');
      text.textContent = msg.text || '(empty)';
      const actions = document.createElement('div');
      actions.className = 'actions-row';
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteMessage(msg.id));
      const reportBtn = document.createElement('button');
      reportBtn.className = 'ghost';
      reportBtn.textContent = 'Report';
      reportBtn.addEventListener('click', () => reportMessage(msg.id));
      actions.appendChild(delBtn);
      actions.appendChild(reportBtn);
      div.appendChild(meta);
      div.appendChild(text);
      div.appendChild(actions);
      conversationEl.appendChild(div);
    });
  }

  async function openGroupChat(groupId, groupName) {
    activeGroupId = groupId;
    activeGroupName = groupName || groupId;
    activeChatUser = '';
    activeContact = '';
    chatTitle.textContent = `Group: ${activeGroupName}`;
    contactHeader.textContent = '';
    try {
      const data = await fetchJson(`/admin/group-chat/${encodeURIComponent(groupId)}`);
      const msgs = data.messages || [];
      const converted = msgs.map((m) => ({
        ...m,
        toDisplayName: activeGroupName,
        toUsername: activeGroupName
      }));
      renderConversation(converted);
    } catch (err) {
      renderConversation([]);
      conversationEl.textContent = 'Group chat unavailable (members offline).';
      console.error(err);
    }
  }

  async function openUserChats(user) {
    activeChatUser = user.id;
    activeChatUserName = user.displayName || user.username || user.id;
    contactHeader.textContent = `User: ${activeChatUserName}`;
    chatTitle.textContent = 'Select a contact';
    renderConversation([]);
    const data = await fetchJson(`/admin/user-chats/${encodeURIComponent(user.id)}`);
    renderContacts(data.contacts || []);
  }

  async function openConversation(contactId) {
    if (!activeChatUser) return;
    activeContact = contactId;
    const contactName = contactNames.get(contactId) || contactId;
    chatTitle.textContent = `${activeChatUserName} ↔ ${contactName}`;
    const data = await fetchJson(`/admin/chat/${encodeURIComponent(activeChatUser)}/${encodeURIComponent(contactId)}`);
    renderConversation(data.messages || []);
  }

  async function deleteGroup(groupId) {
    const ok = window.confirm(`Delete all messages in group ${groupId}?`);
    if (!ok) return;
    await fetchJson(`/admin/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    activeGroupId = '';
    activeGroupName = '';
    renderMembers([], '');
    renderConversation([]);
    await Promise.all([loadGroups(), loadStats(), loadActivity()]);
  }

  async function loadActivity() {
    const rows = await fetchJson('/admin/activity');
    const labels = rows.map((row) => row.minute);
    const values = rows.map((row) => row.count);

    if (activityChart) {
      activityChart.data.labels = labels;
      activityChart.data.datasets[0].data = values;
      activityChart.update();
      return;
    }

    const ctx = document.getElementById('activityChart');
    activityChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Messages',
          data: values,
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.1)',
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#cbd5f5' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#cbd5f5' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  }

  async function confirmDelete(user) {
    const ok = window.confirm(`Delete user ${user.username}? This removes their account and history.`);
    if (!ok) return;

    await fetchJson(`/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    await Promise.all([loadStats(), loadUsers(), loadReports()]);
  }

  async function banUser(user) {
    const ok = window.confirm(`Ban user ${user.username}? They will be disconnected immediately.`);
    if (!ok) return;

    await fetchJson(`/admin/ban/${encodeURIComponent(user.id)}`, { method: 'POST' });
    await Promise.all([loadStats(), loadUsers(), loadLiveUsers(), loadReports()]);
  }

  async function dismissReport(reportId) {
    await fetchJson(`/admin/reports/${encodeURIComponent(reportId)}`, { method: 'DELETE' });
    await loadReports();
  }

  async function deleteMessage(messageId, reportId) {
    const ok = window.confirm('Delete this message permanently?');
    if (!ok) return;
    await fetchJson(`/admin/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    if (reportId) {
      await dismissReport(reportId);
    } else {
      await Promise.all([loadReports(), loadActivity()]);
      if (activeChatUser && activeContact) {
        await openConversation(activeContact);
      }
    }
  }

  async function reportMessage(messageId) {
    await fetchJson('/api/messages/report', {
      method: 'POST',
      body: JSON.stringify({ messageId, reason: 'admin_manual' })
    });
    await loadReports();
    alert('Message reported to admin queue.');
  }

  function scheduleRefresh() {
    // intentionally empty to avoid periodic polling; manual refresh only
  }

  function refreshAll() {
    Promise.all([
      loadStats(),
      loadUsers(),
      loadLiveUsers(),
      loadActivity(),
      loadReports(),
      loadGroups(),
      loadOffline()
    ]).catch((error) => console.error(error));
  }

  function initSearch() {
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(loadUsers, 350);
    });
    clearSearch.addEventListener('click', () => {
      searchInput.value = '';
      loadUsers();
    });
  }

  logoutBtn.addEventListener('click', () => clearAuth());
  loginForm.addEventListener('submit', handleLogin);
  refreshBtn.addEventListener('click', refreshAll);
  initSearch();

  if (token) {
    showDashboard('Admin');
  } else {
    showLogin();
  }
})();
