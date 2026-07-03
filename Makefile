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

.PHONY: watch watch-fresh watch-once watch-tail

WATCH_INTERVAL ?= 60

watch:
	@WATCH_INTERVAL='$(WATCH_INTERVAL)' bash scripts/dev-watch.sh

watch-fresh:
	@rm -rf dev-fixtures/state
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
