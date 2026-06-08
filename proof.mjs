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

const happyOK = happy.status === 200;
const got404  = unknown.status === 404;

console.log("=== ConnectRPC error-envelope proof ===================================");
console.log();
console.log("(a) GetStatus — registered method");
console.log(`    HTTP ${happy.status}  Content-Type: ${happy.contentType}`);
console.log(`    body: ${happy.body}`);
console.log();
console.log("(b) NonExistentMethod — unknown route");
console.log(`    HTTP ${unknown.status}  Content-Type: ${unknown.contentType}`);
console.log(`    body: ${unknown.body}`);
console.log();
console.log("── assertions ─────────────────────────────────────────────────────────");
console.log(`(a) registered method returns HTTP 200    ${happyOK ? "PASS" : "FAIL"}`);
console.log(`(b) unknown route Content-Type`);
console.log(`    got:      ${unknown.contentType}`);
console.log(`    expected: application/json             ${isJsonEnvelope ? "PASS" : "FAIL"}`);
console.log(`(b) unknown route body`);
console.log(`    got:      ${unknown.body.trim()}`);
console.log(`    expected: {"code":"unimplemented","message":"..."}  ${isJsonEnvelope ? "PASS" : "FAIL"}`);
console.log(`(b) SDK can promote to ConnectError`);
console.log(`    got:      e instanceof ConnectError → ${sdkCanDecode}`);
console.log(`    expected: true                         ${sdkCanDecode ? "PASS" : "FAIL"}`);
console.log();
