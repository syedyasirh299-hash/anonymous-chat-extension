import { EncryptionManager } from './encryption.js';
import { SecureDatabase } from './database.js';
import { SecurityManager } from './security.js';
import { ChatUI } from './ui.js';

class SecureChatApp {
  constructor(doc) {
    this.doc = doc;
    this.ui = new ChatUI(doc);
    this.db = new SecureDatabase();
    this.encryption = new EncryptionManager();
    this.security = new SecurityManager({ inactivityMs: 5 * 60 * 1000 });

    this.chats = [
      { id: 'ops', name: 'Ops Team' },
      { id: 'blue', name: 'Blue Team' },
      { id: 'intel', name: 'Threat Intel' }
    ];

    this.activeChatId = this.chats[0].id;
    this.messages = [];
    this.unreadByChat = new Map(this.chats.map((chat) => [chat.id, 0]));

    this.wrappedKeyRecord = null;
    this.locked = true;

    this.mediaRecorder = null;
    this.recordingStream = null;
    this.recordedChunks = [];
    this.recordingStartedAt = 0;
    this.recordingShouldSend = false;
    this.recordTimer = null;

    this.previewSnippets = [
      'Inbound check complete.',
      'IOC list refreshed.',
      'Meeting in 10 minutes.',
      'Deploy patch window at 20:00 UTC.',
      'Need quick review on indicator set.'
    ];
  }

  async init() {
    await this.db.init();
    this.wrappedKeyRecord = await this.db.getMeta('wrapped-key');

    this.security.hardenConsole();
    this.security.ensureNoSensitiveLocalStorage();
    this.security.startDevToolsMonitor(() => {
      this.ui.showSecurityWarning('DevTools detected. Avoid exposing sensitive content on shared screens.');
    });
    this.security.startInactivityMonitor(() => {
      this.lockVault('Auto-locked after 5 minutes of inactivity.');
    });

    this.ui.bindHandlers({
      onSidebarBehaviorToggle: () => {},
      onChatSelect: (chatId) => this.openChat(chatId),
      onSendText: () => this.sendTextMessage(),
      onStartVoiceRecording: () => this.startVoiceRecording(),
      onStopVoiceRecording: (shouldSend) => this.stopVoiceRecording(shouldSend),
      onUnlock: (password) => this.unlockFlow(password),
      onStartSessionOnly: () => this.startSessionOnly(),
      onRequestNotifications: () => this.requestNotificationPermission(),
      onSimulateIncoming: () => this.simulateIncomingMessage(),
      onLockNow: () => this.lockVault('Vault locked. Enter password or session key mode to continue.')
    });

    this.ui.setSidebarBehaviorEnabled(true);
    this.render();
    this.ui.showLockOverlay({ hasWrappedKey: Boolean(this.wrappedKeyRecord) });
  }

  getActiveChat() {
    return this.chats.find((chat) => chat.id === this.activeChatId) || null;
  }

  getMessagesForChat(chatId) {
    return this.messages
      .filter((message) => message.chatId === chatId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  buildPreviewMap() {
    const preview = new Map();
    for (const chat of this.chats) {
      const rows = this.getMessagesForChat(chat.id);
      const latest = rows.length ? rows[rows.length - 1] : null;
      if (!latest) {
        preview.set(chat.id, 'No messages yet');
      } else if (latest.kind === 'voice') {
        preview.set(chat.id, '🎤 Voice message');
      } else {
        preview.set(chat.id, latest.text || 'Encrypted message');
      }
    }
    return preview;
  }

  render() {
    const previewMap = this.buildPreviewMap();
    this.ui.renderChats(this.chats, this.activeChatId, this.unreadByChat, previewMap);

    const activeChat = this.getActiveChat();
    const activeMessages = this.locked ? [] : this.getMessagesForChat(this.activeChatId);
    this.ui.setActiveChat(activeChat, activeMessages.length);
    this.ui.renderMessages(activeMessages, (messageId) => this.secureDeleteMessage(messageId));
  }

  async unlockFlow(passwordInput) {
    const password = (passwordInput || '').trim();

    try {
      if (this.wrappedKeyRecord) {
        if (!password) {
          this.ui.setLockStatus('Password is required to unlock this vault.', true);
          return;
        }
        await this.encryption.unlockWithPassword(password, this.wrappedKeyRecord);
      } else {
        await this.encryption.generateDataKey();
        if (password) {
          const wrapped = await this.encryption.wrapActiveKeyWithPassword(password);
          await this.db.setMeta('wrapped-key', wrapped);
          this.wrappedKeyRecord = wrapped;
        }
      }
    } catch (_) {
      this.ui.setLockStatus('Unlock failed. Password may be incorrect.', true);
      return;
    }

    this.locked = false;
    await this.reloadMessagesFromDisk();
    this.ui.hideLockOverlay();
    this.ui.focusInput();
  }

  async startSessionOnly() {
    if (this.wrappedKeyRecord) {
      this.ui.setLockStatus('This vault is password protected. Use password unlock.', true);
      return;
    }

    await this.encryption.generateDataKey();
    this.locked = false;
    await this.reloadMessagesFromDisk();
    this.ui.hideLockOverlay();
    this.ui.focusInput();
  }

  async lockVault(statusMessage) {
    this.stopVoiceRecording(false);
    this.encryption.clearKeyFromMemory();
    this.locked = true;
    this.messages = [];
    this.render();
    this.ui.showLockOverlay({ hasWrappedKey: Boolean(this.wrappedKeyRecord) });
    this.ui.setLockStatus(statusMessage || 'Vault is locked.');
  }

  async reloadMessagesFromDisk() {
    const encryptedRows = await this.db.getAllEncryptedMessages();
    const decryptedRows = [];

    for (const row of encryptedRows) {
      if (!row || !row.payload) continue;
      try {
        const value = await this.encryption.decryptObject(row.payload);
        if (!value || typeof value !== 'object') continue;
        decryptedRows.push({
          id: row.id,
          chatId: value.chatId,
          direction: value.direction,
          kind: value.kind,
          text: value.text,
          audioData: value.audioData || '',
          durationSec: value.durationSec || 0,
          createdAt: value.createdAt
        });
      } catch (_) {
        // Skip undecryptable entries (e.g., wrong key material).
      }
    }

    this.messages = decryptedRows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const chat of this.chats) {
      if (!this.unreadByChat.has(chat.id)) {
        this.unreadByChat.set(chat.id, 0);
      }
    }

    this.render();
  }

  ensureUnlocked() {
    if (this.locked || !this.encryption.hasActiveKey()) {
      this.ui.showLockOverlay({ hasWrappedKey: Boolean(this.wrappedKeyRecord) });
      this.ui.setLockStatus('Unlock vault first.');
      return false;
    }
    return true;
  }

  async persistMessage(plainMessage) {
    const encrypted = await this.encryption.encryptObject(plainMessage);
    const id = await this.db.addEncryptedMessage(encrypted);
    const saved = { ...plainMessage, id };
    this.messages.push(saved);
    return saved;
  }

  createBaseMessage({ chatId, direction, kind, text = '', audioData = '', durationSec = 0 }) {
    return {
      chatId,
      direction,
      kind,
      text,
      audioData,
      durationSec,
      createdAt: Date.now()
    };
  }

  async sendTextMessage() {
    if (!this.ensureUnlocked()) return;

    const text = this.ui.getMessageDraft().trim();
    if (!text) return;

    const message = this.createBaseMessage({
      chatId: this.activeChatId,
      direction: 'out',
      kind: 'text',
      text
    });

    await this.persistMessage(message);
    this.ui.clearMessageDraft();
    this.render();
    // When the user sends a message, always bring the viewport to the latest bubble
    this.ui.scrollMessageListToBottom(true);
  }

  openChat(chatId) {
    if (!this.chats.some((chat) => chat.id === chatId)) return;
    this.activeChatId = chatId;
    this.unreadByChat.set(chatId, 0);
    this.render();
    this.ui.focusInput();
  }

  async simulateIncomingMessage() {
    if (!this.ensureUnlocked()) return;

    const otherChats = this.chats.filter((chat) => chat.id !== this.activeChatId);
    const targetChat = otherChats.length
      ? otherChats[Math.floor(Math.random() * otherChats.length)]
      : this.getActiveChat();

    const text = this.previewSnippets[Math.floor(Math.random() * this.previewSnippets.length)];
    const message = this.createBaseMessage({
      chatId: targetChat.id,
      direction: 'in',
      kind: 'text',
      text
    });

    await this.persistMessage(message);

    if (targetChat.id !== this.activeChatId) {
      const current = this.unreadByChat.get(targetChat.id) || 0;
      this.unreadByChat.set(targetChat.id, current + 1);
    }

    await this.notifyIncoming(targetChat, message);
    this.render();
  }

  async notifyIncoming(chat, message) {
    if (!message || message.direction !== 'in') return;

    this.playIncomingSound();

    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const body = message.kind === 'voice' ? '🎤 Voice message' : (message.text || 'New message');
    new Notification(`CipherTalk • ${chat.name}`, {
      body,
      tag: `chat-${chat.id}`,
      renotify: true,
      silent: false
    });
  }

  playIncomingSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const context = new AudioCtx();
      const output = context.createGain();
      output.gain.setValueAtTime(0.0001, context.currentTime);
      output.connect(context.destination);

      const notes = [
        { freq: 740, at: 0.0, dur: 0.09 },
        { freq: 988, at: 0.11, dur: 0.13 }
      ];

      for (const note of notes) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq, context.currentTime + note.at);

        gain.gain.setValueAtTime(0.0001, context.currentTime + note.at);
        gain.gain.exponentialRampToValueAtTime(0.11, context.currentTime + note.at + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + note.at + note.dur);

        osc.connect(gain);
        gain.connect(output);
        osc.start(context.currentTime + note.at);
        osc.stop(context.currentTime + note.at + note.dur + 0.02);
      }

      setTimeout(() => context.close(), 420);
    } catch (_) {
      // Silent fallback.
    }
  }

  async requestNotificationPermission() {
    if (!('Notification' in window)) {
      this.ui.showSecurityWarning('Notifications are not supported by this browser.');
      return;
    }

    if (Notification.permission === 'granted') {
      return;
    }

    try {
      await Notification.requestPermission();
    } catch (_) {
      // Ignore permission failures safely.
    }
  }

  async startVoiceRecording() {
    if (!this.ensureUnlocked()) return;
    if (this.mediaRecorder) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.ui.showSecurityWarning('Voice recording is unavailable in this browser context.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recordingStream = stream;
      this.recordedChunks = [];
      this.recordingShouldSend = false;
      this.recordingStartedAt = Date.now();

      this.mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.finalizeVoiceRecording();
      };

      this.mediaRecorder.start(200);
      this.ui.setRecordingState(true);
      this.ui.updateVoiceTimer(0);
      clearInterval(this.recordTimer);
      this.recordTimer = setInterval(() => {
        const elapsedSec = Math.max(0, Math.round((Date.now() - this.recordingStartedAt) / 1000));
        this.ui.updateVoiceTimer(elapsedSec);
      }, 400);
    } catch (_) {
      this.cleanupVoiceRecorder();
      this.ui.showSecurityWarning('Microphone permission denied or unavailable.');
    }
  }

  stopVoiceRecording(shouldSend) {
    if (!this.mediaRecorder) return;
    this.recordingShouldSend = Boolean(shouldSend);

    try {
      this.mediaRecorder.stop();
    } catch (_) {
      this.cleanupVoiceRecorder();
    }
  }

  async finalizeVoiceRecording() {
    const elapsedSec = Math.max(1, Math.round((Date.now() - this.recordingStartedAt) / 1000));
    const shouldSend = this.recordingShouldSend;
    const chunks = this.recordedChunks.slice();

    this.cleanupVoiceRecorder();

    if (!shouldSend || !chunks.length || !this.ensureUnlocked()) {
      return;
    }

    const blob = new Blob(chunks, { type: 'audio/webm' });
    const audioData = await this.blobToDataUrl(blob);

    const message = this.createBaseMessage({
      chatId: this.activeChatId,
      direction: 'out',
      kind: 'voice',
      text: '🎤 Voice message',
      audioData,
      durationSec: elapsedSec
    });

    await this.persistMessage(message);
    this.render();
    this.ui.scrollMessageListToBottom(true);
  }

  cleanupVoiceRecorder() {
    clearInterval(this.recordTimer);
    this.recordTimer = null;

    if (this.recordingStream) {
      for (const track of this.recordingStream.getTracks()) {
        track.stop();
      }
    }

    this.recordingStream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingStartedAt = 0;
    this.recordingShouldSend = false;

    this.ui.setRecordingState(false);
    this.ui.updateVoiceTimer(0);
  }

  blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
      reader.readAsDataURL(blob);
    });
  }

  async secureDeleteMessage(messageId) {
    if (!this.ensureUnlocked()) return;

    await this.db.secureDeleteMessage(messageId);
    this.messages = this.messages.filter((message) => message.id !== messageId);
    this.render();
  }
}

const app = new SecureChatApp(document);
app.init();
