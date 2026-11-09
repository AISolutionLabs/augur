APP := augur-app
DS  := augur-datasource
VERSION ?= $(shell node -p "require('./$(APP)/package.json').version")

.PHONY: install test lint compat build build-frontend build-backend package zip version clean

install:
	cd $(APP) && npm ci
	cd $(DS) && npm ci

test:
	cd $(APP) && npx jest --ci
	cd $(DS) && npx jest --ci --passWithNoTests
	cd $(DS) && go test ./...

lint:
	cd $(APP) && npx tsc --noEmit && npx eslint src
	cd $(DS) && npx tsc --noEmit && npx eslint src
	cd $(DS) && go vet ./...

compat:
	scripts/check-grafana12.sh

build-frontend:
	cd $(APP) && npm run build
	cd $(DS) && npm run build

build-backend:
	cd $(DS) && mage -v buildAll

build: build-frontend build-backend

# Zips in the layout Grafana expects: <plugin-id>/... at the archive root.
package: build zip

# Zips whatever is already in */dist (used by CI after signing).
zip:
	rm -rf release && mkdir -p release/tmp
	cp -r $(APP)/dist release/tmp/augur-assistant-app
	cp -r $(DS)/dist release/tmp/augur-claude-datasource
	find release/tmp -name '*.map' -delete
	cd release/tmp && zip -qr ../augur-assistant-app-$(VERSION).zip augur-assistant-app
	cd release/tmp && zip -qr ../augur-claude-datasource-$(VERSION).zip augur-claude-datasource
	rm -rf release/tmp
	cd release && sha256sum *.zip > SHA256SUMS

# Sets both plugins to VERSION (e.g. make version VERSION=1.2.0).
version:
	scripts/set-version.sh $(VERSION)

clean:
	rm -rf $(APP)/dist $(DS)/dist release
