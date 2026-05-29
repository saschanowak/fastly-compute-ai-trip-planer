-include .env
export

TF_DIR := terraform

.PHONY: help setup build serve deploy log-tail \
        tf-init tf-plan tf-apply tf-destroy

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-30s\033[0m %s\n", $$1, $$2}'

build: ## Compile to WASM via Fastly CLI (runs cargo build --profile release)
	fastly compute build

serve: ## Run local WASM dev server at http://127.0.0.1:7676
	fastly compute serve

deploy: build ## Build and publish directly to Fastly via CLI (no Terraform)
	@SERVICE_ID=$$(terraform -chdir=$(TF_DIR) output -raw service_id); \
	fastly compute publish --service-id="$$SERVICE_ID"

log-tail: ## Tail live logs for the Fastly service
	@SERVICE_ID=$$(terraform -chdir=$(TF_DIR) output -raw service_id); \
	fastly log-tail --service-id="$$SERVICE_ID"

# -- Terraform --------------------------------------------------------------
tf-init: ## Initialise Terraform (run once)
	terraform -chdir=$(TF_DIR) init

tf-plan: ## Preview infrastructure changes
	terraform -chdir=$(TF_DIR) plan

tf-apply: build ## Build WASM then create/update Fastly infrastructure via Terraform
	terraform -chdir=$(TF_DIR) apply

tf-destroy: ## Destroy all Terraform-managed Fastly resources
	terraform -chdir=$(TF_DIR) destroy

seed-secret: ## Add GCP_API_KEY to the Fastly Secret Store (prompts for value)
	@STORE_ID=$$(terraform -chdir=$(TF_DIR) output -raw secret_store_id); \
	echo "$(GCP_API_KEY)" | fastly secret-store-entry create \
		--store-id="$$STORE_ID" \
		--name=GCP_API_KEY \
		--stdin \
		--recreate-allow; \
	echo "GCP_API_KEY added to store $$STORE_ID";
