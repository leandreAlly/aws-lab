const { createApp } = require('./app');
const { createDynamoStore } = require('./store/dynamo');
const { createMemoryStore } = require('./store/memory');
const { getVersionInfo } = require('./version');

const port = process.env.PORT || 8080;
const tableName = process.env.TODO_TABLE_NAME;
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

const store = tableName ? createDynamoStore({ tableName, region }) : createMemoryStore();

if (!tableName) {
  console.warn('TODO_TABLE_NAME is not set - falling back to the in-memory store');
}

createApp({ store }).listen(port, () => {
  const { versionLabel, commit } = getVersionInfo();
  console.log(`todo-app listening on ${port} | store=${store.kind} | version=${versionLabel} | commit=${commit}`);
});
