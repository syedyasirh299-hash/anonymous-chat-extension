function formatClock(totalSeconds) {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export class ChatUI {
  constructor(doc) {
    this.doc = doc;
    this.handlers = {};
    this.sidebarBehaviorEnabled = true;
    this.activeVoiceAudio = null;

    this.el = {
      sidebar: doc.getElementById('sidebar'),
      sidebarOverlay: doc.getElementById('sidebar-overlay'),
      sidebarOpenBtn: doc.getElementById('sidebar-open-btn'),
      sidebarCloseBtn: doc.getElementById('sidebar-close-btn'),
      sidebarBehaviorToggle: doc.getElementById('sidebar-behavior-toggle'),

      chatList: doc.getElementById('chat-list'),
      activeChatName: doc.getElementById('active-chat-name'),
      activeChatMeta: doc.getElementById('active-chat-meta'),

      messageList: doc.getElementById('messages'),
      messageInput: doc.getElementById('message-input'),
      sendBtn: doc.getElementById('send-btn'),
      recordVoiceBtn: doc.getElementById('record-voice-btn'),

      voiceRecorderPanel: doc.getElementById('voice-recorder-panel'),
      voiceTimer: doc.getElementById('voice-timer'),
      voiceSendBtn: doc.getElementById('voice-send-btn'),
      voiceCancelBtn: doc.getElementById('voice-cancel-btn'),

      notifyPermissionBtn: doc.getElementById('notify-permission-btn'),
      simulateIncomingBtn: doc.getElementById('simulate-incoming-btn'),
      lockNowBtn: doc.getElementById('lock-now-btn'),

      lockOverlay: doc.getElementById('lock-overlay'),
      lockTitle: doc.getElementById('lock-title'),
      lockPasswordInput: doc.getElementById('lock-password-input'),
      unlockButton: doc.getElementById('unlock-button'),
      sessionKeyButton: doc.getElementById('session-key-button'),
      lockStatus: doc.getElementById('lock-status'),

      securityWarning: doc.getElementById('security-warning')
    };
  }

  bindHandlers(handlers) {
    this.handlers = handlers || {};

    this.el.sidebarOpenBtn.addEventListener('click', () => this.openSidebar());
    this.el.sidebarCloseBtn.addEventListener('click', () => this.closeSidebar());
    this.el.sidebarOverlay.addEventListener('click', () => this.closeSidebar());

    this.el.sidebarBehaviorToggle.addEventListener('change', (event) => {
      this.setSidebarBehaviorEnabled(Boolean(event.target.checked));
      if (this.handlers.onSidebarBehaviorToggle) {
        this.handlers.onSidebarBehaviorToggle(Boolean(event.target.checked));
      }
    });

    this.el.chatList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-chat-id]');
      if (!item || !this.handlers.onChatSelect) return;
      this.handlers.onChatSelect(item.dataset.chatId);
      this.closeSidebar();
    });

    this.el.sendBtn.addEventListener('click', () => {
      if (this.handlers.onSendText) {
        this.handlers.onSendText();
      }
    });

    this.el.messageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (this.handlers.onSendText) {
          this.handlers.onSendText();
        }
      }
    });

    this.el.recordVoiceBtn.addEventListener('click', () => {
      if (this.handlers.onStartVoiceRecording) {
        this.handlers.onStartVoiceRecording();
      }
    });

    this.el.voiceSendBtn.addEventListener('click', () => {
      if (this.handlers.onStopVoiceRecording) {
        this.handlers.onStopVoiceRecording(true);
      }
    });

    this.el.voiceCancelBtn.addEventListener('click', () => {
      if (this.handlers.onStopVoiceRecording) {
        this.handlers.onStopVoiceRecording(false);
      }
    });

    this.el.unlockButton.addEventListener('click', () => {
      if (this.handlers.onUnlock) {
        this.handlers.onUnlock(this.el.lockPasswordInput.value);
      }
    });

    this.el.lockPasswordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && this.handlers.onUnlock) {
        event.preventDefault();
        this.handlers.onUnlock(this.el.lockPasswordInput.value);
      }
    });

    this.el.sessionKeyButton.addEventListener('click', () => {
      if (this.handlers.onStartSessionOnly) {
        this.handlers.onStartSessionOnly();
      }
    });

    this.el.notifyPermissionBtn.addEventListener('click', () => {
      if (this.handlers.onRequestNotifications) {
        this.handlers.onRequestNotifications();
      }
    });

    this.el.simulateIncomingBtn.addEventListener('click', () => {
      if (this.handlers.onSimulateIncoming) {
        this.handlers.onSimulateIncoming();
      }
    });

    this.el.lockNowBtn.addEventListener('click', () => {
      if (this.handlers.onLockNow) {
        this.handlers.onLockNow();
      }
    });
  }

  setSidebarBehaviorEnabled(enabled) {
    this.sidebarBehaviorEnabled = enabled;
    this.el.sidebarBehaviorToggle.checked = enabled;

    if (!enabled) {
      this.doc.body.classList.add('sidebar-pinned');
      this.el.sidebar.classList.remove('open');
      this.el.sidebarOverlay.classList.add('hidden');
      return;
    }

    this.doc.body.classList.remove('sidebar-pinned');
    this.closeSidebar();
  }

  openSidebar() {
    if (!this.sidebarBehaviorEnabled) return;
    this.el.sidebar.classList.add('open');
    this.el.sidebarOverlay.classList.remove('hidden');
  }

  closeSidebar() {
    this.el.sidebar.classList.remove('open');
    this.el.sidebarOverlay.classList.add('hidden');
  }

  renderChats(chats, activeChatId, unreadByChat, previewsByChat) {
    this.el.chatList.innerHTML = '';

    for (const chat of chats) {
      const unread = unreadByChat.get(chat.id) || 0;
      const preview = previewsByChat.get(chat.id) || 'No messages yet';

      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = 'chat-item';
      button.dataset.chatId = chat.id;
      if (chat.id === activeChatId) {
        button.classList.add('active');
      }

      const main = this.doc.createElement('span');
      main.className = 'chat-main';

      const label = this.doc.createElement('span');
      label.className = 'chat-main-name';
      label.textContent = chat.name;

      const sub = this.doc.createElement('span');
      sub.className = 'chat-main-sub';
      sub.textContent = preview;

      main.appendChild(label);
      main.appendChild(sub);
      button.appendChild(main);

      if (unread > 0) {
        const badge = this.doc.createElement('span');
        badge.className = 'unread-pill';
        badge.textContent = String(unread);
        button.appendChild(badge);
      }

      this.el.chatList.appendChild(button);
    }
  }

  setActiveChat(chat, totalCount) {
    if (!chat) {
      this.el.activeChatName.textContent = 'Secure Local Chat';
      this.el.activeChatMeta.textContent = 'AES-256-GCM encrypted storage in IndexedDB';
      return;
    }

    this.el.activeChatName.textContent = chat.name;
    this.el.activeChatMeta.textContent = `${totalCount} encrypted messages in this chat`;
  }

  renderMessages(messages, onDeleteMessage) {
    const list = this.el.messageList;
    if (!list) return;

    const wasNearBottom = this.isMessageListNearBottom();
    const previousScrollHeight = list.scrollHeight;
    const previousScrollTop = list.scrollTop;

    list.innerHTML = '';

    if (!messages.length) {
      const empty = this.doc.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No messages yet. Send one or use Sim Incoming to test unread counters.';
      list.appendChild(empty);
      list.scrollTop = 0;
      return;
    }

    for (const message of messages) {
      const item = this.doc.createElement('article');
      item.className = `message ${message.direction === 'in' ? 'in' : 'out'}`;

      if (message.kind === 'voice' && message.audioData) {
        item.appendChild(this.createVoiceCard(message));
      } else {
        const text = this.doc.createElement('div');
        text.className = 'message-text';
        text.textContent = message.text || '';
        item.appendChild(text);
      }

      const meta = this.doc.createElement('div');
      meta.className = 'message-meta';

      const left = this.doc.createElement('span');
      const sentAt = message.createdAt ? new Date(message.createdAt) : new Date();
      left.textContent = `${message.direction === 'in' ? 'Incoming' : 'Outgoing'} • ${sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      const del = this.doc.createElement('button');
      del.className = 'message-delete';
      del.type = 'button';
      del.textContent = 'Secure delete';
      del.addEventListener('click', () => onDeleteMessage(message.id));

      meta.appendChild(left);
      meta.appendChild(del);
      item.appendChild(meta);
      list.appendChild(item);
    }

    if (wasNearBottom) {
      this.scrollMessageListToBottom();
    } else if (previousScrollHeight) {
      list.scrollTop = Math.max(0, previousScrollTop + (list.scrollHeight - previousScrollHeight));
    }
  }

  isMessageListNearBottom(threshold = 48) {
    const list = this.el.messageList;
    if (!list) return true;
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    return remaining <= threshold;
  }

  scrollMessageListToBottom(smooth = false) {
    const list = this.el.messageList;
    if (!list) return;
    const scroll = () => list.scrollTo({
      top: list.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
    scroll();
    requestAnimationFrame(scroll);
    setTimeout(scroll, 0);
  }

  createVoiceCard(message) {
    const wrapper = this.doc.createElement('div');
    wrapper.className = 'voice-card';

    const audio = this.doc.createElement('audio');
    audio.preload = 'metadata';
    audio.src = message.audioData;

    const controls = this.doc.createElement('div');
    controls.className = 'voice-controls';

    const backBtn = this.doc.createElement('button');
    backBtn.type = 'button';
    backBtn.textContent = '-10s';

    const playBtn = this.doc.createElement('button');
    playBtn.type = 'button';
    playBtn.textContent = 'Play';

    const fwdBtn = this.doc.createElement('button');
    fwdBtn.type = 'button';
    fwdBtn.textContent = '+10s';

    const progress = this.doc.createElement('input');
    progress.type = 'range';
    progress.min = '0';
    progress.max = '1000';
    progress.value = '0';

    const time = this.doc.createElement('span');
    time.className = 'voice-time';
    time.textContent = '0:00 / 0:00';

    const syncLabel = () => {
      const total = Number.isFinite(audio.duration) ? audio.duration : 0;
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const progressValue = total > 0 ? Math.round((current / total) * 1000) : 0;
      progress.value = String(progressValue);
      time.textContent = `${formatClock(current)} / ${formatClock(total || message.durationSec || 0)}`;
    };

    const setPlayLabel = () => {
      playBtn.textContent = audio.paused ? 'Play' : 'Pause';
    };

    playBtn.addEventListener('click', async () => {
      if (audio.paused) {
        if (this.activeVoiceAudio && this.activeVoiceAudio !== audio) {
          this.activeVoiceAudio.pause();
        }

        try {
          await audio.play();
          this.activeVoiceAudio = audio;
        } catch (_) {
          time.textContent = 'Playback blocked';
        }
      } else {
        audio.pause();
      }
      setPlayLabel();
    });

    backBtn.addEventListener('click', () => {
      audio.currentTime = Math.max(0, (audio.currentTime || 0) - 10);
      syncLabel();
    });

    fwdBtn.addEventListener('click', () => {
      const total = Number.isFinite(audio.duration) ? audio.duration : Math.max(0, message.durationSec || 0);
      audio.currentTime = Math.min(total, (audio.currentTime || 0) + 10);
      syncLabel();
    });

    progress.addEventListener('input', () => {
      const total = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (!total) return;
      const ratio = Number(progress.value) / 1000;
      audio.currentTime = ratio * total;
      syncLabel();
    });

    audio.addEventListener('loadedmetadata', syncLabel);
    audio.addEventListener('timeupdate', syncLabel);
    audio.addEventListener('play', setPlayLabel);
    audio.addEventListener('pause', setPlayLabel);
    audio.addEventListener('ended', () => {
      this.activeVoiceAudio = null;
      syncLabel();
      setPlayLabel();
    });
    audio.addEventListener('error', () => {
      time.textContent = 'Audio unavailable';
    });

    controls.appendChild(backBtn);
    controls.appendChild(playBtn);
    controls.appendChild(fwdBtn);
    controls.appendChild(progress);
    controls.appendChild(time);

    wrapper.appendChild(controls);
    wrapper.appendChild(audio);
    return wrapper;
  }

  getMessageDraft() {
    return this.el.messageInput.value || '';
  }

  clearMessageDraft() {
    this.el.messageInput.value = '';
  }

  focusInput() {
    this.el.messageInput.focus();
  }

  setRecordingState(isRecording) {
    this.el.recordVoiceBtn.classList.toggle('recording', isRecording);
    this.el.voiceRecorderPanel.classList.toggle('hidden', !isRecording);
    this.el.recordVoiceBtn.textContent = isRecording ? '⏺' : '🎤';
  }

  updateVoiceTimer(seconds) {
    this.el.voiceTimer.textContent = formatClock(seconds);
  }

  showLockOverlay({ hasWrappedKey }) {
    this.el.lockOverlay.classList.remove('hidden');
    this.el.lockPasswordInput.value = '';
    this.el.lockStatus.textContent = '';
    this.el.lockStatus.classList.remove('error');

    if (hasWrappedKey) {
      this.el.lockTitle.textContent = 'Unlock Existing Vault';
      this.el.sessionKeyButton.classList.add('hidden');
      this.el.lockPasswordInput.placeholder = 'Enter password';
    } else {
      this.el.lockTitle.textContent = 'Create / Unlock Vault';
      this.el.sessionKeyButton.classList.remove('hidden');
      this.el.lockPasswordInput.placeholder = 'Password (optional for persistence)';
    }

    this.el.lockPasswordInput.focus();
  }

  hideLockOverlay() {
    this.el.lockOverlay.classList.add('hidden');
    this.el.lockStatus.textContent = '';
    this.el.lockStatus.classList.remove('error');
  }

  setLockStatus(message, isError = false) {
    this.el.lockStatus.textContent = message || '';
    this.el.lockStatus.classList.toggle('error', isError);
  }

  showSecurityWarning(message) {
    this.el.securityWarning.textContent = message;
    this.el.securityWarning.classList.remove('hidden');
  }
}
