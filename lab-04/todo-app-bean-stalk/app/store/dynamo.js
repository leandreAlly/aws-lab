const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

function createDynamoStore({ tableName, region }) {
  if (!tableName) {
    throw new Error('TODO_TABLE_NAME is not set');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    kind: 'dynamodb',
    tableName,

    async list() {
      const { Items = [] } = await client.send(new ScanCommand({ TableName: tableName }));
      return Items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },

    async create(todo) {
      await client.send(new PutCommand({ TableName: tableName, Item: todo }));
      return todo;
    },

    async toggle(id, done) {
      const { Attributes } = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: 'SET #done = :done',
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: { '#done': 'done' },
          ExpressionAttributeValues: { ':done': done },
          ReturnValues: 'ALL_NEW',
        })
      );
      return Attributes;
    },

    async remove(id) {
      const { Attributes } = await client.send(
        new DeleteCommand({ TableName: tableName, Key: { id }, ReturnValues: 'ALL_OLD' })
      );
      return Attributes;
    },

    async check() {
      await client.send(new ScanCommand({ TableName: tableName, Limit: 1 }));
      return { table: tableName, reachable: true };
    },
  };
}

module.exports = { createDynamoStore };
