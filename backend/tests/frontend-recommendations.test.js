const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../public/EventSwipe.html'), 'utf8');
const start = html.indexOf('const store = {');
const end = html.indexOf('\n};', start) + 3;
if (start < 0 || end < 3) throw new Error('Could not extract frontend store code');
const code = html.slice(start, end);

function createStore() {
  const cache = new Map();
  const requests = [];
  const context = {
    sessionUser: { id: 'test-user' },
    query: '',
    restoredEventId: null,
    eventCategories: event => event.categories || [event.category],
    localStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) },
    apiRequest: async (url, options = {}) => {
      requests.push([url, options.method]);
      if (url.endsWith('/pass') && options.method === 'DELETE') return { undone: true };
      if (url.endsWith('/pass')) return { choice: 'left' };
      if (url.endsWith('/interest') && options.method === 'DELETE') return { interestCount: 0 };
      if (url.endsWith('/interest')) return { interestCount: 1 };
      throw new Error('Unexpected mocked API: ' + url);
    },
    toast: () => { throw new Error('Unexpected toast'); },
    document: { createTextNode: x => x },
    Date, Set, JSON, Object, String, Number, Math
  };
  vm.runInNewContext(code + '\nglobalThis.testStore = store;', context);
  return { store: context.testStore, requests };
}

test('Discover reorders immediately when user likes or passes categories; multi-tags all score', async () => {
  const {store,requests} = createStore();
  const base=Date.now()+86400000;
  store.events = [
    {id:'sports',categories:['Sports'],date:base,title:'Sports'},
    {id:'coding',categories:['Computer Science','Engineering'],date:base+1000,title:'Coding'},
    {id:'food',categories:['Free Food'],date:base+2000,title:'Food'}
  ];
  assert.equal(store.feed()[0].id,'sports');
  await store.pass('sports');
  assert.equal(store.categoryScores.Sports,-1);
  assert.equal(store.feed()[0].id,'coding');
  assert.equal(store.seen.includes('sports'),true);
  await store.addInterest('coding');
  assert.equal(store.categoryScores['Computer Science'],1);
  assert.equal(store.categoryScores.Engineering,1);
  await store.undoPass('sports');
  assert.equal(store.categoryScores.Sports,undefined);
  assert.equal(store.seen.includes('sports'),false);
  await store.cancelInterest('coding');
  assert.equal(store.categoryScores.Engineering,undefined);
  assert.equal(store.seen.includes('coding'),true);
  assert.ok(requests.some(([url, method])=>url==='/api/events/sports/pass'&&method==='POST'));
  assert.ok(requests.some(([url, method])=>url==='/api/events/sports/pass'&&method==='DELETE'));
});
