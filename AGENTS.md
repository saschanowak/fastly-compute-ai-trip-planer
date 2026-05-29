# AGENTS.md - Fastly Demo Engineering Guide

## Mission & Objective

Your primary objective is to rapidly build, deploy, and document functional examples of how to use Fastly effectively.

The core KPI is to ship **one new, functional Fastly demo or use-case implementation per day**.

Every demo must simultaneously teach two concepts:

1. The generic industry problem being solved, using terms a non-Fastly searcher would use.
2. The Fastly-native implementation, using accurate Fastly product names, commands, and workflows.

---

## Operating Posture for AI Agents

* **High Autonomy:** Pick a practical path and ship a working demo rather than waiting for ideal requirements.
* **Organic Diversity (CRITICAL):** Do not make these repositories look like uniform corporate sales pitches. Vary your
  documentation style, file organization (where practical), and tone. Some repos should be highly technical and terse;
  others can be more narrative or tutorial-based.
* **Scrappy but Complete:** Prefer a small complete example over a large incomplete framework.
* **Safety First:** Use public-safe sample data only. Never include customer names, internal account details, real
  credentials, or private architecture claims. Fail closed for security controls.
* **Factual Accuracy:** Treat official Fastly documentation as the source of truth for limits and features. Do not
  invent pricing or performance claims.

---

## The Dual-Terminology Rule (CRITICAL)

For every README, docs page, and significant code comment, you must pair Fastly-specific terminology with generic
industry terminology. This bridges the gap for developers searching for architectural patterns.

### Vocabulary Map

| Fastly Term                 | Generic / Industry Terms to Include                                       |
|:----------------------------|:--------------------------------------------------------------------------|
| **Fastly Compute**          | serverless edge computing, edge functions, WebAssembly application        |
| **Fastly VCL**              | edge logic, CDN rule language, request processing pipeline                |
| **KV Store**                | edge key-value database, distributed durable key-value data               |
| **Config Store**            | edge configuration store, feature flag store, redirect table              |
| **Secret Store**            | edge secrets management, credential storage                               |
| **Next-Gen WAF**            | web application firewall, WAAP, API protection                            |
| **Edge Rate Limiting**      | API throttling, abuse prevention, quota enforcement                       |
| **DDoS Protection**         | Denial of Service, resilience, scalable, automatic, intelligent, adaptive |
| **Bot Management**          | bot detection, scraper mitigation, credential stuffing defense            |
| **Surrogate Key**           | cache tag, content tag, grouped invalidation key                          |
| **Log Tailing / Streaming** | live debugging, observability pipeline, SIEM integration                  |

---

## Available Tooling: The Agent Toolkit

You have access to the [Fastly Agent Toolkit](https://github.com/fastly/fastly-agent-toolkit). You must prioritize using
these pre-built skills for platform interactions (provisioning, configuring, checking status) rather than writing custom
API wrappers.

If a skill does not exist for a specific edge-case, fall back to the Fastly CLI or Terraform, but always check the
toolkit first.

---

## Definition of Done

A demo is not complete until all of the following are true:

* **Runnable Code:** Contains a working Fastly implementation (VCL, Compute, Terraform, Fastly CLI, API).
* **Documentation:** Includes a clear `README.md` using both Fastly and generic terminology.
* **Validation:** Includes at least one copy-pasteable smoke test using `curl` or a documented flow.
* **No Secrets:** Includes `.env.example`. Avoids committing secrets, tokens, or account IDs.
* **Lifecycle Paths:** Documents a local path (where possible), a deployed path, and a teardown/cleanup section.

---

## Required README.md Elements (Organic Presentation)

Do not use a single, rigid template for your `README.md` files. To ensure the repositories look organic and diverse, *
*shuffle the order, vary the heading names, and change the formatting style** from project to project.

However, every `README.md` **must contain** the following core components in some form:

* **Problem Statement:** Explain the problem in generic terms (e.g., API rate limiting, bot mitigation, LLM semantic
  caching).
* **The Fastly Solution:** Explain the Fastly-specific fit (e.g., global edge network, Next-Gen WAF, KV Store).
* **Architecture / Request Flow:** Include a text diagram or explain the flow between the client, edge, services, and
  origin. Map Fastly products to the generic capabilities they provide.
* **Prerequisites:** List account requirements, CLI/tooling, language runtimes, and origin requirements.
* **Deployment Instructions:** Step-by-step deployment using Fastly CLI, Terraform, or the Fastly Agent Toolkit. Include
  the fastest local or simulated path if applicable.
* **Validation / Smoke Test:** Commands that prove the behavior works, such as `curl` examples with expected headers or
  status codes.
* **Production Considerations:** Discuss secrets, origin protection, TLS, cache keys, or limits.
* **Teardown / Cleanup:** Explain how to remove services, stores, and resources to prevent ongoing billing.

