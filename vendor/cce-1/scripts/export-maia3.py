#!/usr/bin/env python3
"""Export the official Maia-3 checkpoint to the ONNX contract CCE-1 consumes.

The released Maia-3 checkpoints (https://github.com/CSSLab/maia3, AGPL-3.0;
weights at https://huggingface.co/UofTCSSLab) take an 8-position history
window of board tokens, padded by repeating the earliest position when the
history is short. CCE-1 evaluates single positions, so this wrapper bakes
that padding into the graph: the exported model takes one position as
tokens f32 [batch, 64, 12] and tiles it to fill the history window, which
is exactly what the reference UCI engine does when launched without
--use-uci-history. Elo inputs stay continuous floats (the model's Elo
conditioning is a linear interpolation between two embeddings).

Exported contract (identical to the maia3_simplified.onnx web export):
  inputs  tokens f32 [batch, 64, 12], elo_self f32 [batch], elo_oppo f32 [batch]
  outputs logits_move [batch, 4352], logits_value [batch, 3]

Usage:
  python scripts/export-maia3.py --model maia3-5m --out maia3-5m.onnx
  (needs: torch, onnx, onnxruntime, python-chess, numpy, huggingface-hub,
   and a clone of https://github.com/CSSLab/maia3 on PYTHONPATH or
   pip-installed)
"""

import argparse
import sys
import types

import torch


def build_model(model_name: str, checkpoint_path: str | None):
    from maia3.model_registry import (
        apply_model_config,
        resolve_checkpoint_path,
        resolve_model_spec,
    )
    from maia3.models import MAIA3Model

    spec = resolve_model_spec(model_name)
    cfg = types.SimpleNamespace(device="cpu")
    apply_model_config(cfg, spec)

    ckpt_path = checkpoint_path or resolve_checkpoint_path(spec)
    model = MAIA3Model(cfg)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    state = ckpt.get("model_state_dict", ckpt) if isinstance(ckpt, dict) else ckpt
    state = {k.replace("smolgen", "gab"): v for k, v in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        print(f"warning: missing={missing[:3]} unexpected={unexpected[:3]}", file=sys.stderr)
    model.eval()
    return model, cfg, ckpt_path


class DecomposedRMSNorm(torch.nn.Module):
    """nn.RMSNorm in primitive ops; aten::rms_norm has no opset-17 symbolic."""

    def __init__(self, src: torch.nn.RMSNorm):
        super().__init__()
        self.weight = src.weight
        self.eps = src.eps if src.eps is not None else 1e-6

    def forward(self, x):
        rms = torch.sqrt(x.pow(2).mean(dim=-1, keepdim=True) + self.eps)
        return x / rms * self.weight


def decompose_rms_norms(module: torch.nn.Module):
    for name, child in module.named_children():
        if isinstance(child, torch.nn.RMSNorm):
            setattr(module, name, DecomposedRMSNorm(child))
        else:
            decompose_rms_norms(child)


class SinglePositionWrapper(torch.nn.Module):
    """[64, 12] single position -> history-window input the checkpoint expects."""

    def __init__(self, model, history: int):
        super().__init__()
        self.model = model
        self.history = history

    def forward(self, tokens, elo_self, elo_oppo):
        hist = tokens.repeat(1, 1, self.history)  # (B, 64, 12*history)
        logits_move, logits_value, _ = self.model(hist, elo_self, elo_oppo)
        return logits_move, logits_value


def export(model, cfg, out_path: str):
    wrapper = SinglePositionWrapper(model, cfg.history)
    decompose_rms_norms(wrapper)
    wrapper.eval()
    tokens = torch.zeros(1, 64, 12)
    elo = torch.tensor([1500.0])
    torch.onnx.export(
        wrapper,
        (tokens, elo, elo.clone()),
        out_path,
        input_names=["tokens", "elo_self", "elo_oppo"],
        output_names=["logits_move", "logits_value"],
        dynamic_axes={
            "tokens": {0: "batch"},
            "elo_self": {0: "batch"},
            "elo_oppo": {0: "batch"},
            "logits_move": {0: "batch"},
            "logits_value": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )


def verify(model, cfg, out_path: str):
    """PyTorch vs ONNX parity on a handful of real positions."""
    import chess
    import numpy as np
    import onnxruntime as ort

    from maia3.dataset import tokenize_board

    fens = [
        chess.STARTING_FEN,
        "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
        "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        "8/P7/8/8/8/4k3/8/4K3 w - - 0 1",  # promotion race
    ]
    sess = ort.InferenceSession(out_path)
    max_diff = 0.0
    for fen in fens:
        board = chess.Board(fen)
        if board.turn == chess.BLACK:
            board = board.mirror()
        tok = tokenize_board(board).unsqueeze(0)
        for elo in (600.0, 1500.0, 2600.0):
            e = torch.tensor([elo])
            with torch.no_grad():
                pt_move, pt_value, _ = model(tok.repeat(1, 1, cfg.history), e, e)
            ox_move, ox_value = sess.run(
                None,
                {
                    "tokens": tok.numpy(),
                    "elo_self": e.numpy(),
                    "elo_oppo": e.numpy(),
                },
            )
            max_diff = max(
                max_diff,
                float(np.abs(pt_move.numpy() - ox_move).max()),
                float(np.abs(pt_value.numpy() - ox_value).max()),
            )
    print(f"max |pytorch - onnx| over {len(fens)} positions x 3 elos: {max_diff:.2e}")
    if max_diff > 1e-3:
        raise SystemExit("parity check FAILED")
    print("parity check passed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="maia3-5m", help="maia3 alias (maia3-5m, maia3-23m, ...)")
    ap.add_argument("--checkpoint", default=None, help="local .pt path (default: download from HF)")
    ap.add_argument("--out", default="maia3-5m.onnx")
    args = ap.parse_args()

    model, cfg, ckpt_path = build_model(args.model, args.checkpoint)
    print(f"checkpoint: {ckpt_path}")
    export(model, cfg, args.out)
    import os

    print(f"exported {args.out} ({os.path.getsize(args.out)} bytes)")
    verify(model, cfg, args.out)


if __name__ == "__main__":
    main()
