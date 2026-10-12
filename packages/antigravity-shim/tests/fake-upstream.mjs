import { createServer } from "node:http";

const port = Number(process.argv[2]);
const events = [
  { type: "text_delta", delta: "fixture-ok" },
  {
    type: "toolcall_start",
    contentIndex: 1,
    partial: { content: [{ type: "text", text: "fixture-ok" }, { type: "toolCall", id: "fixture-call", name: "clock" }] },
  },
  { type: "toolcall_delta", contentIndex: 1, delta: '{"zone":"UTC"}' },
  {
    type: "done",
    message: {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "fixture-ok" },
        { type: "toolCall", id: "fixture-call", name: "clock", arguments: { zone: "UTC" } },
      ],
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
    },
  },
];

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/events") {
    response.writeHead(404).end();
    return;
  }

  for await (const _chunk of request) {
    // Consume the request to exercise the real local upstream boundary.
  }

  const body = JSON.stringify(events);
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
