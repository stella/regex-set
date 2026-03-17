#!/bin/bash
# Download benchmark corpora.
#
# mariomka/regex-benchmark: programming tutorials
# rust-leipzig/regex-performance: Mark Twain corpus
# Canterbury Large Corpus: bible.txt
#
set -euo pipefail
cd "$(dirname "$0")/corpus"

echo "=== mariomka input-text.txt ==="
if [ ! -f input-text.txt ]; then
  curl -sLO \
    "https://raw.githubusercontent.com/mariomka/regex-benchmark/master/input-text.txt"
  echo "Done: $(wc -c < input-text.txt) bytes"
else
  echo "Already present, skipping."
fi

echo ""
echo "=== rust-leipzig 3200.txt ==="
if [ ! -f 3200.txt ]; then
  curl -sLO \
    "https://raw.githubusercontent.com/rust-leipzig/regex-performance/master/3200.txt"
  echo "Done: $(wc -c < 3200.txt) bytes"
else
  echo "Already present, skipping."
fi

echo ""
echo "=== Canterbury bible.txt ==="
if [ ! -f bible.txt ]; then
  curl -Lo large.zip \
    "https://corpus.canterbury.ac.nz/resources/large.zip"
  unzip -o large.zip bible.txt
  rm -f large.zip E.coli world192.txt
  echo "Done: $(wc -c < bible.txt) bytes"
else
  echo "Already present, skipping."
fi

echo ""
echo "All corpora ready."
