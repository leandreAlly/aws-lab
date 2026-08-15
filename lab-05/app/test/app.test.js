const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const { createMemoryStore } = require('../store/memory');

function withServer(run) {
  return async () => {
    const server = createApp({ store: createMemoryStore() }).listen(0);
    const { port } = server.address();
    const call = (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options);

    try {
      await run(call);
    } finally {
      server.close();
    }
  };
}

const asJson = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('health endpoint reports a version', withServer(async (call) => {
  const response = await call('/health');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(body.versionLabel);
}));

test('todos start empty', withServer(async (call) => {
  const body = await (await call('/api/todos')).json();
  assert.deepEqual(body.items, []);
}));

test('a created todo is listed back', withServer(async (call) => {
  const created = await (await call('/api/todos', asJson({ title: 'ship the lab' }))).json();
  assert.equal(created.done, false);
  assert.ok(created.id);

  const body = await (await call('/api/todos')).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].title, 'ship the lab');
}));

test('a blank title is rejected', withServer(async (call) => {
  const response = await call('/api/todos', asJson({ title: '   ' }));
  assert.equal(response.status, 400);
}));

test('a todo can be completed and deleted', withServer(async (call) => {
  const created = await (await call('/api/todos', asJson({ title: 'toggle me' }))).json();

  const toggled = await call(`/api/todos/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done: true }),
  });
  assert.equal(toggled.status, 200);
  assert.equal((await toggled.json()).done, true);

  assert.equal((await call(`/api/todos/${created.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/todos/${created.id}`, { method: 'DELETE' })).status, 404);
}));

test('toggling a missing todo is a 404', withServer(async (call) => {
  const response = await call('/api/todos/does-not-exist', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done: true }),
  });

  assert.equal(response.status, 404);
}));
