// 求人と巡回状態の保存先。AWS では DynamoDB、手元の検証ではJSONファイル。
// テーブルは pk/sk の1枚：求人 = (site#<site>, <uid>)、状態 = (state, <key>)。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function createFileStore(file) {
  let cache = null;
  const load = async () => {
    if (cache) return cache;
    try { cache = JSON.parse(await readFile(file, 'utf8')); } catch { cache = { jobs: {}, state: {} }; }
    return cache;
  };
  const save = async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache, null, 1));
  };
  return {
    async getJobs(site) {
      const db = await load();
      return new Map(Object.values(db.jobs).filter((j) => j.site === site).map((j) => [j.uid, j]));
    },
    async putJobs(items) {
      const db = await load();
      for (const it of items) db.jobs[it.uid] = it;
      await save();
    },
    async getState(key) { return (await load()).state[key] ?? null; },
    async putState(key, value) { (await load()).state[key] = value; await save(); },
  };
}

export async function createDynamoStore(table) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, GetCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

  return {
    async getJobs(site) {
      const out = new Map();
      let ExclusiveStartKey;
      do {
        const r = await db.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `site#${site}` }, ExclusiveStartKey,
        }));
        for (const it of r.Items || []) out.set(it.uid, it);
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async putJobs(items) {
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25).map((it) => ({ PutRequest: { Item: { pk: `site#${it.site}`, sk: it.uid, ...it } } }));
        let req = { [table]: chunk };
        for (let tries = 0; req && Object.keys(req).length && tries < 5; tries += 1) {
          const r = await db.send(new BatchWriteCommand({ RequestItems: req }));
          req = r.UnprocessedItems;
        }
      }
    },
    async getState(key) {
      const r = await db.send(new GetCommand({ TableName: table, Key: { pk: 'state', sk: key } }));
      return r.Item?.value ?? null;
    },
    async putState(key, value) {
      await db.send(new PutCommand({ TableName: table, Item: { pk: 'state', sk: key, value } }));
    },
  };
}
