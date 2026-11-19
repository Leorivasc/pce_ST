#!/usr/bin/env bash
browserify index.js \
  --ignore-missing \
  --standalone=PCEJSUtil \
  > pcejs-util.umd.js