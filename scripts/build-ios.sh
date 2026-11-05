#!/bin/sh
# Build the iOS simulator app locally.
#
# A simulator build needs no Apple Developer account or signing identity. For a
# device or App Store package, open client/ios/App/App.xcodeproj in Xcode, set
# the team, and archive (see docs/apple-platforms.md).
set -e

cd "$(dirname "$0")/.."

if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "Xcode is required: this script only runs on macOS." >&2
    exit 1
fi

sh scripts/build-mobile-web.sh

cd client
npx cap sync ios

cd ios/App
xcodebuild \
    -project App.xcodeproj \
    -scheme App \
    -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath ../../../scratch/ios-derived \
    CODE_SIGNING_ALLOWED=NO \
    build

echo
echo "Simulator app:"
find ../../../scratch/ios-derived/Build/Products -maxdepth 2 -name '*.app' -print
