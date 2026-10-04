#!/usr/bin/env bash
# Builds the offline frontend, syncs it into the Capacitor Android project and
# assembles a debug APK:
#   mobile/android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")"

# ~/.bashrc returns early for non-interactive shells, so fall back to the
# user-space toolchain paths when the env vars aren't already exported.
export JAVA_HOME="${JAVA_HOME:-$HOME/android-toolchain/jdk-21.0.12.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-toolchain/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$PATH"

(cd frontend && VITE_LOCAL_ENGINE=1 npm run build)
(cd mobile && npx cap sync android)
echo "sdk.dir=$ANDROID_HOME" > mobile/android/local.properties
(cd mobile/android && ./gradlew assembleDebug)

echo "APK: mobile/android/app/build/outputs/apk/debug/app-debug.apk"
