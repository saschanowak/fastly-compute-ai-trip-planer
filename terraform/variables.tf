variable "domain_name" {
  description = "Domain name for the Fastly service. Set via TF_VAR_domain_name in .env."
  type        = string
  default     = "ai-trip-planer.edgecompute.app"
}
