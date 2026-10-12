const base = `http://${process.env.ANTIGRAVITY_SHIM_HOST ?? "127.0.0.1"}:${process.env.ANTIGRAVITY_SHIM_PORT ?? "18790"}`;

const response = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: process.env.ANTIGRAVITY_SHIM_MODEL ?? "gemini-3.8-flash",
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }),
});

const body = await response.json();
if (!response.ok) {
  throw new Error(`shim request failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
}

console.log(JSON.stringify(body, null, 2));
