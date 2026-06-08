# Cosmo Router — ConnectRPC missing error envelope on unknown routes

Stock `ghcr.io/wundergraph/cosmo/router:latest` · no custom build required · Node + Docker only.

---

## Problem

Requests to an **unregistered RPC path** return a bare Go `http.NotFound` response instead of
a [Connect-protocol error envelope](https://connectrpc.com/docs/protocol/#error-codes).
Connect SDKs (`connect-es`, etc.) require the JSON envelope to promote the failure to a typed
`ConnectError`; without it the SDK throws an opaque `[unknown] HTTP 404` transport error and
`e instanceof ConnectError` is `false`.

The [Connect spec](https://connectrpc.com/docs/protocol/#error-codes) states:

> All non-2xx responses **MUST** carry `Content-Type: application/json` and a
> `{"code":"...","message":"..."}` body.

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

```go
func WriteConnectErrorEnvelope(w http.ResponseWriter, code connect.Code, msg string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(ConnectCodeToHTTPStatus(code))
    fmt.Fprintf(w, `{"code":%q,"message":%q}`, code.String(), msg)
}
```

```go
// router/pkg/connectrpc/server.go (lines 152 and 289)
unknownHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    WriteConnectErrorEnvelope(w, connect.CodeUnimplemented, "method not found: "+r.URL.Path)
})

transcoder, err := vanguard.NewTranscoder(vanguardServices,
    vanguard.WithUnknownHandler(unknownHandler))
```

---

## References

- [Connect protocol — Error Codes](https://connectrpc.com/docs/protocol/#error-codes)
- [vanguard-go `WithUnknownHandler`](https://pkg.go.dev/connectrpc.com/vanguard@v0.3.0#WithUnknownHandler)
