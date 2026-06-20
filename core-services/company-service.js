const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { InvokeCommand } = require('@aws-sdk/client-lambda');

/**
 * VERY SIMPLE FIELD FILTER
 * Only blocks admin-only fields for non-admin users
 */

const BASE_UPDATABLE_FIELDS = [
    'name',
    'legal_name',
    'tax_id',
    'license_number',
    'dot_number',
    'google_business_url',
    'description',
    'address_line1',
    'address_line2',
    'address_city',
    'address_state',
    'address_postal_code',
    'address_country',
    'icon_key',
    'icon_key_dark',
    'logo_key',
    'logo_key_dark',
    'business_activities'
  ];
  
  const ADMIN_ONLY_FIELDS = [
    'platform_fee_pct',
    'preferred_provider',
    'veteran_owned',
  ];
  
function filterCompanyUpdate(actor, payload) {
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
    const expressionAttributeNames = {
      '#updated_at': 'updated_at'
    };
    const expressionAttributeValues = {
      ':updated_at': now
    };
  
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
  
async function getCompanyById(companyId, context = {}) {
  const {
    dynamodb,
    tables,
    mediaBaseUrl,
    actor = 'user'
  } = context;

  const { COMPANY_TABLE_NAME } = tables;

  // Fetch company
  const result = await dynamodb.send(
    new GetCommand({
      TableName: COMPANY_TABLE_NAME,
      Key: { id: companyId }
    })
  );

  if (!result.Item) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const item = result.Item;

  // Normalize business_activities
  const businessActivities = item.business_activities
    ? (item.business_activities instanceof Set
      ? Array.from(item.business_activities)
      : Array.isArray(item.business_activities)
        ? item.business_activities
        : [])
    : [];

  const company = {
    ...item,
    business_activities: businessActivities,
    icon_url: item.icon_key ? `${mediaBaseUrl}/${item.icon_key}` : null,
    icon_url_dark: item.icon_key_dark ? `${mediaBaseUrl}/${item.icon_key_dark}` : null,
    logo_url: item.logo_key ? `${mediaBaseUrl}/${item.logo_key}` : null,
    logo_url_dark: item.logo_key_dark ? `${mediaBaseUrl}/${item.logo_key_dark}` : null,
  };

  return company;
}

/**
 * Main update function
 */
async function updateCompany(companyId, payload, context) {
    const {
        dynamodb,
        lambda,
        tables,
        actor,
        googlePlaceProcessorArn
    } = context;

    const updates = filterCompanyUpdate(actor, payload);

    if (Object.keys(updates).length === 0) {
        const err = new Error('NO_VALID_FIELDS');
        err.code = 'NO_VALID_FIELDS';
        throw err;
    }

    // Check Google URL change
    let previousGoogleUrl = null;
    const shouldProcessGooglePlace = updates.google_business_url !== undefined;

    if (shouldProcessGooglePlace) {
        const existingCompany = await dynamodb.send(new GetCommand({
        TableName: tables.COMPANY_TABLE_NAME,
        Key: { id: companyId }
        }));

        previousGoogleUrl = existingCompany.Item?.google_business_url;
    }

    const {
        UpdateExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues
    } = buildUpdateExpression(updates);

    const result = await dynamodb.send(new UpdateCommand({
        TableName: tables.COMPANY_TABLE_NAME,
        Key: { id: companyId },
        UpdateExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
        ConditionExpression: 'attribute_exists(id)',
        ReturnValues: 'ALL_NEW'
    }));

    // Trigger Google Place processing
    if (
        shouldProcessGooglePlace &&
        updates.google_business_url &&
        updates.google_business_url !== previousGoogleUrl &&
        googlePlaceProcessorArn
    ) {
        try {
        await lambda.send(new InvokeCommand({
            FunctionName: googlePlaceProcessorArn,
            InvocationType: 'Event',
            Payload: JSON.stringify({
            companyId,
            googleBusinessUrl: updates.google_business_url
            })
        }));
        } catch (err) {
        console.error('Google Place invoke failed (non-blocking)', err);
        }
    }

    return result.Attributes;
}

module.exports = {
  getCompanyById,
  updateCompany
};