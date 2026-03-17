const SENSITIVE_KEYS = new Set([
  'text',
  'audioData',
  'ciphertext',
  'plaintext',
  'password',
  'wrappedKeyB64',
  'saltB64',
  'ivB64'
]);

function redactValue(value) {
  if (typeof value === 'string') {
    if (value.length > 90) {
      return `[redacted:${value.length}chars]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === 'object') {
    const clone = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) {
        clone[key] = '[redacted]';
      } else {
        clone[key] = redactValue(val);
      }
    }
    return clone;
  }

  return value;
}

export class SecurityManager {
  constructor({ inactivityMs = 5 * 60 * 1000 } = {}) {
    this.inactivityMs = inactivityMs;
    this.lastActivityAt = Date.now();
    this.activityTimer = null;
    this.devToolsTimer = null;
    this.boundReset = this.resetInactivity.bind(this);
    this.devtoolsWarningShown = false;
  }

  hardenConsole() {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    for (const method of methods) {
      if (typeof console[method] !== 'function') continue;
      const nativeFn = console[method].bind(console);
      console[method] = (...args) => {
        const safeArgs = args.map((arg) => redactValue(arg));
        nativeFn(...safeArgs);
      };
    }
  }

  ensureNoSensitiveLocalStorage() {
    try {
      const suspicious = ['chat', 'message', 'voice', 'key', 'cipher', 'token', 'password'];
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        const lower = key.toLowerCase();
        if (suspicious.some((term) => lower.includes(term))) {
          localStorage.removeItem(key);
        }
      }
    } catch (_) {
      // Access can fail in strict browser modes; ignore safely.
    }
  }

  startInactivityMonitor(onLock) {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'focus'];
    events.forEach((eventName) => window.addEventListener(eventName, this.boundReset, { passive: true }));

    this.activityTimer = window.setInterval(() => {
      const idleFor = Date.now() - this.lastActivityAt;
      if (idleFor >= this.inactivityMs) {
        this.lastActivityAt = Date.now();
        if (typeof onLock === 'function') {
          onLock();
        }
      }
    }, 1000);
  }

  stopInactivityMonitor() {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'focus'];
    events.forEach((eventName) => window.removeEventListener(eventName, this.boundReset));
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  resetInactivity() {
    this.lastActivityAt = Date.now();
  }

  startDevToolsMonitor(onDetected) {
    this.devToolsTimer = window.setInterval(() => {
      const widthGap = Math.abs(window.outerWidth - window.innerWidth);
      const heightGap = Math.abs(window.outerHeight - window.innerHeight);

      const probeStart = performance.now();
      // eslint-disable-next-line no-debugger
      debugger;
      const probeDelay = performance.now() - probeStart;

      const detected = widthGap > 170 || heightGap > 170 || probeDelay > 140;
      if (detected && !this.devtoolsWarningShown) {
        this.devtoolsWarningShown = true;
        if (typeof onDetected === 'function') {
          onDetected();
        }
      }
    }, 1800);
  }

  stopDevToolsMonitor() {
    if (this.devToolsTimer) {
      clearInterval(this.devToolsTimer);
      this.devToolsTimer = null;
    }
  }
}
