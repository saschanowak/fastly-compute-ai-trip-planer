output "service_id" {
  description = "Fastly service ID — update service_id in fastly.toml after first apply."
  value       = fastly_service_compute.chatty_edge_trip_planer.id
}

output "service_active_version" {
  description = "Currently active service version number."
  value       = fastly_service_compute.chatty_edge_trip_planer.active_version
}

output "secret_store_id" {
  description = "Fastly Secret Store ID — used by `make seed-secret`."
  value       = fastly_secretstore.chatty_edge_trip_planer_secrets.id
}
