install:
	pnpm install

setup-linux:
	bash scripts/setup-cli-linux.sh

setup-macos:
	bash scripts/setup-cli-macos-brew.sh

setup-python:
	bash scripts/setup-worker-python-venv.sh

setup-docker:
	docker build -f worker/Dockerfile .

dev:
	pnpm dev

dev-worker:
	pnpm --filter @docslurp/worker dev

build:
	pnpm build
