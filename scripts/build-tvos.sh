#!/bin/sh
# Build the Apple TV simulator app locally.
#
# tvOS has no public WebView, so this is a native SwiftUI client rather than a
# Capacitor shell. XcodeGen turns project.yml into the Xcode project; install it
# with `brew install xcodegen`.
set -e

cd "$(dirname "$0")/.."

if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "Xcode is required: this script only runs on macOS." >&2
    exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
    echo "xcodegen is required: brew install xcodegen" >&2
    exit 1
fi

cd client/tvos
xcodegen generate
xcodebuild \
    -project TunerDaemonTV.xcodeproj \
    -scheme TunerDaemonTV \
    -configuration Debug \
    -destination 'generic/platform=tvOS Simulator' \
    -derivedDataPath ../../scratch/tvos-derived \
    CODE_SIGNING_ALLOWED=NO \
    build

echo
echo "Simulator app:"
find ../../scratch/tvos-derived/Build/Products -maxdepth 2 -name '*.app' -print
