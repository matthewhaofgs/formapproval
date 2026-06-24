const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAdminAuditWorkbook } = require('../src/xlsxExport');

test('admin audit export workbook contains comprehensive audit sheets', () => {
  const workbook = buildAdminAuditWorkbook({
    generatedAt: '2026-06-23T00:00:00.000Z',
    processKey: 'overtime',
    requests: [
      {
        requestId: 'OT-1',
        processType: 'overtime',
        createdAt: '2026-06-23T00:00:00.000Z',
        updatedAt: '2026-06-23T00:05:00.000Z',
        data: {
          requestId: 'OT-1',
          processType: 'overtime',
          status: 'PREAPPROVED',
          employeeName: 'Example Staff',
          approvalHistory: JSON.stringify([
            {
              at: '2026-06-23T10:00:00+10:00',
              stepName: 'Line Manager',
              decision: 'approved',
              approverEmail: 'manager@example.edu'
            }
          ])
        }
      }
    ],
    events: [
      {
        id: 1,
        timestamp: '2026-06-23T00:00:00.000Z',
        requestId: 'OT-1',
        actorEmail: 'manager@example.edu',
        event: 'APPROVAL_APPROVED_STEP',
        details: { stepName: 'Line Manager' }
      }
    ],
    outboundEmails: [
      {
        id: 1,
        createdAt: '2026-06-23T00:00:00.000Z',
        toEmail: 'manager@example.edu',
        ccEmail: '',
        subject: 'OT-1: overtime pre-approval needed',
        body: 'Body',
        htmlBody: '<p>Body</p>',
        providerResult: { mode: 'smtp', accepted: ['manager@example.edu'] }
      }
    ],
    definitions: [
      {
        category: 'process_definition',
        definitionKey: 'overtime',
        enabled: true,
        source: 'database',
        createdAt: '2026-06-23T00:00:00.000Z',
        updatedAt: '2026-06-23T00:00:00.000Z',
        data: { name: 'Support Staff Overtime' }
      }
    ]
  }, {
    actorEmail: 'admin@example.edu',
    processKey: 'overtime',
    processName: 'Support Staff Overtime'
  });

  assert.ok(Buffer.isBuffer(workbook));
  assert.ok(workbook.length > 1000);
  const content = workbook.toString('utf8');
  assert.match(content, /Requests/);
  assert.match(content, /Workflow History/);
  assert.match(content, /Outbound Emails/);
  assert.match(content, /Definitions/);
  assert.match(content, /OT-1/);
  assert.match(content, /Line Manager/);
  assert.equal(workbook.readUInt32LE(workbook.length - 22), 0x06054b50);
});
