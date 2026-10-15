import { describe, it, expect } from 'vitest';
import { structuredSchemaDefSchema, validateStructuredResult, evaluateSchemaCases, type StructuredResultEnvelope } from '../../src/structured';

const schema = structuredSchemaDefSchema.parse({
  name: 'invoice',
  version: 'v1',
  fields: {
    invoiceNumber: { type: 'string', validator: { required: true, pattern: '^[A-Z0-9-]+$' }, policy: { autoAcceptMinConfidence: 0.7, escalateIfMissing: true, rejectIfPatternFail: true } },
    total: { type: 'number', validator: { required: true, min: 0 }, policy: { autoAcceptMinConfidence: 0.8, escalateIfMissing: true, rejectIfPatternFail: false } },
    dueDate: { type: 'date', validator: { required: false }, policy: { autoAcceptMinConfidence: 0.8, escalateIfMissing: false, rejectIfPatternFail: false } }
  }
});

describe('validateStructuredResult', () => {
  it('computes field policies and overallPolicy', () => {
    const result: StructuredResultEnvelope = {
      schema: { name: schema.name, version: schema.version },
      documentId: 'doc1',
      canonicalDocumentUri: null,
      createdAt: new Date().toISOString(),
      overallConfidence: 0,
      overallPolicy: 'needs-review',
      fields: {
        invoiceNumber: { value: 'INV-123', confidence: 0.9, evidence: [], policy: 'needs-review', errors: [] },
        total: { value: 99.5, confidence: 0.9, evidence: [], policy: 'needs-review', errors: [] },
        dueDate: { value: null, confidence: 0.0, evidence: [], policy: 'needs-review', errors: [] }
      }
    };
    const { overallPolicy } = validateStructuredResult({ schema, result });
    expect(result.fields.invoiceNumber.policy).toBe('auto-accept');
    expect(result.fields.total.policy).toBe('auto-accept');
    expect(result.fields.dueDate.policy).toBe('needs-review');
    expect(overallPolicy).toBe('needs-review');
  });
});

describe('evaluateSchemaCases', () => {
  it('computes simple per-field accuracy and coverage', () => {
    const results: StructuredResultEnvelope[] = [
      {
        schema: { name: schema.name, version: schema.version },
        documentId: 'docA',
        canonicalDocumentUri: null,
        createdAt: new Date().toISOString(),
        overallConfidence: 0.8,
        overallPolicy: 'auto-accept',
        fields: {
          invoiceNumber: { value: 'INV-100', confidence: 0.9, evidence: [], policy: 'auto-accept', errors: [] },
          total: { value: 50, confidence: 0.9, evidence: [], policy: 'auto-accept', errors: [] },
          dueDate: { value: '2025-01-01', confidence: 0.8, evidence: [], policy: 'auto-accept', errors: [] }
        }
      }
    ];
    const summary = evaluateSchemaCases({
      schema,
      results,
      cases: [{ documentId: 'docA', expected: { invoiceNumber: 'INV-100', total: 50, dueDate: '2025-01-01' } }]
    });
    expect(summary.accuracy).toBe(1);
    expect(summary.perField.invoiceNumber.correct).toBe(1);
  });
});
