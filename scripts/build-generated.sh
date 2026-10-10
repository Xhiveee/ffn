#!/usr/bin/env bash
# Build generated sample projects with ./gradlew build and record results.
# Usage: JDKS=$HOME/jdks scripts/build-generated.sh <project-dir>...
# Expects JDKs at $JDKS/jdk17, $JDKS/jdk21, $JDKS/jdk25.
set -u
JDKS=${JDKS:-$HOME/jdks}
for dir in "$@"; do
  dir=${dir%/}
  name=$(basename "$dir")
  # JDK that must run Gradle (>= mod target, >= plugin requirement such as Loom's Java 25).
  jvm=$(node -p "require('$dir/.ffn/project.json').profile.gradleJvm")
  if [ "$jvm" -le 21 ]; then runner="$JDKS/jdk21"; else runner="$JDKS/jdk$jvm"; fi
  start=$(date +%s)
  ( cd "$dir" && JAVA_HOME="$runner" ./gradlew build --no-daemon --stacktrace \
      -Porg.gradle.java.installations.paths="$JDKS/jdk17,$JDKS/jdk21,$JDKS/jdk25" \
      -Porg.gradle.java.installations.auto-download=false > build.log 2>&1 )
  code=$?
  echo "$name exit=$code time=$(( $(date +%s) - start ))s jars=$(ls "$dir"/build/libs 2>/dev/null | tr '\n' ' ')"
done
