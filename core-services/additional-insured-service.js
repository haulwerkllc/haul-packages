/**
 * Additional-insured request service.
 *
 * Emails the ACORD 25 producer contact (producer_contact_email, parsed from
 * the company's INSURANCE document review_data) requesting that
 * "Haulwerk, LLC" be added as additional insured on the policy, once:
 *   - the producer contact email is present,
 *   - the policy meets Haul's GL minimums (review_data.meets_haul_minimums),
 *   - the company has authorized Haul to contact its insurer
 *     (Company.insurance_contact_authorized.accepted), and
 *   - the latest INSURANCE document is VERIFIED (and not expired).
 *
 * Sent once per policy term (same document_number + expires_at) unless
 * force=true (admin Send/Resend). Record lives as a single CompanyDocuments
 * item at sk=ADDITIONAL_INSURED — distinct from the DOCUMENT#{type}#{ts}
 * sort-key prefix every other reader queries, so this item is invisible to
 * them. A status-only rollup is kept on Company
 * (additional_insured_status / additional_insured_updated_at).
 *
 * In any environment other than "main", or whenever the company owner is a
 * test account, the email is rerouted to SUPPORT_EMAIL instead of the real
 * producer/owner addresses — this service must never send a real external
 * email outside of main.
 */

const { GetCommand, QueryCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SendEmailCommand } = require('@aws-sdk/client-ses');

const HAULWERK_LEGAL_NAME = 'Haulwerk, LLC';
const SUPPORT_EMAIL = 'support@haulwerk.com';

const AdditionalInsuredStatus = {
  REQUESTED: 'REQUESTED',
  REQUEST_FAILED: 'REQUEST_FAILED',
  CONFIRMED: 'CONFIRMED',
};

const AdditionalInsuredReason = {
  NO_PRODUCER_EMAIL: 'NO_PRODUCER_EMAIL',
  BELOW_MINIMUMS: 'BELOW_MINIMUMS',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  EXPIRED: 'EXPIRED',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  ALREADY_REQUESTED_THIS_TERM: 'ALREADY_REQUESTED_THIS_TERM',
  SEND_FAILED: 'SEND_FAILED',
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pure eligibility check. Does not look at any existing additional-insured
 * record — see isAlreadyRequestedThisTerm for the per-term guard.
 *
 * @param {object} params
 * @param {object|null} params.company - Company item (needs insurance_contact_authorized)
 * @param {object|null} params.document - latest INSURANCE CompanyDocuments item
 * @param {Date} [params.now]
 * @returns {{ eligible: boolean, reason: string|null }}
 */
function evaluateAdditionalInsuredEligibility({ company, document, now = new Date() }) {
  if (!document || document.document_type !== 'INSURANCE') {
    return { eligible: false, reason: AdditionalInsuredReason.NOT_VERIFIED };
  }

  if (document.review_status !== 'VERIFIED') {
    return { eligible: false, reason: AdditionalInsuredReason.NOT_VERIFIED };
  }

  if (document.expires_at && new Date(document.expires_at).getTime() <= now.getTime()) {
    return { eligible: false, reason: AdditionalInsuredReason.EXPIRED };
  }

  const reviewData = document.review_data || {};

  if (!reviewData.producer_contact_email) {
    return { eligible: false, reason: AdditionalInsuredReason.NO_PRODUCER_EMAIL };
  }

  if (reviewData.meets_haul_minimums !== true) {
    return { eligible: false, reason: AdditionalInsuredReason.BELOW_MINIMUMS };
  }

  if (company?.insurance_contact_authorized?.accepted !== true) {
    return { eligible: false, reason: AdditionalInsuredReason.NOT_AUTHORIZED };
  }

  return { eligible: true, reason: null };
}

/**
 * Pure per-term guard: an automatic (non-forced) trigger must not re-send
 * while the existing record already covers the same policy_number and
 * expires_at and was successfully sent (REQUESTED). A prior REQUEST_FAILED
 * for the same term does not block a retry.
 *
 * @param {object} params
 * @param {object|null} params.existingRecord - current ADDITIONAL_INSURED item, if any
 * @param {object} params.document - latest INSURANCE CompanyDocuments item
 * @param {boolean} params.force
 * @returns {boolean}
 */
function isAlreadyRequestedThisTerm({ existingRecord, document, force }) {
  if (force) return false;
  if (!existingRecord || existingRecord.status !== AdditionalInsuredStatus.REQUESTED) return false;

  const docPolicyNumber = document?.document_number ?? null;
  const docExpiresAt = document?.expires_at ?? null;

  return (
    existingRecord.policy_number === docPolicyNumber &&
    existingRecord.policy_expires_at === docExpiresAt
  );
}

/**
 * Build the templatized additional-insured request email.
 *
 * Greeting precedence: producer_contact_name, then producer_name, then
 * "Hi there,". Never issued_by (the carrier, not the agent/agency).
 *
 * @param {object} params
 * @param {string} params.companyLegalName
 * @param {string|null} params.producerContactName
 * @param {string|null} params.producerName
 * @param {string|null} [params.policyNumber]
 * @param {string} params.env - 'dev' | 'stage' | 'main'
 * @param {string|null} [params.footerNote] - appended when the send was rerouted
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildAdditionalInsuredRequestEmail({
  companyLegalName,
  producerContactName,
  producerName,
  policyNumber = null,
  env,
  footerNote = null,
}) {
  const greetingName = producerContactName || producerName || null;
  const greeting = greetingName ? `Hi ${greetingName},` : 'Hi there,';
  const subjectPrefix = env === 'main' ? '' : env === 'stage' ? '[STAGE] ' : '[DEV] ';
  const subject = `${subjectPrefix}Additional insured request${policyNumber ? ` | Policy #${policyNumber}` : ''}`;

  const bodyLines = [
    greeting,
    '',
    `Haul is a platform that connects customers with hauling companies. With ${companyLegalName}\u2019s authorization, we request additional insured status for claims arising from their work booked through Haul.`,
    '',
    `Please send the current COI and endorsement covering ${HAULWERK_LEGAL_NAME} under general liability policy #${policyNumber || 'N/A'}. If blanket coverage applies, please confirm. Please flag any fee first.`,
    '',
    'Thank you,',
    'Haul Support',
    SUPPORT_EMAIL,
  ];

  if (footerNote) {
    bodyLines.push('', '---', footerNote);
  }

  const text = bodyLines.join('\n');
  const html = bodyLines
    .map((line) => {
      if (line === '') return null;
      if (line === '---') return '<hr>';
      return `<p>${escapeHtml(line)}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  return { subject, text, html };
}

/**
 * Resolve To/CC for the additional-insured request email, enforcing the
 * dev/stage/test-account reroute.
 *
 * @param {object} params
 * @param {string} params.env - 'dev' | 'stage' | 'main'
 * @param {string} params.producerEmail
 * @param {string|null} params.ownerEmail
 * @param {boolean} params.ownerIsTestAccount
 * @param {string} [params.supportEmail]
 * @returns {{ to: string[], cc: string[], rerouted: boolean, intendedTo: string, intendedCc: string|null }}
 */
function resolveAdditionalInsuredRecipients({
  env,
  producerEmail,
  ownerEmail,
  ownerIsTestAccount,
  supportEmail = SUPPORT_EMAIL,
}) {
  const rerouted = env !== 'main' || ownerIsTestAccount === true;

  if (!rerouted) {
    return {
      to: [producerEmail],
      cc: ownerEmail ? [ownerEmail] : [],
      rerouted: false,
      intendedTo: producerEmail,
      intendedCc: ownerEmail || null,
    };
  }

  return {
    to: [supportEmail],
    cc: [],
    rerouted: true,
    intendedTo: producerEmail,
    intendedCc: ownerEmail || null,
  };
}

function buildRerouteFooterNote({ intendedTo, intendedCc }) {
  return `This email was rerouted for testing (non-main environment or test account). Intended To: ${intendedTo}. Intended CC: ${intendedCc || 'none'}.`;
}

async function getLatestInsuranceDocument(dynamodb, companyDocumentsTable, companyId) {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: companyDocumentsTable,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `COMPANY#${companyId}`,
        ':skPrefix': 'DOCUMENT#INSURANCE#',
      },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  return result.Items?.[0] || null;
}

/**
 * Fetch the ADDITIONAL_INSURED record for a company, if any.
 *
 * @param {string} companyId
 * @param {object} context - { dynamodb, tables: { COMPANY_DOCUMENTS_TABLE_NAME }, mediaBaseUrl }
 * @returns {Promise<object|null>}
 */
async function getAdditionalInsured(companyId, context) {
  const { dynamodb, tables, mediaBaseUrl } = context;

  const result = await dynamodb.send(
    new GetCommand({
      TableName: tables.COMPANY_DOCUMENTS_TABLE_NAME,
      Key: { pk: `COMPANY#${companyId}`, sk: 'ADDITIONAL_INSURED' },
    })
  );

  if (!result.Item) return null;

  return {
    ...result.Item,
    endorsement_url:
      result.Item.endorsement_s3_key && mediaBaseUrl
        ? `${mediaBaseUrl}/${result.Item.endorsement_s3_key}`
        : null,
  };
}

async function updateCompanyAdditionalInsuredRollup(dynamodb, companyTable, companyId, status) {
  await dynamodb.send(
    new UpdateCommand({
      TableName: companyTable,
      Key: { id: companyId },
      UpdateExpression: 'SET additional_insured_status = :status, additional_insured_updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':status': status,
        ':updated_at': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(id)',
    })
  );
}

/**
 * Evaluate eligibility, apply the per-term guard, send the additional-insured
 * request email, and record the result. Non-throwing for eligibility/guard
 * misses and for send failures — callers (document-review, admin document
 * update) treat this as best-effort and must not fail their own flow because
 * of it.
 *
 * @param {string} companyId
 * @param {object} [options]
 * @param {boolean} [options.force] - bypass the per-term guard (admin Send/Resend); never bypasses ALREADY_CONFIRMED
 * @param {object} context
 * @param {object} context.dynamodb - DynamoDBDocumentClient
 * @param {object} context.ses - SESClient
 * @param {object} context.tables - { COMPANY_TABLE_NAME, COMPANY_DOCUMENTS_TABLE_NAME, USER_TABLE_NAME }
 * @param {string} context.env - 'dev' | 'stage' | 'main'
 * @param {string} context.fromAddress - SES from address (e.g. notifications@haulwerk.com)
 * @param {string} [context.supportEmail]
 * @returns {Promise<{ sent: boolean, reason: string|null, record: object|null }>}
 */
async function requestAdditionalInsured(companyId, options = {}, context) {
  const { force = false } = options;
  const { dynamodb, ses, tables, env, fromAddress, supportEmail = SUPPORT_EMAIL } = context;

  const companyResult = await dynamodb.send(
    new GetCommand({ TableName: tables.COMPANY_TABLE_NAME, Key: { id: companyId } })
  );
  const company = companyResult.Item || null;

  if (!company) {
    return { sent: false, reason: AdditionalInsuredReason.NOT_VERIFIED, record: null };
  }

  const document = await getLatestInsuranceDocument(dynamodb, tables.COMPANY_DOCUMENTS_TABLE_NAME, companyId);

  const existingRecordResult = await dynamodb.send(
    new GetCommand({
      TableName: tables.COMPANY_DOCUMENTS_TABLE_NAME,
      Key: { pk: `COMPANY#${companyId}`, sk: 'ADDITIONAL_INSURED' },
    })
  );
  const existingRecord = existingRecordResult.Item || null;

  if (existingRecord?.status === AdditionalInsuredStatus.CONFIRMED) {
    return { sent: false, reason: AdditionalInsuredReason.ALREADY_CONFIRMED, record: existingRecord };
  }

  const { eligible, reason } = evaluateAdditionalInsuredEligibility({ company, document });
  if (!eligible) {
    return { sent: false, reason, record: existingRecord };
  }

  if (isAlreadyRequestedThisTerm({ existingRecord, document, force })) {
    return { sent: false, reason: AdditionalInsuredReason.ALREADY_REQUESTED_THIS_TERM, record: existingRecord };
  }

  // Resolve the company owner (for CC in main, and the test-account check).
  let owner = null;
  if (company.owner_user_id) {
    try {
      const ownerResult = await dynamodb.send(
        new GetCommand({
          TableName: tables.USER_TABLE_NAME,
          Key: { id: company.owner_user_id },
          ProjectionExpression: 'email, is_test_account',
        })
      );
      owner = ownerResult.Item || null;
    } catch (error) {
      console.warn('[AdditionalInsured] Failed to fetch company owner', { companyId, error: error.message });
    }
  }

  const reviewData = document.review_data || {};
  const producerEmail = reviewData.producer_contact_email;

  const recipients = resolveAdditionalInsuredRecipients({
    env,
    producerEmail,
    ownerEmail: owner?.email || null,
    ownerIsTestAccount: owner?.is_test_account === true,
    supportEmail,
  });

  const footerNote = recipients.rerouted ? buildRerouteFooterNote(recipients) : null;

  const { subject, text, html } = buildAdditionalInsuredRequestEmail({
    companyLegalName: company.legal_name || company.name || 'the company',
    producerContactName: reviewData.producer_contact_name || null,
    producerName: reviewData.producer_name || null,
    policyNumber: document.document_number || null,
    env,
    footerNote,
  });

  const now = new Date().toISOString();
  const baseRecord = {
    pk: `COMPANY#${companyId}`,
    sk: 'ADDITIONAL_INSURED',
    company_id: companyId,
    policy_number: document.document_number || null,
    policy_expires_at: document.expires_at || null,
    requested_to_email: recipients.intendedTo,
    requested_cc_email: recipients.intendedCc,
    request_count: (existingRecord?.request_count || 0) + 1,
    created_at: existingRecord?.created_at || now,
    updated_at: now,
  };

  try {
    await ses.send(
      new SendEmailCommand({
        Source: `Haul Support <${fromAddress}>`,
        Destination: {
          ToAddresses: recipients.to,
          CcAddresses: recipients.cc,
        },
        ReplyToAddresses: [supportEmail],
        Message: {
          Subject: { Data: subject },
          Body: {
            Html: { Data: html },
            Text: { Data: text },
          },
        },
      })
    );

    const record = {
      ...baseRecord,
      status: AdditionalInsuredStatus.REQUESTED,
      requested_at: now,
      last_send_error: null,
    };

    await dynamodb.send(new PutCommand({ TableName: tables.COMPANY_DOCUMENTS_TABLE_NAME, Item: record }));
    await updateCompanyAdditionalInsuredRollup(dynamodb, tables.COMPANY_TABLE_NAME, companyId, record.status);

    console.log('[AdditionalInsured] Request email sent', { companyId, to: recipients.to, rerouted: recipients.rerouted });

    return { sent: true, reason: null, record };
  } catch (error) {
    console.error('[AdditionalInsured] Failed to send request email', { companyId, error: error.message });

    const record = {
      ...baseRecord,
      status: AdditionalInsuredStatus.REQUEST_FAILED,
      requested_at: existingRecord?.requested_at || null,
      last_send_error: error.message,
    };

    await dynamodb.send(new PutCommand({ TableName: tables.COMPANY_DOCUMENTS_TABLE_NAME, Item: record }));
    await updateCompanyAdditionalInsuredRollup(dynamodb, tables.COMPANY_TABLE_NAME, companyId, record.status);

    return { sent: false, reason: AdditionalInsuredReason.SEND_FAILED, record };
  }
}

async function loadExistingAdditionalInsuredOrThrow(dynamodb, companyDocumentsTable, companyId) {
  const existingResult = await dynamodb.send(
    new GetCommand({
      TableName: companyDocumentsTable,
      Key: { pk: `COMPANY#${companyId}`, sk: 'ADDITIONAL_INSURED' },
    })
  );
  const existing = existingResult.Item;

  if (!existing) {
    const err = new Error('No additional-insured request on file for this company');
    err.code = 'NOT_FOUND';
    throw err;
  }

  return existing;
}

/**
 * Record admin confirmation that Haulwerk, LLC has been added as additional
 * insured (endorsement received/verified).
 *
 * @param {string} companyId
 * @param {object} params
 * @param {'BLANKET_ENDORSEMENT'|'SPECIFIC_ENDORSEMENT'} params.evidenceType
 * @param {string|null} [params.note]
 * @param {string|null} [params.endorsementS3Key]
 * @param {string|null} [params.confirmedBy] - admin user sub
 * @param {object} context - { dynamodb, tables: { COMPANY_TABLE_NAME, COMPANY_DOCUMENTS_TABLE_NAME } }
 * @returns {Promise<object>} the updated record
 */
async function confirmAdditionalInsured(companyId, params, context) {
  const { evidenceType, note = null, endorsementS3Key = null, confirmedBy = null } = params;
  const { dynamodb, tables } = context;

  if (evidenceType !== 'BLANKET_ENDORSEMENT' && evidenceType !== 'SPECIFIC_ENDORSEMENT') {
    const err = new Error('evidenceType must be BLANKET_ENDORSEMENT or SPECIFIC_ENDORSEMENT');
    err.code = 'INVALID_FIELD';
    throw err;
  }

  const existing = await loadExistingAdditionalInsuredOrThrow(dynamodb, tables.COMPANY_DOCUMENTS_TABLE_NAME, companyId);

  const now = new Date().toISOString();
  const record = {
    ...existing,
    status: AdditionalInsuredStatus.CONFIRMED,
    evidence_type: evidenceType,
    note,
    endorsement_s3_key: endorsementS3Key,
    confirmed_at: now,
    confirmed_by: confirmedBy,
    updated_at: now,
  };

  await dynamodb.send(new PutCommand({ TableName: tables.COMPANY_DOCUMENTS_TABLE_NAME, Item: record }));
  await updateCompanyAdditionalInsuredRollup(dynamodb, tables.COMPANY_TABLE_NAME, companyId, record.status);

  return record;
}

/**
 * Revert a CONFIRMED additional-insured record back to REQUESTED (e.g. the
 * admin confirmed in error, or the endorsement later lapsed).
 *
 * @param {string} companyId
 * @param {object} context - { dynamodb, tables: { COMPANY_TABLE_NAME, COMPANY_DOCUMENTS_TABLE_NAME } }
 * @returns {Promise<object>} the updated record
 */
async function revertAdditionalInsured(companyId, context) {
  const { dynamodb, tables } = context;

  const existing = await loadExistingAdditionalInsuredOrThrow(dynamodb, tables.COMPANY_DOCUMENTS_TABLE_NAME, companyId);

  const now = new Date().toISOString();
  const record = {
    ...existing,
    status: AdditionalInsuredStatus.REQUESTED,
    confirmed_at: null,
    confirmed_by: null,
    updated_at: now,
  };

  await dynamodb.send(new PutCommand({ TableName: tables.COMPANY_DOCUMENTS_TABLE_NAME, Item: record }));
  await updateCompanyAdditionalInsuredRollup(dynamodb, tables.COMPANY_TABLE_NAME, companyId, record.status);

  return record;
}

module.exports = {
  AdditionalInsuredStatus,
  AdditionalInsuredReason,
  evaluateAdditionalInsuredEligibility,
  isAlreadyRequestedThisTerm,
  buildAdditionalInsuredRequestEmail,
  resolveAdditionalInsuredRecipients,
  requestAdditionalInsured,
  getAdditionalInsured,
  confirmAdditionalInsured,
  revertAdditionalInsured,
};
