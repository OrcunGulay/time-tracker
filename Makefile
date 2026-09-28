# Zaman Takip Platformu - gelistirici komutlari
SHELL := /bin/bash
.PHONY: help install infra migrate seed backend-dev dashboard-dev agent-venv agent-check \
        test typecheck build check clean

help: ## Komut listesi
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Tüm bağımlılıkları kur (backend + dashboard)
	cd backend && npm install
	cd dashboard && npm install

infra: ## MinIO (S3) ve opsiyonel Postgres container'larını başlat
	docker compose up -d

migrate: ## Veritabanı şemasını uygula
	cd backend && npm run migrate

seed: ## Temel kayıtlar (admin + ekip + projeler)
	cd backend && npm run seed

seed-demo: ## Temel kayıtlar + son 3 gün için demo aktivite verisi
	cd backend && npm run seed -- --demo

backend-dev: ## Backend geliştirme sunucusu (http://localhost:4000)
	cd backend && npm run dev

dashboard-dev: ## Dashboard geliştirme sunucusu (http://localhost:3000)
	cd dashboard && npm run dev

agent-venv: ## Agent için sanal ortam ve bağımlılıklar
	cd agent && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

agent-check: ## Agent ortam tanılaması (izinler, ekran yakalama, sunucu)
	cd agent && .venv/bin/python -m tt_agent --check

test: ## Backend + agent testleri
	cd backend && npm test
	cd agent && python3 -m unittest discover -s tests -t .

typecheck: ## TypeScript tip kontrolü (backend + dashboard)
	cd backend && npm run typecheck
	cd dashboard && npm run typecheck

build: ## Backend derleme + dashboard üretim derlemesi
	cd backend && npm run build
	cd dashboard && npm run build

check: typecheck test build ## Tüm doğrulamalar

clean: ## Derleme çıktılarını temizle
	rm -rf backend/dist dashboard/.next
