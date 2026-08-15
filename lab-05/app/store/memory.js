function createMemoryStore() {
  const items = new Map();

  return {
    kind: 'memory',
    tableName: null,

    async list() {
      return [...items.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },

    async create(todo) {
      items.set(todo.id, todo);
      return todo;
    },

    async toggle(id, done) {
      const existing = items.get(id);
      if (!existing) {
        const error = new Error('not found');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      const updated = { ...existing, done };
      items.set(id, updated);
      return updated;
    },

    async remove(id) {
      const existing = items.get(id);
      items.delete(id);
      return existing;
    },

    async check() {
      return { table: null, reachable: true };
    },
  };
}

module.exports = { createMemoryStore };
