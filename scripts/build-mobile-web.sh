#!/bin/sh
# Build the Angular bundle every native shell ships.
#
# Android, iOS and tvOS all need the same mobile build. Keeping the build and
# the SPA-entry fix in one script is what keeps them at parity: a flavour that
# skips the copy below boots to Angular's "Redirecting to /watch" document.
set -e

cd "$(dirname "$0")/../client"

npx ng build --configuration mobile

# Angular's static build emits a redirect document for the empty route.
# Capacitor and the tvOS shell load the root index directly, so a redirect page
# would leave the WebView on "Redirecting to /watch" forever. Use the
# prerendered Watch shell as the SPA entry point; client-side routing takes over.
if [ -f dist/client/browser/watch/index.html ]; then
    cp dist/client/browser/watch/index.html dist/client/browser/index.html
fi
