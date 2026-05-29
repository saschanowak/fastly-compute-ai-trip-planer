terraform {
  required_providers {
    fastly = {
      source  = "fastly/fastly"
      version = ">= 9.2.0"
    }
  }
}

provider "fastly" {
  # api_key is read from the FASTLY_API_KEY environment variable
}

# ---------------------------------------------------------------------------
# Package hash — computed from the pre-built .tar.gz artifact
# ---------------------------------------------------------------------------
data "fastly_package_hash" "app" {
  filename = "${path.module}/../pkg/chatty-edge-trip-planer.tar.gz"
}

# ---------------------------------------------------------------------------
# Secret Store — edge secrets management / credential storage
# Stores credentials securely at the edge. After `terraform apply`, populate with:
#   fastly secret-store-entry create --store-id <id> --name GCP_API_KEY --secret <key>
# ---------------------------------------------------------------------------
resource "fastly_secretstore" "chatty_edge_trip_planer_secrets" {
  name = "chatty-edge-trip-planer-secrets"
}

# ---------------------------------------------------------------------------
# KV Store — persistent trip plan storage (90-day TTL per entry)
# ---------------------------------------------------------------------------
resource "fastly_kvstore" "trip_plans" {
  name = "trip-plans"
}

# ---------------------------------------------------------------------------
# Compute service — serverless edge computing / WebAssembly application
# ---------------------------------------------------------------------------
resource "fastly_service_compute" "chatty_edge_trip_planer" {
  name          = "Chatty Edge Trip Planer"
  comment       = "Managed by Terraform"
  activate      = true
  force_destroy = true

  domain {
    name    = var.domain_name
    comment = "Primary domain"
  }

  package {
    filename         = "${path.module}/../pkg/chatty-edge-trip-planer.tar.gz"
    source_code_hash = data.fastly_package_hash.app.hash
  }

  product_enablement {
    name                  = "products"
    api_discovery         = true
    domain_inspector      = false
    fanout                = false
    websockets            = false
    log_explorer_insights = true

    ddos_protection {
      enabled = true
      mode    = "log"
    }
    bot_management {
      enabled      = true
      contentguard = "on"
    }
  }

  # Backend: Open-Meteo Geocoding API (location coordinates)
  backend {
    name              = "open_meteo_geocoding"
    address           = "geocoding-api.open-meteo.com"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "geocoding-api.open-meteo.com"
    ssl_check_cert    = true
  }

  # Backend: Open-Meteo Weather API (forecast data)
  backend {
    name              = "open_meteo_api"
    address           = "api.open-meteo.com"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "api.open-meteo.com"
    ssl_check_cert    = true
  }

  # Backend: Wikimedia Commons (destination photos)
  backend {
    name              = "wikimedia"
    address           = "commons.wikimedia.org"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "commons.wikimedia.org"
    ssl_check_cert    = true
  }

  # Link Secret Store to the Compute service
  resource_link {
    name        = "chatty-edge-trip-planer-secrets"
    resource_id = fastly_secretstore.chatty_edge_trip_planer_secrets.id
  }

  # Link KV Store to the Compute service
  resource_link {
    name        = "trip-plans"
    resource_id = fastly_kvstore.trip_plans.id
  }
}
