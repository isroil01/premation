#!/usr/bin/env bash
# Renders the Lemon Squeezy product image from product-image.html.
# Run from this folder. Needs Chrome and a sibling ~/dev/premation-library.
set -euo pipefail

LIB="$HOME/dev/premation-library/templates/pack"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
HERE="$(pwd -W)"

mkdir -p posters
for name in chrome-horizon festival-poster aurora-title bento-feature-reel liquid-glass-app swiss-grid-opener \
  editorial-split pulse-dashboard drop-story product-spotlight grain-orb-sting data-story maison-slideshow \
  podcast-audiogram polaroid-stack launch-story testimonial-card trailer-title editorial-quote; do
  cp "$LIB/pro.template.$name/poster.webp" "posters/$name.webp"
done
cp "$HOME/dev/premation-deepglow/listing/1-cover.jpg" posters/deep-glow.jpg
cp "$HOME/OneDrive/Desktop/motion-landing/public/logo-shape-cropped.png" brand-mark.png

shot() { # size width height file
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor=1 --virtual-time-budget=6000 \
    --window-size="$2,$3" --screenshot="$HERE/$4" "file:///$HERE/product-image.html?size=$1"
}

shot landscape 1600 1200 premation-cloud-1600x1200.png
shot square 1200 1200 premation-cloud-1200x1200.png

# The inputs are only needed to render; paid posters do not belong in this repo.
rm -rf posters brand-mark.png
