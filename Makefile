# Makefile for evolver developer tooling.
#
# The `watch*` targets iterate on scripts/bedrock-alias-watch.sh against
# a local Slack receiver, so you can see the Slack payload in real time
# as you edit dev-fixtures/aws.html.
#
# Usage:
#   make watch              # 60s loop (override: WATCH_INTERVAL=10 make watch)
#   make watch-fresh        # clear dev-fixtures/state, then watch
#   make watch-once         # run the watch script once, no loop
#   make watch-tail         # tail dev-fixtures/receiver.log (no watch loop)
#                           # useful when `make watch` is already running in
#                           # another terminal and you want a second window

# Resolve ROOT from the Makefile directory so `make watch-fresh`
# works from any cwd (e.g. `cd src/proxy && make -f ../../Makefile watch-fresh`).
# Without this, the rm would target the user's cwd and silently no-op if
# the contributor isn't at the repo root. See git log --grep="tooling"
# for the follow-up rationale.
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

.PHONY: watch watch-fresh watch-once watch-tail

WATCH_INTERVAL ?= 60

watch:
	@WATCH_INTERVAL='$(WATCH_INTERVAL)' bash scripts/dev-watch.sh

watch-fresh:
	@if [ "$(WATCH_CONFIRM)" != "1" ]; then \
	  echo "watch-fresh: would rm -rf $(ROOT)/dev-fixtures/state — confirm with: WATCH_CONFIRM=1 make watch-fresh"; \
	  exit 1; \
	fi
	@echo "watch-fresh: removing $(ROOT)/dev-fixtures/state (per WATCH_CONFIRM=1)"
	@rm -rf $(ROOT)/dev-fixtures/state
	@$(MAKE) watch

watch-once:
	@WATCH_INTERVAL=0 bash scripts/dev-watch.sh

watch-tail:
	@if [ ! -f dev-fixtures/receiver.log ]; then \
	  echo 'make watch-tail: dev-fixtures/receiver.log does not exist yet.'; \
	  echo 'Start the watch in another terminal first:'; \
	  echo '  make watch   # or make watch-once for a single run'; \
	  exit 1; \
	fi
	@tail -n 0 -F dev-fixtures/receiver.log
