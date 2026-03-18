const fs = require('fs');
const path = require('path');

class StatePersistence {
  constructor(filePath) {
    this.filePath = filePath;
    this.timer = null;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return { sessions: [], tokens: [] };
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return { sessions: [], tokens: [] };
      const parsed = JSON.parse(raw);
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      };
    } catch {
      return { sessions: [], tokens: [] };
    }
  }

  scheduleWrite(buildSnapshot, delayMs = 350) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(buildSnapshot);
    }, delayMs);
  }

  flush(buildSnapshot) {
    const snapshot = buildSnapshot();
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = {
  StatePersistence,
};
