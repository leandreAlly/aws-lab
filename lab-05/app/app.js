const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const { getVersionInfo } = require('./version');

function createApp({ store }) {
  const app = express();
  const version = getVersionInfo();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', ...version });
  });

  app.get('/api/version', (req, res) => {
    res.json(version);
  });

  app.get('/api/health/store', async (req, res, next) => {
    try {
      res.json({ status: 'ok', store: store.kind, ...(await store.check()) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/todos', async (req, res, next) => {
    try {
      res.json({ items: await store.list(), store: store.kind });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/todos', async (req, res, next) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'title must be 200 characters or fewer' });
    }

    try {
      const todo = await store.create({
        id: crypto.randomUUID(),
        title,
        done: false,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(todo);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/todos/:id', async (req, res, next) => {
    if (typeof req.body?.done !== 'boolean') {
      return res.status(400).json({ error: 'done must be a boolean' });
    }

    try {
      res.json(await store.toggle(req.params.id, req.body.done));
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        return res.status(404).json({ error: 'todo not found' });
      }
      next(error);
    }
  });

  app.delete('/api/todos/:id', async (req, res, next) => {
    try {
      const removed = await store.remove(req.params.id);
      if (!removed) {
        return res.status(404).json({ error: 'todo not found' });
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
