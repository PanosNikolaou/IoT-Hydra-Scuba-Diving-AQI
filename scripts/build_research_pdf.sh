#!/usr/bin/env bash
# Build the SD-AQI paper to PDF using latexmk and shell-escape (Inkscape required for SVG figures)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR/research"

TEX=sd_aqi_paper.tex
OUT=sd_aqi_paper.pdf

echo "Building $TEX -> $OUT"

# Use latexmk for robust builds. Inkscape required for svg package to convert SVG to PDF.
if ! command -v latexmk >/dev/null 2>&1; then
  echo "latexmk not found. Install with your package manager (texlive) or use pdflatex and run inkscape manually." >&2
  exit 2
fi

latexmk -pdf -shell-escape -interaction=nonstopmode "$TEX"

if [ -f "$OUT" ]; then
  echo "Built $OUT in $(pwd)"
else
  echo "Build finished but $OUT not found" >&2
  exit 3
fi
