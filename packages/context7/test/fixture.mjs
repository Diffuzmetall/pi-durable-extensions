import http from 'node:http';
import { once } from 'node:events';

export const KEY = 'synthetic-context7-fixture-key';
export const UA = 'pi-durable-context7/0.1.0-candidate.1';
const nativeFetch = globalThis.fetch;

export async function fixture(options = {}) {
  const trace = [];
  let session = 0;
  const server = http.createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const rpc = input ? JSON.parse(input) : undefined;
    const method = rpc?.method ?? req.method;
    trace.push({ method, http: req.method, authorized: req.headers.authorization === `Bearer ${options.expectedKey ?? KEY}`, ua: req.headers['user-agent'], rpc });
    if (options.respond && await options.respond({ req, res, rpc, method, trace })) return;
    if (req.method === 'DELETE' || rpc?.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'loopback-context7', version: '1' } };
      res.setHeader('Mcp-Session-Id', 'fixture-' + (++session));
    } else if (method === 'tools/call') {
      result = options.result ?? { content: [{ type: 'text', text: rpc.params.name === 'resolve-library-id' ? '/fixture/library/v1' : 'fixture documentation https://example.invalid/source' }] };
    } else result = {};
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    res.writeHead(200, { 'content-type': options.sse ? 'text/event-stream' : 'application/json' });
    res.end(options.sse ? `id: fixture-event\nevent: message\ndata: ${body}\n\n` : body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    trace,
    url,
    async fetch(input, init = {}) {
      if (String(input) !== 'https://mcp.context7.com/mcp') throw Error('fixture received a non-fixed endpoint');
      if (init.redirect !== 'error') throw Error('redirect policy was not preserved');
      if (new Headers(init.headers).get('User-Agent') !== UA) throw Error('honest User-Agent was not preserved');
      return nativeFetch(url, init);
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
