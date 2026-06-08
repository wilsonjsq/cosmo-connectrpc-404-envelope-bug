// Wire-level proof. Hits two routes against the stock Cosmo Router:
//
//   (a) /mini.external.v1.ExternalService/GetStatus         registered method  → 200 OK
//   (b) /mini.external.v1.ExternalService/NonExistentMethod unknown method     → bug here
//
// The defect: (b) returns a bare HTTP 404 text/plain "Not Found" response
// instead of a Connect-protocol JSON error envelope. The connect-es SDK
// therefore cannot promote the error to a typed ConnectError:
//
//   e instanceof ConnectError  → false   (should be true)
//   e.code                     → undefined (should be Code.Unimplemented)
//   e.message                  → "[unknown] HTTP 404"
//
// After the proposed fix (vanguard.WithUnknownHandler) (b) returns:
//   HTTP 404  Content-Type: application/json
//   {"code":"unimplemented","message":"method not found: /mini.external.v1..."}
//
// No SDK / no codegen / no deps. Run on host once `docker compose up` is healthy.

import { request as httpRequest } from "node:http";

function post(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      `http://localhost:${port}${path}`,
      {
        method: "POST",
        headers: { ...headers, "content-length": bodyBuf.length },
      },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () =>
          resolve({
            status: r.statusCode,
            contentType: r.headers["content-type"] ?? "(none)",
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

const CONNECT_HEADERS = {
  "content-type": "application/json",
  "connect-protocol-version": "1",
};

// (a) Happy path — method is registered in the ExternalService descriptor.
const happy = await post(
  5026,
  "/mini.external.v1.ExternalService/GetStatus",
  CONNECT_HEADERS,
  {},
);

// (b) Unknown method — not in any registered descriptor; vanguard unknown handler fires.
const unknown = await post(
  5026,
  "/mini.external.v1.ExternalService/NonExistentMethod",
  CONNECT_HEADERS,
  {},
);

// ── analysis ────────────────────────────────────────────────────────────────

let parsedEnvelope = null;
try { parsedEnvelope = JSON.parse(unknown.body); } catch (_) {}

const isBareText      = unknown.contentType.startsWith("text/plain");
const isJsonEnvelope  = unknown.contentType.includes("application/json")
                     && parsedEnvelope !== null
                     && typeof parsedEnvelope.code === "string";
const sdkCanDecode    = isJsonEnvelope; // connect-es promotes iff body is a JSON envelope

// ── output ──────────────────────────────────────────────────────────────────

console.log("=== ConnectRPC error-envelope reproduction ============================");
console.log();
console.log(`(a) GetStatus (registered method)`);
console.log(`    HTTP ${happy.status}  Content-Type: ${happy.contentType}`);
console.log(`    body: ${happy.body}`);
console.log();
console.log(`(b) NonExistentMethod (unknown route — bug lives here)`);
console.log(`    HTTP ${unknown.status}  Content-Type: ${unknown.contentType}`);
console.log(`    body: ${unknown.body}`);
console.log();

const happyOK = happy.status === 200;
const got404  = unknown.status === 404;

console.log(`happy path HTTP 200:           ${happyOK  ? "PASS" : "FAIL"}`);
console.log(`unknown route HTTP 404:        ${got404   ? "PASS" : "FAIL"}`);
console.log(`response Content-Type:         ${unknown.contentType}`);
console.log(`body is bare text/plain (bug): ${isBareText     ? "YES ← defect" : "no"}`);
console.log(`body is Connect envelope:      ${isJsonEnvelope ? "YES (patched)" : "NO"}`);
console.log(`SDK can decode to ConnectError: ${sdkCanDecode  ? "YES" : "NO ← defect"}`);
console.log();

// Expected SDK behaviour WITHOUT the fix:
//   e instanceof ConnectError  → false   (transport error, not ConnectError)
//   e.code                     → undefined
//   e.message                  → "[unknown] HTTP 404"
const bug = got404 && isBareText && !isJsonEnvelope;
if (bug) {
  console.log("defect reproduced:             YES");
  console.log();
  console.log("Connect-protocol spec requires:");
  console.log("  Content-Type: application/json");
  console.log('  body: {"code":"unimplemented","message":"method not found: ..."}');
  console.log();
  console.log("Root cause: vanguard.NewTranscoder called without WithUnknownHandler");
  console.log("  router/pkg/connectrpc/server.go:152 and server.go:289");
  console.log("  Default unknownHandler is net/http.NotFound (bare text/plain).");
} else if (isJsonEnvelope) {
  console.log("defect reproduced:             PATCHED — envelope present");
} else {
  console.log("defect reproduced:             INCONCLUSIVE");
}
