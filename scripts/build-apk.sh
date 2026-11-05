#!/bin/sh
# Build the Android installers.
#
# JAVA_HOME is honoured when set (CI sets it via setup-java); otherwise the
# JDK vendored under client/ is used. The previous script hardcoded an
# absolute path to one developer's machine, so it worked in exactly one place.
set -e

cd "$(dirname "$0")/.."

if [ -z "${JAVA_HOME:-}" ] && [ -d "client/jdk-21" ]; then
    JAVA_HOME="$(pwd)/client/jdk-21"
    export JAVA_HOME
fi

if [ -z "${JAVA_HOME:-}" ]; then
    echo "JAVA_HOME is not set and client/jdk-21 is not present." >&2
    echo "Install a JDK 21 or point JAVA_HOME at one." >&2
    exit 1
fi

echo "Using JAVA_HOME=$JAVA_HOME"

cd client
npx ng build --configuration mobile

# Angular's static build emits a redirect document for the empty route. Capacitor
# loads the root index file directly, so a redirect page would leave the WebView
# on "Redirecting to /watch" forever. Use the prerendered Watch shell as the SPA
# entry point; client-side routing then takes over.
if [ -f dist/client/browser/watch/index.html ]; then
    cp dist/client/browser/watch/index.html dist/client/browser/index.html
fi

npx cap sync android

cd android
./gradlew assembleMobileDebug assembleTvDebug --no-daemon

echo
echo "Installers:"
find app/build/outputs/apk -name 'app-*-debug.apk' -exec ls -lh {} \;
