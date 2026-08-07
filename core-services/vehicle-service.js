const crypto = require('crypto');
const { PutCommand, GetCommand, DeleteCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const VEHICLE_TYPES = require('./vehicle_types.json');
const VALID_TYPE_IDS = VEHICLE_TYPES.map(vt => vt.id);
const VALID_STATUSES = ['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'DECOMMISSIONED'];

const BASE_UPDATABLE_FIELDS = ['name', 'license_plate', 'capacity_cubic_meters', 'type', 'type_name', 'active', 'status'];

function filterVehicleUpdate(actor, payload) {
  const allowed = new Set(BASE_UPDATABLE_FIELDS);
  // No admin-only vehicle fields currently; both actors share the same set.
  // Actor parameter is accepted for future extensibility.
  void actor;

  const updates = {};
  for (const key of Object.keys(payload)) {
    if (allowed.has(key)) {
      updates[key] = payload[key];
    }
  }
  return updates;
}

function validateVehicleUpdates(updates) {
  if (updates.name !== undefined && !String(updates.name).trim()) {
    throw Object.assign(new Error('Vehicle name cannot be empty'), { code: 'INVALID_FIELD' });
  }
  if (updates.license_plate !== undefined && !String(updates.license_plate).trim()) {
    throw Object.assign(new Error('License plate cannot be empty'), { code: 'INVALID_FIELD' });
  }
  if (updates.capacity_cubic_meters !== undefined &&
      (typeof updates.capacity_cubic_meters !== 'number' || updates.capacity_cubic_meters < 0)) {
    throw Object.assign(new Error('Valid capacity in cubic meters is required (>= 0)'), { code: 'INVALID_FIELD' });
  }
  if (updates.type !== undefined && !VALID_TYPE_IDS.includes(updates.type)) {
    throw Object.assign(new Error(`Vehicle type must be one of: ${VALID_TYPE_IDS.join(', ')}`), { code: 'INVALID_FIELD' });
  }
  if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
    throw Object.assign(new Error(`Vehicle status must be one of: ${VALID_STATUSES.join(', ')}`), { code: 'INVALID_FIELD' });
  }
}

async function listVehicles(companyId, context) {
  const { dynamodb, tables } = context;
  const { VEHICLE_TABLE_NAME } = tables;

  const result = await dynamodb.send(new QueryCommand({
    TableName: VEHICLE_TABLE_NAME,
    IndexName: 'companyId-index',
    KeyConditionExpression: 'company_id = :companyId',
    ExpressionAttributeValues: { ':companyId': companyId }
  }));

  return result.Items || [];
}

async function getVehicle(companyId, vehicleId, context) {
  const { dynamodb, tables } = context;
  const { VEHICLE_TABLE_NAME } = tables;

  const result = await dynamodb.send(new GetCommand({
    TableName: VEHICLE_TABLE_NAME,
    Key: { id: vehicleId }
  }));

  if (!result.Item) {
    throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  }

  if (result.Item.company_id !== companyId) {
    throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
  }

  return result.Item;
}

async function createVehicle(companyId, payload, context) {
  const { dynamodb, tables } = context;
  const { VEHICLE_TABLE_NAME } = tables;

  const { name, license_plate, capacity_cubic_meters, type } = payload;

  if (!name || !String(name).trim()) {
    throw Object.assign(new Error('Vehicle name is required'), { code: 'INVALID_FIELD' });
  }
  if (!license_plate || !String(license_plate).trim()) {
    throw Object.assign(new Error('License plate is required'), { code: 'INVALID_FIELD' });
  }
  if (typeof capacity_cubic_meters !== 'number' || capacity_cubic_meters < 0) {
    throw Object.assign(new Error('Valid capacity in cubic meters is required (>= 0)'), { code: 'INVALID_FIELD' });
  }
  if (!type || !VALID_TYPE_IDS.includes(type)) {
    throw Object.assign(new Error(`Vehicle type must be one of: ${VALID_TYPE_IDS.join(', ')}`), { code: 'INVALID_FIELD' });
  }

  const typeEntry = VEHICLE_TYPES.find(vt => vt.id === type);
  const type_name = payload.type_name || (typeEntry ? typeEntry.value : type);

  const now = new Date().toISOString();
  const vehicle = {
    id: crypto.randomUUID(),
    company_id: companyId,
    name: String(name).trim(),
    license_plate: String(license_plate).trim(),
    capacity_cubic_meters,
    type,
    type_name,
    active: payload.active !== undefined ? Boolean(payload.active) : true,
    status: 'AVAILABLE',
    created_at: now,
    updated_at: now
  };

  await dynamodb.send(new PutCommand({
    TableName: VEHICLE_TABLE_NAME,
    Item: vehicle,
    ConditionExpression: 'attribute_not_exists(id)'
  }));

  return vehicle;
}

async function updateVehicle(companyId, vehicleId, payload, context) {
  const { dynamodb, tables, actor } = context;
  const { VEHICLE_TABLE_NAME } = tables;

  const rawUpdates = filterVehicleUpdate(actor, payload);

  if (Object.keys(rawUpdates).length === 0) {
    throw Object.assign(new Error('NO_VALID_FIELDS'), { code: 'NO_VALID_FIELDS' });
  }

  validateVehicleUpdates(rawUpdates);

  const updates = { ...rawUpdates };

  // Normalize string fields
  if (updates.name !== undefined) updates.name = String(updates.name).trim();
  if (updates.license_plate !== undefined) updates.license_plate = String(updates.license_plate).trim();
  if (updates.active !== undefined) updates.active = Boolean(updates.active);

  // Derive type_name when type changes
  if (updates.type !== undefined) {
    const typeEntry = VEHICLE_TYPES.find(vt => vt.id === updates.type);
    updates.type_name = payload.type_name || (typeEntry ? typeEntry.value : updates.type);
  }

  const now = new Date().toISOString();
  updates.updated_at = now;

  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = { ':companyId': companyId };

  let idx = 0;
  for (const [key, value] of Object.entries(updates)) {
    const nameKey = `#f${idx}`;
    const valueKey = `:v${idx}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
    updateExpressions.push(`${nameKey} = ${valueKey}`);
    idx++;
  }

  expressionAttributeNames['#company_id'] = 'company_id';

  const result = await dynamodb.send(new UpdateCommand({
    TableName: VEHICLE_TABLE_NAME,
    Key: { id: vehicleId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ConditionExpression: 'attribute_exists(id) AND #company_id = :companyId',
    ReturnValues: 'ALL_NEW'
  }));

  return result.Attributes;
}

async function deleteVehicle(companyId, vehicleId, context) {
  const { dynamodb, tables } = context;
  const { VEHICLE_TABLE_NAME } = tables;

  await dynamodb.send(new DeleteCommand({
    TableName: VEHICLE_TABLE_NAME,
    Key: { id: vehicleId },
    ConditionExpression: 'attribute_exists(id) AND company_id = :companyId',
    ExpressionAttributeValues: { ':companyId': companyId }
  }));
}

module.exports = {
  listVehicles,
  getVehicle,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  VEHICLE_TYPES,
  VALID_TYPE_IDS,
  VALID_STATUSES
};
