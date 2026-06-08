# Cosmo Router — ConnectRPC missing error envelope on unknown routes

Stock `ghcr.io/wundergraph/cosmo/router:latest` · no custom build required · Node + Docker only.

---

## Problem

Requests to an **unregistered RPC path** return a bare Go `http.NotFound` response instead of
a [Connect-protocol error envelope](https://connectrpc.com/docs/protocol/#error-codes).
Connect SDKs (`connect-es`, etc.) require the JSON envelope to promote the failure to a typed
`ConnectError`; without it the SDK throws an opaque `[unknown] HTTP 404` transport error and
`e instanceof ConnectError` is `false`.

### Why this is a protocol compliance gap

When a client sends `Connect-Protocol-Version: 1` to `:5026`, it has entered a protocol
handshake. The server accepted that handshake by binding a Connect handler on that port.
The [Connect spec](https://connectrpc.com/docs/protocol/#error-codes) states:

> All non-2xx responses **MUST** carry `Content-Type: application/json` and a
> `{"code":"...","message":"..."}` body.

The spec doesn't carve out an exception for unknown routes — once a port is a Connect server,
every response it produces is expected to be Connect-shaped. The router correctly rejects the
request, but because `vanguard.NewTranscoder` falls through to Go's stdlib `http.NotFound` for
unregistered paths, the rejection is issued *outside* the Connect protocol. The port made a
contract it then silently broke.

This sits in a grey area — the spec was written with registered handlers in mind, so calling
it a hard violation is arguable. But the practical consequence is concrete: **the SDK's typed
error surface breaks at the exact boundary where a client most needs a clear signal.**

| Scenario | SDK receives | SDK can do |
|---|---|---|
| Registered route, business error | `{"code":"..."}` | → typed `ConnectError` |
| Unregistered route today | `text/plain: 404 page not found` | → opaque `[unknown] HTTP 404` |
| Unregistered route after fix | `{"code":"unimplemented","message":"..."}` | → typed `ConnectError` |

---

## Actual vs. Expected

| | Actual (bug) | Expected (spec) |
|---|---|---|
| **HTTP status** | `404` | `404` |
| **Content-Type** | `text/plain; charset=utf-8` | `application/json` |
| **Body** | `404 page not found` | `{"code":"unimplemented","message":"method not found: /..."}` |

---

## Reproduce

Prerequisites: Docker, Node 22, `wgc` (`npm i -g wgc`).

```sh
wgc router compose -i supergraph-config.yaml -o execution-config.json
docker compose up -d
node proof.mjs
docker compose down
```

`proof.mjs` exits with **`defect reproduced: YES`** against the current router image.

---

## Root Cause

`vanguard.NewTranscoder` is called **without** `WithUnknownHandler` at two sites in
`router/pkg/connectrpc/server.go`:

```go
// line 152 — NewServer path
transcoder, err := vanguard.NewTranscoder(vanguardServices)

// line 289 — Reload path
transcoder, err := vanguard.NewTranscoder(vanguardService.GetServices())
```

From the [vanguard-go docs](https://github.com/connectrpc/vanguard-go?tab=readme-ov-file#transcoder-options):

> "Without this, requests for unrecognized URI paths will result in a simple '404 Not Found' response."

Vanguard's default `unknownHandler` is `net/http.NotFound` (bare `text/plain`).
The custom `writeConnectError` in `vanguard_service.go` is never reached for these paths.

---

## Suggested Fix

**This is a change to the [wundergraph/cosmo](https://github.com/wundergraph/cosmo) Router —
not to vanguard-go (which already ships `WithUnknownHandler` for exactly this purpose) and not
to the Connect spec (which is the standard being conformed to).**

Two files in `router/pkg/connectrpc/`, ~22 lines, no new dependencies.

**[`router/pkg/connectrpc/connect_util.go`](https://github.com/wundergraph/cosmo/blob/main/router/pkg/connectrpc/connect_util.go)** — add envelope writer:

```go
func WriteConnectErrorEnvelope(w http.ResponseWriter, code connect.Code, msg string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(ConnectCodeToHTTPStatus(code))
    fmt.Fprintf(w, `{"code":%q,"message":%q}`, code.String(), msg)
}
```

**[`router/pkg/connectrpc/server.go`](https://github.com/wundergraph/cosmo/blob/main/router/pkg/connectrpc/server.go)** — pass handler to both `NewTranscoder` call sites (lines 152 and 289):

```go
unknownHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    WriteConnectErrorEnvelope(w, connect.CodeUnimplemented, "method not found: "+r.URL.Path)
})

transcoder, err := vanguard.NewTranscoder(vanguardServices,
    vanguard.WithUnknownHandler(unknownHandler))
```

`connectrpc.com/connect` is already imported in `server.go`; only `fmt` needs to be added to `connect_util.go`.

---

## References

- [Connect protocol — Error Codes](https://connectrpc.com/docs/protocol/#error-codes)
- [vanguard-go `WithUnknownHandler`](https://pkg.go.dev/connectrpc.com/vanguard@v0.3.0#WithUnknownHandler)
