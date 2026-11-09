APP := augur-app
DS  := augur-datasource
VERSION ?= $(shell node -p "require('./$(APP)/package.json').version")

.PHONY: install test lint build build-frontend build-backend package clean

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

build-frontend:
	cd $(APP) && npm run build
	cd $(DS) && npm run build

build-backend:
	cd $(DS) && mage -v buildAll

build: build-frontend build-backend

# Zips in the layout Grafana expects: <plugin-id>/... at the archive root.
package: build
	rm -rf release && mkdir -p release
	rm -rf release/tmp && mkdir -p release/tmp
	cp -r $(APP)/dist release/tmp/augur-assistant-app
	cp -r $(DS)/dist release/tmp/augur-claude-datasource
	find release/tmp -name '*.map' -delete
	cd release/tmp && zip -qr ../augur-assistant-app-$(VERSION).zip augur-assistant-app
	cd release/tmp && zip -qr ../augur-claude-datasource-$(VERSION).zip augur-claude-datasource
	rm -rf release/tmp
	cd release && sha256sum *.zip > SHA256SUMS

clean:
	rm -rf $(APP)/dist $(DS)/dist release
