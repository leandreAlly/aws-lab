# Lab 05 — Push a Docker image to Amazon ECR

The lab-04 todo application, containerized and published to a private Amazon ECR repository by GitHub Actions, authenticating with a short-lived OIDC token. No AWS access keys exist in GitHub, and the repository, the OIDC provider and the push role are all defined in CloudFormation and created by GitSync.

Lab 04 shipped *source*: a zip that Beanstalk unpacked onto an instance, which then installed Node and ran `npm ci` at deploy time. This lab ships the *machine*: Alpine, Node 22.22, the dependencies and the code are assembled once at build time and frozen into an artifact. The environment stops being something the server assembles on every deploy and becomes part of the thing being deployed.

## The task

- Containerize a Node.js or Java application with a minimal base image and container security best practices
- Include a `.dockerignore`
- Authenticate GitHub Actions to AWS with OIDC — an IAM role trusting GitHub's provider, restricted to this repository, least privilege for ECR push
- No AWS access keys in GitHub secrets
- A workflow that triggers on every push, builds the image, tags it `yourfullname_appname`, and pushes to a private ECR repository
- Bonus: ECR defined as IaC with tags, scanning and a repository policy; creation automated by CloudFormation GitSync; an architecture diagram

## Architecture

```
                              push to main
                                   │
                ┌──────────────────┴──────────────────────┐
     practice.yml / deployment.yaml            every push, no path filter
                │                                          │
     CloudFormation GitSync                  GitHub Actions · push-ecr.yml
     (eu-north-1)                                          │
                │                              npm ci && npm test
                │                                          │
     creates and owns:                         docker build  (multi-stage)
       · GitHub OIDC provider                              │
       · lab05-github-ecr-push (IAM role)      OIDC token ──┼──► sts:AssumeRoleWithWebIdentity
       · leandre-tuyambaze-todo-app (ECR)                   │    (session credentials, 1h max)
                │                              boot the image, assert /api/version
                │                                          │
                └──────────────────┬───────────────────────┘
                                   ▼
                  Amazon ECR · private · eu-north-1
                  149160850943.dkr.ecr.eu-north-1.amazonaws.com
                    leandre-tuyambaze-todo-app
                      :leandre_tuyambaze_todoapp              ← required tag, moves each build
                      :leandre_tuyambaze_todoapp-v<run>-<sha> ← unique, never reused
                  scan-on-push · AES256 · lifecycle policy · repository policy
                                   │
                                   ▼
                  consumers: ECS / App Runner / Lambda / docker pull
                  (none built in this lab — the image is stored, not run)
```

**Infrastructure is GitSync's job, images are Actions' job** — the same split as lab 04. What differs is the trigger: the Beanstalk workflow is path-filtered to its app directory, while this one deliberately has no `paths:` filter, because the rubric asks for a workflow that "triggers on every push to the repository". That is a knowing deviation from this repo's convention, and its cost is a Docker build on pushes that change nothing relevant.

## Components

| Piece | Resource | Note |
|---|---|---|
| Image registry | `leandre-tuyambaze-todo-app` | private, scan-on-push, AES256, `EmptyOnDelete` |
| CI identity | `lab05-github-ecr-push` | assumed via OIDC, no stored credentials |
| Federation | `token.actions.githubusercontent.com` | account-wide, one per URL — **this stack owns it** |
| Application | `lab-05/app` | Express + DynamoDB/in-memory store, from lab 04 |

## The image

```
FROM node:22.22-alpine3.22 AS deps      npm ci --omit=dev --ignore-scripts
FROM node:22.22-alpine3.22 AS runtime   dumb-init, non-root, HEALTHCHECK
```

- **Multi-stage**, so npm's cache and build-time state never reach the final layer
- **Alpine**, pinned to a patch version rather than floating on `node:22-alpine`
- **`--ignore-scripts`**, so a dependency's `postinstall` cannot execute during the build
- **Runs as `node` (uid 1000)**, never root
- **`dumb-init` as PID 1**, so `SIGTERM` reaches the app and a stop is graceful rather than a 10-second kill
- **Build metadata via `ARG`**, not a file — `VERSION_LABEL`, `COMMIT` and `BUILT_AT` become `build-info.json` inside the image, so `/api/version` reports which build it is

249 MB, of which ~165 MB is the Alpine Node base and most of the rest is the AWS SDK.

## Verifying it

The pipeline proves the image before pushing it: it boots the container, polls `/api/version`, and fails the run unless the app reports the exact label just built. That check sits *before* both `docker push` lines, so a broken image cannot reach ECR.

To pull and run the published artifact yourself:

```bash
aws ecr get-login-password --region eu-north-1 \
  | docker login --username AWS --password-stdin 149160850943.dkr.ecr.eu-north-1.amazonaws.com

docker pull 149160850943.dkr.ecr.eu-north-1.amazonaws.com/leandre-tuyambaze-todo-app:leandre_tuyambaze_todoapp

docker run -d --name todo --platform linux/amd64 -p 8080:8080 \
  149160850943.dkr.ecr.eu-north-1.amazonaws.com/leandre-tuyambaze-todo-app:leandre_tuyambaze_todoapp
```

`--platform linux/amd64` because the runner builds amd64 and an Apple Silicon Mac is arm64. `curl localhost:8080/api/version` reports the CI build label; the todo UI is on `/`.

## Where each requirement is met

| Requirement | Where |
|---|---|
| Dockerfile builds, minimal base image | `app/Dockerfile`, `node:22.22-alpine3.22`, multi-stage |
| `.dockerignore` present | `app/.dockerignore` — excludes `node_modules`, tests, `.git`, `.env*`, `*.pem` |
| Triggers on every push | `on: push` with no branch or path filter |
| Image builds and is tagged correctly | `leandre_tuyambaze_todoapp`, plus a unique per-build tag |
| Pushed to a private ECR repository | `AWS::ECR::Repository`, private by type |
| Official AWS GitHub Actions | `aws-actions/configure-aws-credentials@v4`, `aws-actions/amazon-ecr-login@v2` |
| Fails securely on error | tests gate the build; the image must serve its own version before any push; `set -eo pipefail` |
| GitHub OIDC for authentication | `AWS::IAM::OIDCProvider` + `sts:AssumeRoleWithWebIdentity` |
| Least-privilege IAM | only `ecr:GetAuthorizationToken` is on `*`; every other action is scoped to one repository ARN |
| No long-lived AWS secrets | GitHub holds a role ARN and a region — no keys |
| Bonus — IaC with tags, scanning, repo policy | `practice.yml` |
| Bonus — creation automated by GitSync | `deployment.yaml`, stack `lab-05-ecr` |
| Bonus — architecture diagram | above |

## Design decisions

- **The repository is `MUTABLE`, deliberately.** The rubric mandates a fixed tag, so every build rewrites `leandre_tuyambaze_todoapp`. Under `IMMUTABLE` the *second* push fails — immutability and a fixed tag are mutually exclusive. The traceability immutability exists for is recovered with a second tag, `leandre_tuyambaze_todoapp-v<run>-<attempt>-<sha>`, which is never reused. Both tags point at one digest.
- **The repository policy grants and never denies.** Within a single account an IAM allow is sufficient, so this policy documents intent rather than enforcing it — and crucially it cannot lock out a future ECS task execution role. An explicit `Deny` would have.
- **OIDC trust uses `StringLike` with `repo:leandreAlly/aws-lab:*`.** Looser than lab 04's branch-pinned `StringEquals`, and that is required here: the workflow triggers on every push to every branch, so pinning `refs/heads/main` would fail every feature branch. It still restricts to this one repository, which is what the lab asks. Lab 04's tighter form is the better default when a workflow only ever deploys from `main`.
- **The build role can push, and nothing else.** It cannot delete the repository, change its policy, or read any other repository. A compromised workflow can publish a bad image; it cannot dismantle the registry.
- **`EmptyOnDelete: true`.** ECR refuses to delete a repository containing images, which would block stack teardown after the first successful push.
- **Lifecycle policy over manual cleanup.** Untagged images expire after 7 days, and only the 10 most recent build tags are kept. Every build otherwise leaves a permanent 250 MB layer set behind.

## What broke / what to watch for

- **An `AccessDenied` from GitSync names one of two different roles, and they need different fixes.** Stack creation failed with `cloudformation-gitsync-role/AWSCloudFormation is not authorized to perform: ecr:CreateRepository`. That is the *execution* role — the identity CloudFormation assumes to build resources — not `leandre-cloud-01`, the sync role that talks to CloudFormation in the first place. Reading which role the denial names is the whole diagnosis. The fix was an inline policy scoped to `repository/*` rather than the literal repository name, so the next lab's repository doesn't repeat it.
- **CloudFormation does not validate that a federated principal exists.** The first pipeline run failed with `Could not assume role with OIDC: The web identity token provided could not be validated`. Everything upstream was green: the stack was `CREATE_COMPLETE`, the role existed, its trust policy was correct, and `describe-repositories` answered. The OIDC provider it trusted simply wasn't there — lab 04 had owned it, and tearing that stack down deleted it. **A role trusting a non-existent provider creates cleanly and fails only when a real token arrives**, and the error reads like a token or thumbprint problem rather than a missing resource. `aws iam list-open-id-connect-providers` returning `[]` is the answer; nothing else surfaces it. Fixed by setting `CreateOidcProvider: 'true'` so this stack owns the provider now.
- **Immutable tags and a mandated fixed tag cannot coexist.** Caught before deploying rather than after: `ImageTagMutability: IMMUTABLE` with a required tag of `leandre_tuyambaze_todoapp` would have passed the first build and failed every one after it, at push time, after the whole pipeline had already succeeded.
- **GitHub's default shell is `bash -e {0}` — without `pipefail`.** The health check `SERVING=$(curl -fsS .../api/version | jq -r .versionLabel) && break` broke out of its retry loop on the first attempt, 0.17 seconds after `docker run`, because curl failed but `jq` returned `0` printing `null`, so the pipeline's exit status was `jq`'s. The loop never retried and the version assertion failed against `null`. **Any `curl | jq` health check in a workflow is silently non-failing unless you opt in** — either `shell: bash` (which adds `-eo pipefail`) or an explicit `set -eo pipefail`. The earlier draft avoided this by accident, writing to a file with `curl -o` and running `jq` separately. Worth noting the pipeline was green for the wrong reason before it was red for the right one.
- **A local test can validate a shell CI doesn't use.** The bug above survived a local reproduction that passed, because the test script began with `set -eo pipefail` — testing the semantics I assumed instead of the ones the runner has.
- **`EmptyOnDelete` needs delete permissions at teardown, not at create.** `ecr:ListImages` and `ecr:BatchDeleteImage` are in the execution role's policy for a failure that hasn't happened yet: without them the stack creates and updates perfectly and only fails to *delete*, once images exist.
- **This stack owns the account's OIDC provider.** IAM allows exactly one provider per URL per account, so deleting `lab-05-ecr` deletes it and breaks GitHub Actions authentication for every other lab — including the planned Java/Beanstalk rewrite. Whichever lab is torn down last should be the one that owns it.
- **The first pipeline was 203 lines; it is now 91.** Feedback on lab 04 was that the CI was longer than it needed to be, and this repeated the habit: a hand-rolled 10-iteration scan-status poll where `aws ecr wait image-scan-complete` exists, a preflight check duplicating errors the actions already produce, a separate test job paying for a second checkout and runner, and a summary table. None of it was graded and none of it changed an outcome. What survived is what fails the build: the tests, and the assertion that the image serves its own version.

## Cost and teardown

The cheapest lab in this repo by a wide margin. ECR storage is $0.10/GB-month, so ~250 MB of image is about **2.5 cents a month**, and the lifecycle policy caps growth. Nothing here bills by the hour — no NAT gateway, no ALB, no instance.

Teardown is deleting the stack. `EmptyOnDelete: true` handles the images, provided the execution role kept `ecr:BatchDeleteImage`. Before deleting, re-read the OIDC provider warning above — this is the stack that owns it.

## Deliverables

- **GitHub repository** — https://github.com/leandreAlly/aws-lab (`lab-05/`, `.github/workflows/push-ecr.yml`)
- **Private ECR repository** — https://eu-north-1.console.aws.amazon.com/ecr/repositories/private/149160850943/leandre-tuyambaze-todo-app?region=eu-north-1

## Screenshots

*(added after the live deployment)*
