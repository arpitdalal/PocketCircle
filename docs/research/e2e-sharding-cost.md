# E2E sharding cost

Research date: 2026-08-14. Sources are first-party GitHub and Convex documentation.

## Conclusion

Sharding PocketCircle's E2E suite into two or three concurrent jobs costs **$0 in GitHub Actions compute and $0 from Convex under the current setup**.

- PocketCircle is currently a [public repository](https://github.com/arpitdalal/PocketCircle), and its [E2E workflow](../../.github/workflows/e2e.yml) uses the standard `ubuntu-latest` GitHub-hosted runner. Standard runners are free and unlimited for public repositories; larger runners are the paid exception. [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions#free-use-of-github-actions)
- Every shard would start `ghcr.io/get-convex/convex-backend` inside its own GitHub runner VM and address it at `127.0.0.1`. This is Convex's open-source, self-hosted backend, not a Convex Cloud deployment. Convex documents Docker as a supported self-hosting route and local SQLite as the default storage. [Convex self-hosting](https://docs.convex.dev/self-hosting), [official self-hosting guide](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md)
- Therefore two shards mean two ephemeral local backend containers; three shards mean three. They do **not** consume Convex Cloud deployment, compute, database, or bandwidth quotas, and no Convex paid plan is required. The compute is part of the GitHub runner already accounted for above. This conclusion follows from the workflow's self-hosted URL/admin-key path and Convex's separation of self-hosting from its hosted product. See also [ADR 0019](../adr/0019-e2e-against-self-hosted-convex-backend.md).

## GitHub billing details

For the current public repository:

- Two or three standard Linux jobs remain free. Free-plan standard-runner concurrency is 20 jobs; Pro is 40, Team 60, and Enterprise 500, so two or three shards fit even the lowest published limit. [Actions limits](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners)
- Sharding does increase aggregate runner work because install/backend setup repeats. From the measured baseline of about 1m16s setup plus 9m54s Playwright time, an ideal split models as:

| Layout | Approx. workflow wall time | Aggregate runner time | Rounded billable minutes if private |
| --- | ---: | ---: | ---: |
| 1 job | 11m13s | 11m13s | 12 |
| 2 shards | 6m13s | 12m26s (~11% more) | 14 |
| 3 shards | 4m34s, plus report merge | 13m42s (~22% more) | 15, plus merge job |

These are planning estimates, not guarantees; uneven shards, retries, and report merging change them. GitHub rounds each job's partial minute up independently. [Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)

If PocketCircle becomes private, those aggregate minutes matter:

- Included standard-runner minutes per month: GitHub Free 2,000; Pro 3,000; Free for organizations 2,000; Team 3,000; Enterprise Cloud 50,000. Usage above the owner account's quota is billed; without a payment method, Actions stops when the quota is exhausted. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions#free-use-of-github-actions)
- Current standard Linux x64 usage beyond quota is $0.006 per rounded job-minute. At the modeled totals, one/two/three shards would be roughly $0.072/$0.084/$0.090 per run beyond quota, excluding any report-merge job. [Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)

## Small non-compute caveats

- Each shard must use a unique Playwright artifact name. Uploading per-shard blobs plus a merged report can increase artifact storage. GitHub Free includes 500 MB of artifact storage, Pro 1 GB, Team 2 GB, and Enterprise Cloud 50 GB; this allowance is shared with GitHub Packages. Excess shared storage is currently $0.25/GB-month. Retain temporary shard blobs only as long as needed; the current final-report retention is seven days. [GitHub Actions storage billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions#how-storage-billing-works)
- Every shard pulls the Convex image separately, increasing download volume and possibly startup time. GitHub currently says Container registry image storage and bandwidth are free and promises at least one month's notice before changing that policy, so the `ghcr.io` pulls add no current charge. [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages#free-use-of-github-packages)

## Recommendation

Use three shards when wall-clock latency is the priority. The current workflow does so and should cut elapsed time to roughly 5–6 minutes. It stays free while the repository remains public on standard runners, and no Convex subscription or hosted backends are needed.
