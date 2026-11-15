const fs = require('node:fs/promises');
const path = require('node:path');

function categoriesFor(event) {
  const raw = Array.isArray(event?.categories) && event.categories.length
    ? event.categories : (event?.category ? [event.category] : []);
  return [...new Set(raw.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function categoryScores(swipes) {
  const scores = Object.create(null);
  for (const swipe of swipes) {
    const weight = swipe.choice === 'right' ? 1 : swipe.choice === 'left' ? -1 : 0;
    if (!weight) continue;
    for (const category of new Set(swipe.categories || [])) {
      if (typeof category === 'string' && category) scores[category] = (scores[category] || 0) + weight;
    }
  }
  return scores;
}

function eventScore(event, scores) {
  const categories = categoriesFor(event);
  if (!categories.length) return 0;
  return categories.reduce((sum, category) => sum + (scores[category] || 0), 0) / categories.length;
}

function rankEvents(events, scores) {
  return [...events].sort((a, b) =>
    eventScore(b, scores) - eventScore(a, scores) || Number(a.date) - Number(b.date) || String(a.id).localeCompare(String(b.id)));
}

function createSwipeStore({ dataDir } = {}) {
  if (!dataDir) throw new Error('dataDir is required for recommendation storage');
  const file = path.join(dataDir, 'swipes.json');
  let queue = Promise.resolve();

  async function readAll() {
    try {
      const rows = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('Invalid swipes.json: expected an array');
      return rows;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function change(fn) {
    const next = queue.then(async () => {
      const rows = await readAll();
      const result = fn(rows);
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
      await fs.rename(tmp, file);
      return result;
    });
    queue = next.catch(() => {});
    return next;
  }

  return {
    mode: 'local-file',
    async list(userId) {
      await queue;
      return (await readAll()).filter(row => row.userId === userId)
        .map(({ eventId, choice, categories }) => ({ eventId, choice, categories }));
    },
    put(userId, event, choice, onlyIfAbsent = false) {
      return change(rows => {
        const i = rows.findIndex(row => row.userId === userId && row.eventId === event.id);
        if (onlyIfAbsent && i >= 0) return false;
        if (choice === 'left' && i >= 0 && rows[i].choice !== 'left') return false;
        const row = {
          userId, eventId: event.id, choice,
          categories: choice === 'cancelled' ? [] : categoriesFor(event), updatedAt: Date.now()
        };
        if (i >= 0) rows[i] = row; else rows.push(row);
        return true;
      });
    },
    undo(userId, eventId) {
      return change(rows => {
        const i = rows.findIndex(row => row.userId === userId && row.eventId === eventId && row.choice === 'left');
        if (i < 0) return false;
        rows.splice(i, 1);
        return true;
      });
    }
  };
}

module.exports = { createSwipeStore, categoriesFor, categoryScores, eventScore, rankEvents };
