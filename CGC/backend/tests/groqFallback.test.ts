/**
 * The fallback client, against a mock.
 *
 * Nothing here reaches the network. Every Groq call in CI is a stub — an
 * automated test that could spend money against a real account is a test nobody
 * can afford to run on every push.
 *
 * The behaviour being pinned is mostly about *not* calling: not when it is
 * switched off, not when there is no key, not again after a refusal or a 400,
 * and never with the document's contents in the logs.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { env } from '../src/config/env.js';
import {
  __setGroqClientForTests,
  redactForFallback,
  selectFallbackContext,
  requestFallbackFields,
} from '../src/services/documentExtraction/groqFallback.service.js';

const FIELDS = [
  { path: 'total', description: 'The total amount payable in Canadian dollars.' },
  { path: 'lines.0.unit', description: 'The unit of measure for this line.' },
];

const OCR_TEXT = 'Northfield Aggregates Ltd\nTOTAL $1,412.50\n25 tonnes';

function request(overrides: Partial<Parameters<typeof requestFallbackFields>[0]> = {}) {
  return requestFallbackFields({
    documentType: 'INVOICE',
    fields: FIELDS,
    ocrText: OCR_TEXT,
    jobId: 'job-1',
    ...overrides,
  });
}

/** A stand-in for the Groq client exposing only what the service calls. */
function stubClient(handler: (params: any) => unknown) {
  const create = mock.fn(async (params: any) => handler(params));
  __setGroqClientForTests({ chat: { completions: { create } } } as never);
  return create;
}

function completion(content: string, usage = { prompt_tokens: 120, completion_tokens: 20 }) {
  return { choices: [{ message: { content } }], usage };
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const originalEnv = {
  enabled: env.groqFallbackEnabled,
  key: env.groqApiKey,
};

beforeEach(() => {
  (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = true;
  (env as { groqApiKey: string }).groqApiKey = 'test-only-key';
});

afterEach(() => {
  (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = originalEnv.enabled;
  (env as { groqApiKey: string }).groqApiKey = originalEnv.key;
  __setGroqClientForTests(null);
  mock.restoreAll();
});

describe('fallback gating', () => {
  it('does not call when the fallback is switched off', async () => {
    (env as { groqFallbackEnabled: boolean }).groqFallbackEnabled = false;
    const create = stubClient(() => completion('{}'));

    const result = await request();

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'DISABLED');
    assert.equal(create.mock.callCount(), 0);
  });

  it('does not call when no API key is configured, and does not retry', async () => {
    // A deployment missing the secret must not turn into a retry storm.
    (env as { groqApiKey: string }).groqApiKey = '';
    const create = stubClient(() => completion('{}'));

    const result = await request();

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'NOT_CONFIGURED');
    assert.equal(create.mock.callCount(), 0);
    assert.equal(result.meta.attempts, 0);
  });

  it('does not call when there are no unresolved fields to ask about', async () => {
    const create = stubClient(() => completion('{}'));
    const result = await request({ fields: [] });

    assert.equal(result.ok === false && result.reason, 'NO_FIELDS');
    assert.equal(create.mock.callCount(), 0);
  });
});

describe('fallback request shape', () => {
  it('sends a strict JSON schema covering exactly the requested paths', async () => {
    const create = stubClient(() =>
      completion(JSON.stringify({ total: '1412.50', 'lines.0.unit': 'tonnes' }))
    );

    await request();

    const params = create.mock.calls[0]?.arguments[0] as any;
    assert.equal(params.response_format.type, 'json_schema');
    assert.equal(params.response_format.json_schema.strict, true);
    assert.deepEqual(params.response_format.json_schema.schema.required, ['total', 'lines.0.unit']);
    assert.equal(params.response_format.json_schema.schema.additionalProperties, false);
  });

  it('pins the sampling and cost controls', async () => {
    const create = stubClient(() => completion('{"total":null,"lines.0.unit":null}'));
    await request();

    const params = create.mock.calls[0]?.arguments[0] as any;
    assert.equal(params.temperature, 0);
    assert.equal(params.model, env.groqModel);
    assert.equal(params.max_completion_tokens, env.groqMaxOutputTokens);
    assert.equal(params.store, false);
    // No tools means no browsing: the answer has to come from the page.
    assert.equal(params.tools, undefined);
  });

  it('tells the model the document text is data, not instructions', async () => {
    const create = stubClient(() => completion('{"total":null,"lines.0.unit":null}'));
    await request();

    const params = create.mock.calls[0]?.arguments[0] as any;
    const system = params.messages[0].content as string;
    assert.match(system, /not addressed to you/i);
    assert.match(system, /ignored and treated as ordinary document text/i);
  });

  it('strips email addresses and links before the text leaves the process', () => {
    const redacted = redactForFallback(
      'Contact ap@northfield-aggregates.test\nsee https://storage.example.test/signed?token=abc\nTOTAL 100.00'
    );
    assert.ok(!redacted.includes('@northfield-aggregates.test'));
    assert.ok(!redacted.includes('https://'));
    assert.ok(redacted.includes('TOTAL 100.00'));
  });

  it('bounds how much document text is sent', () => {
    const redacted = redactForFallback('x'.repeat(50_000));
    assert.equal(redacted.length, 4_000);
  });

  it('sends only line neighborhoods relevant to unresolved fields', () => {
    const context = selectFallbackContext(
      [
        'Private customer: Jane Example',
        'Delivery address: 10 Sensitive Street N1N 1N1',
        'Telephone: 519-555-0100',
        'Unrelated banking reference 99887766',
        'TOTAL',
        '$1412.50',
      ].join('\n'),
      [{ path: 'total', description: 'The total amount payable.' }],
    );
    assert.match(context, /TOTAL/);
    assert.match(context, /1412\.50/);
    assert.doesNotMatch(context, /Jane Example|Sensitive Street|99887766/);
  });
});

describe('fallback responses', () => {
  it('returns the values for a well-formed answer', async () => {
    stubClient(() => completion(JSON.stringify({ total: '1412.50', 'lines.0.unit': 'tonnes' })));

    const result = await request();

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.values, {
      total: '1412.50',
      'lines.0.unit': 'tonnes',
    });
    assert.equal(result.meta.promptTokens, 120);
    assert.equal(result.meta.completionTokens, 20);
  });

  it('drops keys nobody asked about', async () => {
    // A model answering outside the requested set is a model the schema is not
    // constraining, and those extra keys must never reach a validated field.
    stubClient(() =>
      completion(JSON.stringify({ total: '1412.50', 'lines.0.unit': 'tonnes', supplierName: 'Invented Co' }))
    );

    const result = await request();

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.ok === true ? result.values : {}), ['total', 'lines.0.unit']);
  });

  it('treats a refusal as final and does not retry it', async () => {
    const create = stubClient(() => ({
      choices: [{ message: { refusal: 'I cannot help with that' } }],
      usage: {},
    }));

    const result = await request();

    assert.equal(result.ok === false && result.reason, 'REFUSED');
    assert.equal(create.mock.callCount(), 1);
  });

  it('rejects output that is not valid JSON', async () => {
    const create = stubClient(() => completion('here you go: {total: 1412.5'));
    const result = await request();

    assert.equal(result.ok === false && result.reason, 'MALFORMED');
    assert.equal(create.mock.callCount(), 1, 'a schema failure repeats identically; do not pay twice');
  });

  it('rejects the whole answer when a scalar field comes back as an object', async () => {
    stubClient(() => completion(JSON.stringify({ total: { value: 1412.5 }, 'lines.0.unit': 'tonnes' })));
    const result = await request();
    assert.equal(result.ok === false && result.reason, 'MALFORMED');
  });
});

describe('fallback retries', () => {
  it('retries a 429 up to the bound, then gives up', async () => {
    const create = stubClient(() => {
      throw httpError(429);
    });

    const result = await request();

    assert.equal(result.ok === false && result.reason, 'RATE_LIMITED');
    assert.equal(create.mock.callCount(), 3);
  });

  it('retries a 5xx and succeeds when the service recovers', async () => {
    let calls = 0;
    const create = stubClient(() => {
      calls += 1;
      if (calls < 3) throw httpError(503);
      return completion(JSON.stringify({ total: '1412.50', 'lines.0.unit': 'tonnes' }));
    });

    const result = await request();

    assert.equal(result.ok, true);
    assert.equal(create.mock.callCount(), 3);
    assert.equal(result.meta.attempts, 3);
  });

  it('retries a timeout', async () => {
    const create = stubClient(() => {
      throw Object.assign(new Error('timed out'), { name: 'APIConnectionTimeoutError' });
    });

    const result = await request();

    assert.equal(result.ok === false && result.reason, 'TIMEOUT');
    assert.equal(create.mock.callCount(), 3);
  });

  it('does not retry an ordinary 4xx', async () => {
    const create = stubClient(() => {
      throw httpError(400);
    });

    const result = await request();

    assert.equal(result.ok === false && result.reason, 'CLIENT_ERROR');
    assert.equal(create.mock.callCount(), 1);
  });

  it('does not retry a 404', async () => {
    const create = stubClient(() => {
      throw httpError(404);
    });
    const result = await request();
    assert.equal(create.mock.callCount(), 1);
    assert.equal(result.ok === false && result.reason, 'CLIENT_ERROR');
  });
});

describe('fallback concurrency', () => {
  it('holds in-flight calls to the configured ceiling', async () => {
    // A worker sweep of 25 documents that all needed fallback would otherwise
    // open 25 connections at once and be rate-limited as a burst.
    let inFlight = 0;
    let peak = 0;

    stubClient(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 15));
      inFlight -= 1;
      return completion(JSON.stringify({ total: '1.00', 'lines.0.unit': 'tonnes' }));
    });

    await Promise.all(Array.from({ length: 8 }, () => request()));

    assert.ok(peak <= env.groqMaxConcurrency, `peak ${peak} exceeded ceiling ${env.groqMaxConcurrency}`);
  });
});

describe('fallback logging', () => {
  it('logs the operational facts and none of the document', async () => {
    stubClient(() => completion(JSON.stringify({ total: '1412.50', 'lines.0.unit': 'tonnes' })));

    const written: string[] = [];
    const restore = console.log;
    console.log = (...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    };

    try {
      await request();
    } finally {
      console.log = restore;
    }

    const output = written.join('\n');

    // Present: what an operator needs.
    assert.ok(output.includes('job-1'), 'job id should be logged');
    assert.ok(output.includes('INVOICE'), 'document type should be logged');
    assert.ok(output.includes(env.groqModel), 'model should be logged');
    assert.ok(output.includes('promptTokens'), 'token usage should be logged');

    // Absent: anything that would put a client document in the logs.
    assert.ok(!output.includes('Northfield'), 'OCR text must not be logged');
    assert.ok(!output.includes('1,412.50'), 'document values must not be logged');
    assert.ok(!output.includes('1412.50'), 'model output must not be logged');
    assert.ok(!output.includes('test-only-key'), 'the API key must never be logged');
    assert.ok(!output.includes('You read fields off'), 'the prompt must not be logged');
  });
});
