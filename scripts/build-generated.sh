#!/usr/bin/env bash
# Build every generated sample project with ./gradlew build and record results.
# Usage: scripts/build-generated.sh <generated-dir> [jdk-root]
set -u
GEN=${1:-/workspace/ffn-generated}
JDKS=${2:-$HOME/jdks}
RESULTS="$GEN/build-results.txt"
: > "$RESULTS"
for dir in "$GEN"/*/; do
  name=$(basename "$dir")
  java=$(node -p "require('$dir/.ffn/project.json').profile.java")
  # Gradle itself must run on a JDK >= 17 that also satisfies the toolchain for Loom (which compiles with the running JDK).
  if [ "$java" -ge 21 ]; then runner="$JDKS/jdk$java"; else runner="$JDKS/jdk21"; fi
  start=$(date +%s)
  ( cd "$dir" && JAVA_HOME="$runner" ./gradlew build --no-daemon --stacktrace \
      -Porg.gradle.java.installations.paths="$JDKS/jdk17,$JDKS/jdk21,$JDKS/jdk25" \
      -Porg.gradle.java.installations.auto-download=false > build.log 2>&1 )
  code=$?
  echo "$name exit=$code time=$(( $(date +%s) - start ))s jars=$(ls "$dir"/build/libs 2>/dev/null | tr '\n' ' ')" | tee -a "$RESULTS"
done
