#!/usr/bin/env python3
"""
Apply edited alt text from a manifest into a tagged PDF's structure tree.

Usage:
    apply_alt.py --in tagged.pdf --out tagged-alt.pdf --manifest alt.json

Manifest format (list, in document order):
    [{"id": "...", "path": "...", "alt": "...", "decorative": bool, "complex": bool}, ...]

Matches manifest entries to /Figure StructElems by document order (the same
order Adobe Extract uses), which is far more robust than matching the bracketed
struct-tree paths across the two tools.

Prints a JSON status report on stdout. Exits non-zero on hard failures.
"""
import argparse
import json
import sys

try:
    import pikepdf
except ImportError:
    json.dump(
        {"error": "pikepdf is not installed. Run: pip install pikepdf"},
        sys.stdout,
    )
    sys.exit(3)


def collect_figures(node, out):
    """Walk struct tree in document order, append each /Figure StructElem to out."""
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
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args()

    with open(args.manifest, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    pdf = pikepdf.open(args.inp, allow_overwriting_input=False)
    root = pdf.Root
    if "/StructTreeRoot" not in root:
        json.dump({"error": "PDF has no structure tree (not auto-tagged?)"}, sys.stdout)
        pdf.close()
        sys.exit(2)

    figures = []
    collect_figures(root["/StructTreeRoot"], figures)

    applied_alt = 0
    applied_decorative = 0
    skipped_overflow = 0

    for i, entry in enumerate(manifest):
        if i >= len(figures):
            skipped_overflow += 1
            continue
        elem = figures[i]
        if entry.get("decorative"):
            # Empty /Alt; downstream tools generally treat empty alt as decorative.
            # A fuller fix would re-mark the content stream as /Artifact and prune
            # the StructElem; that needs content-stream rewriting and is out of
            # scope for v1.
            elem["/Alt"] = pikepdf.String("")
            applied_decorative += 1
        else:
            alt = (entry.get("alt") or "").strip()
            if alt:
                elem["/Alt"] = pikepdf.String(alt)
                applied_alt += 1

    pdf.save(args.out)
    pdf.close()

    json.dump(
        {
            "pdf_figures": len(figures),
            "manifest_figures": len(manifest),
            "applied_alt": applied_alt,
            "applied_decorative": applied_decorative,
            "skipped_manifest_overflow": skipped_overflow,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
