const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSwipeStore, categoriesFor, categoryScores, eventScore, rankEvents } = require('../recommendations');

const events = [
  { id: 'c1', date: 200, category: 'Computer Science', categories: ['Computer Science', 'Engineering'] },
  { id: 'c2', date: 100, category: 'Computer Science', categories: ['Computer Science'] },
  { id: 's1', date: 90, category: 'Sports', categories: ['Sports'] },
  { id: 'x1', date: 1, category: 'Outdoors & Hiking', categories: ['Outdoors & Hiking'] }
];

test('all multi-selected categories each receive one vote, without duplicates', () => {
  assert.deepEqual(categoriesFor({ categories: ['Computer Science','Computer Science','Engineering'] }), ['Computer Science','Engineering']);
  const scores = categoryScores([
    { choice: 'right', categories: ['Computer Science','Engineering'] },
    { choice: 'left', categories: ['Sports'] },
    { choice: 'cancelled', categories: ['Sports'] }
  ]);
  assert.equal(scores['Computer Science'], 1);
  assert.equal(scores['Engineering'], 1);
  assert.equal(scores['Sports'], -1);
  assert.equal(eventScore(events[0], scores), 1);
  assert.deepEqual(rankEvents(events, scores).map(e=>e.id), ['c2','c1','x1','s1']);
});

test('local storage persists per account; duplicate passes do not stack; undo and cancelled revert points', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventswipe-votes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createSwipeStore({ dataDir: dir });
  assert.equal(await store.put('alice', events[0], 'left'), true);
  assert.equal(await store.put('alice', events[0], 'left'), true);
  assert.equal(await store.put('bob', events[0], 'right'), true);
  assert.equal((await store.list('alice')).length, 1);
  assert.equal(categoryScores(await store.list('alice'))['Computer Science'], -1);
  assert.equal(categoryScores(await store.list('bob'))['Computer Science'], 1);
  assert.equal(await store.undo('alice','c1'), true);
  assert.equal(await store.undo('alice','c1'), false);
  assert.deepEqual(await store.list('alice'), []);
  assert.equal(await store.put('alice', events[0], 'right'), true);
  assert.equal(await store.put('alice', events[0], 'right'), true);
  assert.equal(categoryScores(await store.list('alice'))['Engineering'], 1);
  assert.equal(await store.put('alice', events[0], 'left'), false);
  assert.equal(await store.put('alice', events[0], 'cancelled'), true);
  assert.equal(Object.keys(categoryScores(await store.list('alice'))).length, 0);
  assert.equal(await store.undo('alice','c1'), false);
  const restartedStore = createSwipeStore({ dataDir: dir });
  assert.equal((await restartedStore.list('alice'))[0].choice, 'cancelled');
});
