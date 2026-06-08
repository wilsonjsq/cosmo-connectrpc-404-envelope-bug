# Minimal reproduction — Cosmo Router returns bare HTTP 404 instead of Connect error envelope

Self-contained, no JSQ-specific schema or infrastructure. Mocks one GraphQL subgraph in ~40
lines of Node, points the **stock** Cosmo Router image at it, and calls two routes to show that:

- `ExternalService/GetStatus` (registered) returns HTTP 200 correctly.
- `ExternalService/NonExistentMethod` (unknown) returns a **bare `text/plain` HTTP 404** —
  not the JSON error envelope the Connect protocol requires. The `connect-es` SDK therefore
  cannot promote the error to a typed `ConnectError(Code.Unimplemented)`; it throws a generic
  `[unknown] HTTP 404` transport error instead.

Both observed against `ghcr.io/wundergraph/cosmo/router:latest`. No custom router build, no
Go modules, no controlplane, no Cosmo Cloud — just the published image with a static execution
config and a filesystem services storage provider.

## What's in this directory

```
subgraph.graphql                       # federation v2 SDL, one query field
subgraph-server.mjs                    # mock subgraph, ~40 LOC, no deps
services/external/service.proto        # ExternalService with GetStatus only
services/external/GetStatus.graphql    # the operation the router transcodes RPC → GraphQL
supergraph-config.yaml                 # input for `wgc router compose`
router.yaml                            # stock router config, connect_rpc enabled
docker-compose.yml                     # subgraph + stock router on a private bridge
proof.mjs                              # two wire probes + verdict, ~120 LOC, no deps
```

## Prerequisites

- Docker (tested with Engine 28.x).
- Node 22.x on the host (only for `proof.mjs` and `wgc`; the in-container subgraph also runs Node 22).
- `wgc` v0.121.x — `npm i -g wgc` if missing. Only used once, for `wgc router compose`.
  The repro itself is wgc-free.

## Run it

```sh
# 1. Compose the supergraph locally (writes execution-config.json).
wgc router compose -i supergraph-config.yaml -o execution-config.json

# 2. Bring the two-container stack up.
docker compose up -d
docker compose logs router --tail=20   # expect "Router started"

# 3. Run the wire-level probe.
node proof.mjs

# 4. Tear down.
docker compose down
```

## Expected output

```
=== ConnectRPC error-envelope reproduction ============================

(a) GetStatus (registered method)
    HTTP 200  Content-Type: application/json
    body: {"status":"operational"}

(b) NonExistentMethod (unknown route — bug lives here)
    HTTP 404  Content-Type: text/plain; charset=utf-8
    body: 404 page not found

happy path HTTP 200:           PASS
unknown route HTTP 404:        PASS
response Content-Type:         text/plain; charset=utf-8
body is bare text/plain (bug): YES ← defect
body is Connect envelope:      NO
SDK can decode to ConnectError: NO ← defect

defect reproduced:             YES

Connect-protocol spec requires:
  Content-Type: application/json
  body: {"code":"unimplemented","message":"method not found: ..."}

Root cause: vanguard.NewTranscoder called without WithUnknownHandler
  router/pkg/connectrpc/server.go:152 and server.go:289
  Default unknownHandler is net/http.NotFound (bare text/plain).
```

---

## Problem Summary

When a Connect-protocol request targets a URI path that has no matching method in the
router's registered service descriptors the Cosmo Router returns:

```
HTTP/1.1 404 Not Found
Content-Type: text/plain; charset=utf-8

Not Found
```

This is a bare Go `http.NotFound` response. The Connect protocol specification requires that
error responses carry a JSON envelope:

```json
{"code": "unimplemented", "message": "..."}
```

Without the envelope the `connect-es` (and any other Connect SDK) transport layer cannot
decode a typed error code. Instead of surfacing a clean `ConnectError(Code.Unimplemented)` the
SDK throws a generic transport error:

```
[unknown] HTTP 404
```

This forces every consumer that needs to distinguish "method does not exist" from other failure
modes to use brittle string-sniffing:

```ts
// workaround required today — should not be necessary
if (e.code === Code.Unknown && /HTTP 404/.test(e.rawMessage)) { ... }
```

---

## Technical Root Cause

The ConnectRPC server is built on
[`connectrpc.com/vanguard`](https://pkg.go.dev/connectrpc.com/vanguard@v0.3.0).
The transcoder is instantiated at two call sites in
`router/pkg/connectrpc/server.go` **without** a custom unknown-route handler:

```go
// server.go:152  (NewServer path)
transcoder, err := vanguard.NewTranscoder(vanguardServices)

// server.go:289  (Reload path)
transcoder, err := vanguard.NewTranscoder(vanguardService.GetServices())
```

The vanguard library documents this behaviour explicitly:

> "Without this [WithUnknownHandler option], requests for unrecognized URI paths
> will result in a simple '404 Not Found' response."
> — [vanguard-go README, Transcoder Options](https://github.com/connectrpc/vanguard-go?tab=readme-ov-file#transcoder-options)

Because no `vanguard.WithUnknownHandler` is provided, vanguard falls back to `http.NotFound`
before the custom per-service handler in `vanguard_service.go` is ever invoked.

---

## Proposed Fix

The fix is confined to two files and requires no new dependencies.

### Step 1 — Add a package-level envelope writer to `connect_util.go`

```go
// WriteConnectErrorEnvelope writes a minimal Connect-protocol JSON error envelope.
func WriteConnectErrorEnvelope(w http.ResponseWriter, code connect.Code, msg string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(ConnectCodeToHTTPStatus(code))
    fmt.Fprintf(w, `{"code":%q,"message":%q}`, code.String(), msg)
}
```

### Step 2 — Pass `WithUnknownHandler` to both `NewTranscoder` call sites in `server.go`

```go
unknownRouteHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    WriteConnectErrorEnvelope(w, connect.CodeUnimplemented, "method not found: "+r.URL.Path)
})

// server.go:152 — was: vanguard.NewTranscoder(vanguardServices)
transcoder, err := vanguard.NewTranscoder(
    vanguardServices,
    vanguard.WithUnknownHandler(unknownRouteHandler),
)

// server.go:289 — was: vanguard.NewTranscoder(vanguardService.GetServices())
transcoder, err := vanguard.NewTranscoder(
    vanguardService.GetServices(),
    vanguard.WithUnknownHandler(unknownRouteHandler),
)
```

Total: **~22 lines added, 2 lines changed**, no existing behaviour altered for registered routes.

---

## Expected Wire Response After Fix

```
HTTP/1.1 404 Not Found
Content-Type: application/json

{"code":"unimplemented","message":"method not found: /mini.external.v1.ExternalService/NonExistentMethod"}
```

`connect-es` can now promote this to a typed error:

```ts
} catch (e) {
  if (e instanceof ConnectError && e.code === Code.Unimplemented) {
    // clean, typed branch — no string sniffing required
  }
}
```

---

## Suggested Go Test Case

Add to `router/pkg/connectrpc/server_test.go`:

```go
func TestUnknownRouteReturnsConnectEnvelope(t *testing.T) {
    resp, err := http.Post(
        serverURL+"/mini.external.v1.ExternalService/NonExistentMethod",
        "application/json",
        strings.NewReader(`{}`),
    )
    require.NoError(t, err)
    defer resp.Body.Close()

    assert.Equal(t, http.StatusNotFound, resp.StatusCode)
    assert.Equal(t, "application/json", resp.Header.Get("Content-Type"))

    var envelope struct {
        Code    string `json:"code"`
        Message string `json:"message"`
    }
    require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
    assert.Equal(t, "unimplemented", envelope.Code)
    assert.Contains(t, envelope.Message, "NonExistentMethod")
}
```

---

## References

- [Connect protocol — Error Codes](https://connectrpc.com/docs/protocol/#error-codes)
- [vanguard-go `WithUnknownHandler`](https://pkg.go.dev/connectrpc.com/vanguard@v0.3.0#WithUnknownHandler)
- Related reproduction repo (enum transcoding bug): [cosmo-connectrpc-enum-bug](https://github.com/wilsonjsq/cosmo-connectrpc-enum-bug)
