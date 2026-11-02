"""scripts/decision-eval/laya_server.py: tiny HTTP wrapper around a local Laya
checkpoint, so the node harness can call it like an API.

POST /choose {"state": str, "instructions": str, "options": {key: desc}}
  -> {"choice": key, "probs": {key: p}, "ms": float}
GET /health -> {"ok": true, "ckpt": ...}

Env: LAYA_CKPT (default convaiinnovations/laya), LAYA_SUB (subfolder),
LAYA_THREADS (intra-op threads, default 4), LAYA_PORT (default 8765).
Inter-op threads are pinned to 1 (Laya BENCHMARKS.md: 12x on CPU).
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
torch.set_num_threads(int(os.environ.get("LAYA_THREADS", "4")))
torch.set_num_interop_threads(1)
import laya

CKPT = os.environ.get("LAYA_CKPT", "convaiinnovations/laya")
SUB = os.environ.get("LAYA_SUB") or None
t0 = time.time()
agent = laya.load(CKPT, subfolder=SUB, device="cpu") if SUB else laya.load(CKPT, device="cpu")
print(f"# loaded {CKPT} {SUB or ''} in {time.time()-t0:.1f}s", flush=True)


def choose(state, instructions, options, head_max_len=None, max_len=None):
    q = {"next": {"type": "choice", "instructions": instructions, "criteria": options}}
    kw = {}
    if head_max_len:
        kw["head_max_len"] = int(head_max_len)
    if max_len:
        kw["max_len"] = int(max_len)
    t = time.perf_counter()
    with torch.inference_mode():
        r = agent.predict(state, q, **kw)
    ms = (time.perf_counter() - t) * 1000
    a = r["answers"]["next"]
    return {"choice": a.get("choice"), "probs": a.get("probabilities", {}), "ms": ms}


# warm-up
choose("health 20/20", "pick one", {"a": "attack", "b": "flee"})


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._send(200, {"ok": True, "ckpt": CKPT, "sub": SUB})

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        try:
            req = json.loads(self.rfile.read(n))
            if self.path == "/batch":
                # Same question over N states in one forward pass (throughput probe).
                q = {"next": {"type": "choice", "instructions": req["instructions"], "criteria": req["options"]}}
                kw = {k: int(req[k]) for k in ("max_len", "head_max_len") if req.get(k)}
                t = time.perf_counter()
                with torch.inference_mode():
                    rs = agent.predict_batch(req["states"], q, batch_size=req.get("batch_size"), **kw)
                ms = (time.perf_counter() - t) * 1000
                self._send(200, {"choices": [r["answers"]["next"].get("choice") for r in rs], "ms": ms})
                return
            self._send(200, choose(req["state"], req["instructions"], req["options"], req.get("head_max_len"), req.get("max_len")))
        except Exception as e:
            self._send(500, {"error": str(e)})


port = int(os.environ.get("LAYA_PORT", "8765"))
print(f"# listening on {port}", flush=True)
# Single-threaded on purpose: one forward pass at a time, like a real reflex loop.
from http.server import HTTPServer
HTTPServer(("127.0.0.1", port), H).serve_forever()
