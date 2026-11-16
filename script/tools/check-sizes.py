#!/usr/bin/env python3
"""Fail if any contract compiled from src/ exceeds the EIP-170 runtime size limit.

`forge build --sizes` reports every artifact, including Uniswap contracts that are only deployed inside tests.
This gate looks at Covenant's own contracts only.
"""
import json
import pathlib
import sys

LIMIT = 24_576
root = pathlib.Path(__file__).resolve().parents[2]
out = root / "out"
src = root / "src"

rows, failed = [], False
for sol in sorted(src.rglob("*.sol")):
    art_dir = out / sol.name
    if not art_dir.is_dir():
        continue
    for art in sorted(art_dir.glob("*.json")):
        data = json.loads(art.read_text())
        if data.get("metadata", {}).get("settings", {}).get("compilationTarget", {}) and \
                not any(k.startswith("src/") for k in data["metadata"]["settings"]["compilationTarget"]):
            continue
        code = data.get("deployedBytecode", {}).get("object", "0x")
        size = (len(code) - 2) // 2
        if size == 0:
            continue  # interfaces, abstract contracts, libraries with internal functions only
        over = size > LIMIT
        failed |= over
        rows.append((art.stem, size, LIMIT - size, "OVER" if over else "ok"))

if not rows:
    print("no deployable contracts under src/ yet")
    sys.exit(0)
width = max(len(r[0]) for r in rows)
print(f"{'contract':<{width}}  {'runtime':>8}  {'margin':>8}")
for name, size, margin, status in rows:
    print(f"{name:<{width}}  {size:>8,}  {margin:>8,}  {status}")
sys.exit(1 if failed else 0)
