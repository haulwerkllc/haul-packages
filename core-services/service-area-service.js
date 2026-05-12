const crypto = require('crypto');
const { PutCommand, GetCommand, DeleteCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const BASE_UPDATABLE_FIELDS = ['name', 'type', 'radius_km', 'geometry', 'active', 'center'];

const ADMIN_ONLY_FIELDS = ['municipality_id'];

function filterServiceAreaUpdate(actor, payload) {
  const allowed = new Set(BASE_UPDATABLE_FIELDS);

  if (actor === 'admin') {
    ADMIN_ONLY_FIELDS.forEach(f => allowed.add(f));
  }

  const updates = {};
  for (const key of Object.keys(payload)) {
    if (allowed.has(key)) {
      updates[key] = payload[key];
    }
  }
  return updates;
}

function buildUpdateExpression(updates) {
  const now = new Date().toISOString();

  const updateExpressions = ['#updated_at = :updated_at'];
  const expressionAttributeNames = { '#updated_at': 'updated_at' };
  const expressionAttributeValues = { ':updated_at': now };

  let index = 0;
  for (const [key, value] of Object.entries(updates)) {
    const nameKey = `#field${index}`;
    const valueKey = `:value${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
    updateExpressions.push(`${nameKey} = ${valueKey}`);
    index++;
  }

  return {
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues
  };
}

async function createServiceArea(companyId, payload, context) {
  const { dynamodb, tables } = context;
  const { SERVICE_AREA_TABLE_NAME } = tables;

  const now = new Date().toISOString();
  const serviceAreaId = crypto.randomUUID();

  const serviceArea = {
    id: serviceAreaId,
    company_id: companyId,
    name: payload.name.trim(),
    type: payload.type === 'municipality' ? 'municipality' : 'radius',
    center: {
      lat: payload.center_lat,
      lon: payload.center_lon ?? payload.center_lng
    },
    radius_km: payload.radius_km,
    active: payload.active !== undefined ? Boolean(payload.active) : true,
    created_at: now,
    updated_at: now
  };

  if (payload.type === 'municipality' && payload.geometry) {
    serviceArea.geometry = payload.geometry;
  }

  if (payload.municipality_id) {
    serviceArea.municipality_id = payload.municipality_id;
  }

  await dynamodb.send(
    new PutCommand({
      TableName: SERVICE_AREA_TABLE_NAME,
      Item: serviceArea,
      ConditionExpression: 'attribute_not_exists(id)'
    })
  );

  return serviceArea;
}

async function getServiceArea(companyId, serviceAreaId, context) {
  const { dynamodb, tables } = context;
  const { SERVICE_AREA_TABLE_NAME } = tables;

  const result = await dynamodb.send(
    new GetCommand({
      TableName: SERVICE_AREA_TABLE_NAME,
      Key: { id: serviceAreaId }
    })
  );

  if (!result.Item) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (result.Item.company_id !== companyId) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }

  return result.Item;
}

async function listServiceAreas(companyId, context) {
  const { dynamodb, tables } = context;
  const { SERVICE_AREA_TABLE_NAME } = tables;

  const result = await dynamodb.send(
    new QueryCommand({
      TableName: SERVICE_AREA_TABLE_NAME,
      IndexName: 'companyId-index',
      KeyConditionExpression: 'company_id = :companyId',
      ExpressionAttributeValues: {
        ':companyId': companyId
      }
    })
  );

  return result.Items;
}

async function updateServiceArea(companyId, serviceAreaId, payload, context) {
  const { dynamodb, tables, actor } = context;
  const { SERVICE_AREA_TABLE_NAME } = tables;

  const updates = filterServiceAreaUpdate(actor, payload);

  if (Object.keys(updates).length === 0) {
    const err = new Error('NO_VALID_FIELDS');
    err.code = 'NO_VALID_FIELDS';
    throw err;
  }

  const {
    UpdateExpression,
    ExpressionAttributeNames,
    ExpressionAttributeValues
  } = buildUpdateExpression(updates);

  ExpressionAttributeNames['#company_id'] = 'company_id';
  ExpressionAttributeValues[':companyId'] = companyId;

  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: SERVICE_AREA_TABLE_NAME,
      Key: { id: serviceAreaId },
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      ConditionExpression: 'attribute_exists(id) AND #company_id = :companyId',
      ReturnValues: 'ALL_NEW'
    })
  );

  return result.Attributes;
}

async function deleteServiceArea(companyId, serviceAreaId, context) {
  const { dynamodb, tables } = context;
  const { SERVICE_AREA_TABLE_NAME } = tables;

  await dynamodb.send(
    new DeleteCommand({
      TableName: SERVICE_AREA_TABLE_NAME,
      Key: { id: serviceAreaId },
      ConditionExpression: 'attribute_exists(id) AND company_id = :companyId',
      ExpressionAttributeValues: {
        ':companyId': companyId
      }
    })
  );
}

module.exports = {
  createServiceArea,
  getServiceArea,
  listServiceAreas,
  updateServiceArea,
  deleteServiceArea
};
