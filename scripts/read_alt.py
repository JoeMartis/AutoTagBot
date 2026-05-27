#!/usr/bin/env python3
"""
Read existing /Alt (and /ActualText) from a tagged PDF, in document order.

Pairs with apply_alt.py: same struct-tree walk, so the i-th entry here
corresponds to the i-th entry in the manifest written back.
"""
import argparse
import json
import sys

try:
    import pikepdf
except ImportError:
    json.dump({"error": "pikepdf is not installed. Run: pip install pikepdf"}, sys.stdout)
    sys.exit(3)


def collect_figures(node, out):
    kids = node.get("/K")
    if kids is None:
        return
    if not isinstance(kids, pikepdf.Array):
        kids = [kids]
    for kid in kids:
        if not isinstance(kid, pikepdf.Dictionary):
            continue
        s = kid.get("/S")
        if s is None:
            continue
        if str(s).lstrip("/") == "Figure":
            out.append(kid)
        collect_figures(kid, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    args = ap.parse_args()

    pdf = pikepdf.open(args.inp)
    root = pdf.Root
    if "/StructTreeRoot" not in root:
        json.dump({"alts": []}, sys.stdout)
        return

    figures = []
    collect_figures(root["/StructTreeRoot"], figures)

    alts = []
    for f in figures:
        alt = f.get("/Alt")
        actual_text = f.get("/ActualText")
        alts.append({
            "alt": str(alt) if alt is not None else "",
            "actualText": str(actual_text) if actual_text is not None else "",
        })

    json.dump({"alts": alts, "count": len(figures)}, sys.stdout)


if __name__ == "__main__":
    main()
