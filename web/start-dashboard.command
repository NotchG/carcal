#!/bin/bash
# carcal dashboard - run on the Mac (next to REW). Double-click in Finder or run in Terminal.
# First time only:  npm install && npm run build
# REW must be running with its API on (Preferences > API, or launch with -api).
cd "$(dirname "$0")"
( sleep 3; open http://localhost:3000 ) &
npm run start
