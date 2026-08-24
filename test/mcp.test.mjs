import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, runDirectLane, pipelineEnv } from './harness.mjs';

const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('MCP server: read-only corpus access, verifier gate, verified render', async () => {
  const lane = runDirectLane();
  rmSync(path.join(lane.out, 'analysis.json')); // start the MCP flow without an analysis

  const client = new Client({ name: 'wa-audit-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-server.mjs')],
    cwd: ROOT,
    env: pipelineEnv(lane.out),
  });
  await client.connect(transport);

  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of ['status', 'waha_qr', 'save_business_context', 'corpus_stats', 'read_threads', 'verify_quote', 'submit_dimension', 'render_report']) {
      assert.ok(tools.includes(expected), `tool ${expected} exposed`);
    }

    const stats = JSON.parse(textOf(await client.callTool({ name: 'corpus_stats', arguments: {} })));
    assert.equal(stats.summary.threads, 23);
    assert.equal(stats.per_thread.length, 23);

    const thread = textOf(await client.callTool({ name: 'read_threads', arguments: { thread_id: '5491155501234' } }));
    assert.match(thread, /UNTRUSTED DATA/);
    assert.match(thread, /Precio de la cinta/);

    const good = JSON.parse(textOf(await client.callTool({ name: 'verify_quote', arguments: { thread_id: '5491155501234', quote: 'Hola! Precio de la cinta de 60cm?' } })));
    assert.equal(good.found, true);
    const bad = JSON.parse(textOf(await client.callTool({ name: 'verify_quote', arguments: { thread_id: '5491155501234', quote: 'necesito factura A' } })));
    assert.equal(bad.found, false);

    // The verifier gate: a dimension without a verdict must be rejected...
    const noVerdict = await client.callTool({
      name: 'submit_dimension',
      arguments: { dimension: { key: 'fate_focus', title: 'FATE · Foco', summary: 's', findings: [], columns: [{ key: 'n', label: '#' }], rows: [], method: 'm', limitations: [] } },
    });
    assert.equal(noVerdict.isError, true);
    assert.match(textOf(noVerdict), /verdict/);

    // ...and so must fabricated evidence, even with a verdict present.
    const fabricated = await client.callTool({
      name: 'submit_dimension',
      arguments: {
        dimension: {
          key: 'fate_focus', title: 'FATE · Foco', summary: 's', method: 'm', limitations: [],
          columns: [{ key: 'n', label: '#' }], rows: [{ n: 1 }],
          findings: [{ title: 'x', detail: 'd', confidence: 'high', evidence: [{ thread_id: '5491155501234', quote: 'necesito factura A' }] }],
          verdict: { reviewed: 1, confirmed: 1, refuted: [] },
        },
      },
    });
    assert.equal(fabricated.isError, true);
    assert.match(textOf(fabricated), /layer-A/);

    // A verified dimension with real evidence goes through, and the report renders.
    const ok = await client.callTool({
      name: 'submit_dimension',
      arguments: {
        dimension: {
          key: 'fate_focus', title: 'FATE · Foco — captura y retención de atención',
          summary: 'demo', method: 'm', limitations: [],
          columns: [{ key: 'n', label: '#' }, { key: 'pattern', label: 'Patrón' }],
          rows: [{ n: 1, pattern: 'Plantilla repetida' }],
          findings: [{
            title: 'La cotización en plantilla se repite', detail: 'd', confidence: 'medium',
            evidence: [{ thread_id: '5491155501234', quote: 'COTIZACIÓN N.º 101 ⏎ Producto: cinta transportadora modelo CT-101' }],
          }],
          verdict: { reviewed: 2, confirmed: 1, refuted: [{ title: 'Hallazgo inflado', reason: 'no se sostuvo el recuento' }] },
        },
      },
    });
    assert.notEqual(ok.isError, true, textOf(ok));
    assert.match(textOf(ok), /1 refuted/);

    const render = await client.callTool({ name: 'render_report', arguments: { formats: ['html'] } });
    assert.notEqual(render.isError, true, textOf(render));
    assert.ok(existsSync(path.join(lane.out, 'whatsapp-report.html')));
  } finally {
    await client.close();
  }
});
